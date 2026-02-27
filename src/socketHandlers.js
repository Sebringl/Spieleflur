// Socket.IO Handler-Registrierung: Alle Events für Lobby und Spiele.
import { normalizeCode, makeToken, rollDie } from "./utils.js";
import {
  safeRoom, getLobbyList, pendingSummary, markLobbyActivity,
  updateRoomSettings, removePlayerFromRoom,
  createRoom, tryReconnectByName, cleanupEmptyLobbies
} from "./roomManager.js";
import { startNewGame, canAct, getSeatIndexBySocket } from "./games/index.js";
import {
  resetTurn, nextPlayer, rateRoll, applyManualSixRule,
  activeOrder, seatToOrderPos, setCurrentFromOrder
} from "./games/schocken.js";
import { KNIFFEL_CATEGORIES, resetKniffelTurn, scoreKniffel } from "./games/kniffel.js";
import {
  endSchwimmenTurn, startSchwimmenNextRound, handleSchwimmenFeuer,
  refreshSchwimmenTable, getActiveSchwimmenSeats
} from "./games/schwimmen.js";
import {
  SKAT_BID_VALUES, isSkatTrump, getSkatLeadSuit,
  determineSkatTrickWinner, getSkatCardPoints, calculateSkatGameValue,
  advanceSkatBidding, concludeSkatBidding
} from "./games/skat.js";
import {
  KWYX_ROWS, ensureKwyxTurnState, resetKwyxTurnState, clearKwyxCountdown,
  shouldFinishKwyxGame, canMarkKwyxRow, updateKwyxTotals, getKwyxRowIndex
} from "./games/kwyx.js";
import {
  canPlaceShip, placeShip, removeShip, recordShot, isGameOver, getWinnerIndex
} from "./games/schiffeversenken.js";

// ---- Hilfsfunktionen ----

function emitLobbyList(io, rooms) {
  io.emit("lobby_list", { lobbies: getLobbyList(rooms) });
}

function emitPendingRequests(io, room) {
  const host = room.players[room.hostSeat];
  if (host?.socketId) {
    io.to(host.socketId).emit("join_requests_update", {
      code: room.code,
      requests: pendingSummary(room)
    });
  }
}

function getSocketRoom(socket, rooms) {
  const code = normalizeCode(socket.data?.roomCode);
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) { socket.data.roomCode = null; return null; }
  return room;
}

function blockIfAlreadyInRoom(socket, rooms) {
  if (getSocketRoom(socket, rooms)) {
    socket.emit("error_msg", { message: "Du bist bereits in einer Lobby. Bitte wieder beitreten." });
    return true;
  }
  return false;
}

function handleJoinRequest(socket, io, rooms, persistFn, { code, name }) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return socket.emit("error_msg", { message: "Room-Code nicht gefunden." });
  if (room.status !== "lobby") return socket.emit("error_msg", { message: "Spiel läuft bereits." });

  const cleanName = String(name || "").trim() || "Spieler";
  if (room.players.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
    return socket.emit("error_msg", { message: "Name ist schon vergeben. Bitte anderen Namen wählen." });
  }
  if ((room.pendingRequests || []).some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
    return socket.emit("error_msg", { message: "Es gibt bereits eine Anfrage mit diesem Namen." });
  }

  if (!room.pendingRequests) room.pendingRequests = [];
  room.pendingRequests = room.pendingRequests.filter(req => req.socketId !== socket.id);
  const request = {
    id: makeToken(),
    name: cleanName,
    socketId: socket.id,
    requestedAt: Date.now()
  };
  room.pendingRequests.push(request);
  socket.emit("join_pending", { code: room.code });

  const host = room.players[room.hostSeat];
  if (host?.socketId) {
    io.to(host.socketId).emit("join_request_notice", {
      name: cleanName, code: room.code, requestId: request.id
    });
  }
  emitPendingRequests(io, room);
}

function finalizeKwyxTurn(io, room, persistFn) {
  const state = room.state;
  if (!state || state.gameType !== "kwyx" || state.finished) return;
  clearKwyxCountdown(room, state);

  if (state.kwyxPendingFinish && shouldFinishKwyxGame(state)) {
    state.finished = true;
    const maxScore = Math.max(...state.totals);
    const winners = state.players.filter((_, i) => state.totals[i] === maxScore);
    state.message = `Kwyx beendet. Gewinner: ${winners.join(", ")} (${maxScore} Punkte).`;
    io.to(room.code).emit("state_update", state);
    persistFn();
    return;
  }

  state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
  state.throwCount = 0;
  state.dice = [null, null, null, null, null, null];
  resetKwyxTurnState(state);
  io.to(room.code).emit("state_update", state);
  persistFn();
}

// ---- Handler-Registrierung ----

export function registerSocketHandlers(io, rooms, persistFn) {
  const persist = () => persistFn(rooms);
  const lobbyList = () => emitLobbyList(io, rooms);

  io.on("connection", (socket) => {
    socket.emit("lobby_list", { lobbies: getLobbyList(rooms) });

    socket.on("get_lobby_list", () => {
      socket.emit("lobby_list", { lobbies: getLobbyList(rooms) });
    });

    socket.on("create_room", ({ name, useDeckel, kniffelHandBonus, gameType, requestedCode }) => {
      if (blockIfAlreadyInRoom(socket, rooms)) return;
      const cleanName = String(name || "").trim() || "Spieler";
      const result = createRoom({ socket, rooms, name: cleanName, useDeckel, kniffelHandBonus, gameType, requestedCode, persistFn: persist });
      if (!result) return;
      const { room } = result;
      io.to(room.code).emit("room_update", safeRoom(room));
      emitPendingRequests(io, room);
      lobbyList();
    });

    socket.on("request_join", ({ code, name }) => {
      handleJoinRequest(socket, io, rooms, persist, { code, name });
    });

    socket.on("enter_room", ({ name, requestedCode, useDeckel, kniffelHandBonus, gameType }) => {
      if (blockIfAlreadyInRoom(socket, rooms)) return;
      const cleanName = String(name || "").trim() || "Spieler";
      const normalized = normalizeCode(requestedCode);
      if (normalized) {
        const room = rooms.get(normalized);
        if (room) {
          if (tryReconnectByName({
            room, socket, name: cleanName,
            persistFn: persist, io,
            emitLobbyList: lobbyList,
            emitPendingRequests: (r) => emitPendingRequests(io, r)
          })) return;
          return handleJoinRequest(socket, io, rooms, persist, { code: normalized, name: cleanName });
        }
      }
      const result = createRoom({ socket, rooms, name: cleanName, useDeckel, kniffelHandBonus, gameType, requestedCode: normalized, persistFn: persist });
      if (!result) return;
      const { room } = result;
      io.to(room.code).emit("room_update", safeRoom(room));
      emitPendingRequests(io, room);
      lobbyList();
    });

    socket.on("approve_join", ({ code, token, requestId, accept }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) return;
      if (room.hostToken !== token) return socket.emit("error_msg", { message: "Nur der Host kann Beitritte bestätigen." });
      if (!room.pendingRequests) room.pendingRequests = [];

      const idx = room.pendingRequests.findIndex(req => req.id === requestId);
      if (idx < 0) return socket.emit("error_msg", { message: "Anfrage nicht gefunden." });

      const request = room.pendingRequests[idx];
      room.pendingRequests.splice(idx, 1);
      const targetSocket = io.sockets.sockets.get(request.socketId);

      if (!accept) {
        if (targetSocket) targetSocket.emit("join_denied", { message: "Host hat den Beitritt abgelehnt." });
        emitPendingRequests(io, room);
        return;
      }
      if (room.status !== "lobby") {
        if (targetSocket) targetSocket.emit("join_denied", { message: "Spiel läuft bereits." });
        emitPendingRequests(io, room);
        return;
      }
      if (room.players.some(p => p.name.toLowerCase() === request.name.toLowerCase())) {
        if (targetSocket) targetSocket.emit("join_denied", { message: "Name ist schon vergeben." });
        emitPendingRequests(io, room);
        return;
      }
      if (!targetSocket) {
        socket.emit("error_msg", { message: "Spieler ist nicht mehr verbunden." });
        emitPendingRequests(io, room);
        return;
      }

      const newToken = makeToken();
      const seatIndex = room.players.length;
      room.players.push({ token: newToken, socketId: request.socketId, name: request.name, connected: true });
      markLobbyActivity(room);
      targetSocket.join(room.code);
      targetSocket.data.roomCode = room.code;
      targetSocket.emit("room_joined", {
        code: room.code, token: newToken, seatIndex,
        name: request.name, isHost: false, room: safeRoom(room), state: room.state
      });
      io.to(room.code).emit("room_update", safeRoom(room));
      emitPendingRequests(io, room);
      lobbyList();
      persist();
    });

    socket.on("join_room", ({ code, name }) => {
      handleJoinRequest(socket, io, rooms, persist, { code, name });
    });

    socket.on("rejoin_room", ({ code, token }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) return socket.emit("error_msg", { message: "Room-Code nicht gefunden." });
      const seatIndex = room.players.findIndex(p => p.token === token);
      if (seatIndex < 0) return socket.emit("error_msg", { message: "Rejoin fehlgeschlagen (Token unbekannt)." });

      const player = room.players[seatIndex];
      player.socketId = socket.id;
      player.connected = true;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.emit("room_joined", {
        code: room.code, token, seatIndex,
        name: player.name, isHost: token === room.hostToken,
        room: safeRoom(room), state: room.state
      });
      io.to(room.code).emit("room_update", safeRoom(room));
      if (room.state) io.to(room.code).emit("state_update", room.state);
      if (token === room.hostToken) emitPendingRequests(io, room);
      persist();
    });

    socket.on("start_game", ({ code, token }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) return;
      if (room.hostToken !== token) return socket.emit("error_msg", { message: "Nur der Host kann starten." });
      if (room.settings.gameType === "skat" && room.players.length !== 3) {
        return socket.emit("error_msg", { message: "Skat benötigt genau 3 Spieler." });
      }
      if (room.settings.gameType === "schiffeversenken" && room.players.length !== 2) {
        return socket.emit("error_msg", { message: "Schiffe versenken benötigt genau 2 Spieler." });
      }
      if (room.players.length < 2 && room.settings.gameType !== "kniffel") return socket.emit("error_msg", { message: "Mindestens 2 Spieler nötig." });
      startNewGame(room);
      room.lobbyWarnedAt = null;
      io.to(room.code).emit("room_update", safeRoom(room));
      io.to(room.code).emit("state_update", room.state);
      lobbyList();
      persist();
    });

    socket.on("update_room_settings", ({ code, token, useDeckel, kniffelHandBonus, gameType }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) return;
      if (room.hostToken !== token) return socket.emit("error_msg", { message: "Nur der Host kann Einstellungen ändern." });
      if (room.status !== "lobby") return socket.emit("error_msg", { message: "Spiel läuft bereits." });
      updateRoomSettings({ room, useDeckel, kniffelHandBonus, gameType });
      io.to(room.code).emit("room_update", safeRoom(room));
      lobbyList();
      persist();
    });

    // ---- Skat ----

    socket.on("skat_bid", ({ code, value }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "skat" || state.phase !== "bidding" || state.finished) {
        return socket.emit("error_msg", { message: "Aktion nicht möglich." });
      }
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const bidding = state.bidding;
      if (!bidding || bidding.waitingFor !== "bidder") return socket.emit("error_msg", { message: "Du bist nicht am Reizen." });
      if (state.currentPlayer !== bidding.bidder) return socket.emit("error_msg", { message: "Du bist nicht der Reizende." });
      const bidValue = Number(value);
      const bidIndex = SKAT_BID_VALUES.indexOf(bidValue);
      if (bidIndex < 0) return socket.emit("error_msg", { message: "Ungültiger Reizwert." });
      if (bidIndex <= bidding.currentBidIndex) return socket.emit("error_msg", { message: "Der Reizwert muss höher sein." });
      bidding.pendingBidIndex = bidIndex;
      bidding.waitingFor = "listener";
      state.currentPlayer = bidding.listener;
      state.message = `${state.players[bidding.bidder]} reizt ${bidValue}.`;
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("skat_hold", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "skat" || state.phase !== "bidding" || state.finished) return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const bidding = state.bidding;
      if (!bidding || bidding.waitingFor !== "listener") return socket.emit("error_msg", { message: "Du kannst gerade nicht halten." });
      if (state.currentPlayer !== bidding.listener) return socket.emit("error_msg", { message: "Du bist nicht der Antwortende." });
      if (bidding.pendingBidIndex === null) return socket.emit("error_msg", { message: "Kein Reizwert offen." });
      bidding.currentBidIndex = bidding.pendingBidIndex;
      bidding.highestBidIndex = bidding.pendingBidIndex;
      bidding.highestBidder = bidding.bidder;
      bidding.pendingBidIndex = null;
      bidding.waitingFor = "bidder";
      state.currentPlayer = bidding.bidder;
      state.message = `${state.players[bidding.listener]} hält ${SKAT_BID_VALUES[bidding.currentBidIndex]}.`;
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("skat_pass", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "skat" || state.phase !== "bidding" || state.finished) return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const bidding = state.bidding;
      if (!bidding) return;
      const actor = state.currentPlayer;
      if (bidding.waitingFor === "listener" && actor !== bidding.listener) return socket.emit("error_msg", { message: "Du kannst gerade nicht passen." });
      if (bidding.waitingFor === "bidder" && actor !== bidding.bidder) return socket.emit("error_msg", { message: "Du kannst gerade nicht passen." });
      bidding.passed[actor] = true;
      if (bidding.waitingFor === "listener") {
        bidding.currentBidIndex = bidding.pendingBidIndex ?? bidding.currentBidIndex;
        bidding.highestBidIndex = bidding.currentBidIndex;
        bidding.highestBidder = bidding.bidder;
        bidding.pendingBidIndex = null;
      } else {
        if (bidding.currentBidIndex < 0) { bidding.highestBidIndex = -1; bidding.highestBidder = null; }
        else { bidding.highestBidIndex = bidding.currentBidIndex; bidding.highestBidder = bidding.listener; }
      }
      state.message = `${state.players[actor]} passt.`;
      advanceSkatBidding(state);
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("skat_take_skat", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "skat" || state.phase !== "skat" || state.declarer === null) return;
      if (state.skatTaken) return socket.emit("error_msg", { message: "Skat wurde bereits aufgenommen." });
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      if (state.currentPlayer !== state.declarer) return socket.emit("error_msg", { message: "Nur der Alleinspieler darf den Skat nehmen." });
      state.hands[state.declarer] = state.hands[state.declarer].concat(state.skat);
      state.skat = [];
      state.skatTaken = true;
      state.message = `${state.players[state.declarer]} nimmt den Skat und legt ab.`;
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("skat_discard", ({ code, cards }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "skat" || state.phase !== "skat") return;
      if (!state.skatTaken) return socket.emit("error_msg", { message: "Skat wurde noch nicht aufgenommen." });
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      if (state.currentPlayer !== state.declarer) return socket.emit("error_msg", { message: "Nur der Alleinspieler darf abwerfen." });
      const discardCards = Array.isArray(cards) ? cards : [];
      if (discardCards.length !== 2) return socket.emit("error_msg", { message: "Du musst genau zwei Karten abwerfen." });
      const hand = state.hands[state.declarer] || [];
      const removed = [];
      discardCards.forEach(card => {
        const index = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
        if (index >= 0) removed.push(hand.splice(index, 1)[0]);
      });
      if (removed.length !== 2) return socket.emit("error_msg", { message: "Abwurfkarten nicht gefunden." });
      state.skatPile = removed;
      state.discarded = true;
      state.message = `${state.players[state.declarer]} hat abgeworfen und wählt das Spiel.`;
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("skat_choose_game", ({ code, type, suit, hand }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "skat" || state.phase !== "skat" || state.declarer === null) return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      if (state.currentPlayer !== state.declarer) return socket.emit("error_msg", { message: "Nur der Alleinspieler darf das Spiel wählen." });
      const gameType = String(type || "").toLowerCase();
      const wantsHand = Boolean(hand);
      if (wantsHand && state.skatTaken) return socket.emit("error_msg", { message: "Handspiel ohne Skataufnahme." });
      if (!wantsHand && state.skatTaken && !state.discarded) return socket.emit("error_msg", { message: "Bitte zuerst zwei Karten abwerfen." });
      if (gameType === "suit") {
        if (!["♣", "♠", "♥", "♦"].includes(suit)) return socket.emit("error_msg", { message: "Ungültige Trumpffarbe." });
      } else if (gameType !== "grand" && gameType !== "null") {
        return socket.emit("error_msg", { message: "Ungültige Spielart." });
      }
      const game = { type: gameType, suit: gameType === "suit" ? suit : null, hand: wantsHand, ouvert: false };
      const matadorCards = state.hands[state.declarer].concat(state.skatTaken ? state.skatPile : []);
      const baseValue = calculateSkatGameValue({ game, cards: matadorCards, hand: wantsHand, schneider: false, schwarz: false, ouvert: false });
      if (state.highestBid && baseValue < state.highestBid) {
        return socket.emit("error_msg", { message: `Spielwert ${baseValue} reicht nicht für das Reizgebot ${state.highestBid}.` });
      }
      state.game = game;
      state.phase = "playing";
      state.trickNumber = 1;
      state.currentTrick = [];
      state.leadSuit = null;
      state.trickWinners = [];
      state.trickPoints = state.players.map(() => 0);
      state.currentPlayer = state.forehand;
      state.message = `${state.players[state.declarer]} spielt ${gameType === "suit" ? `Farbspiel ${suit}` : gameType === "grand" ? "Grand" : "Null"}.`;
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("skat_play_card", ({ code, card }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "skat") return;
      if (state.phase !== "playing") return socket.emit("error_msg", { message: "Skat ist noch nicht im Stichspiel." });
      if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const suit = String(card?.suit || ""), rank = String(card?.rank || "");
      if (!suit || !rank) return socket.emit("error_msg", { message: "Ungültige Karte." });
      const handCards = state.hands[state.currentPlayer] || [];
      const cardIndex = handCards.findIndex(c => c.suit === suit && c.rank === rank);
      if (cardIndex < 0) return socket.emit("error_msg", { message: "Karte nicht auf der Hand." });
      const game = state.game;
      if (!game) return socket.emit("error_msg", { message: "Spielart fehlt." });
      if (state.leadSuit) {
        if (state.leadSuit === "trump") {
          const hasTrump = handCards.some(c => isSkatTrump(c, game));
          if (hasTrump && !isSkatTrump({ suit, rank }, game)) return socket.emit("error_msg", { message: "Du musst Trumpf bedienen." });
        } else {
          const hasLeadSuit = handCards.some(c => c.suit === state.leadSuit && !isSkatTrump(c, game));
          if (hasLeadSuit && (suit !== state.leadSuit || isSkatTrump({ suit, rank }, game))) return socket.emit("error_msg", { message: "Du musst Farbe bedienen." });
        }
      }
      const playedCard = handCards.splice(cardIndex, 1)[0];
      if (!state.leadSuit) state.leadSuit = getSkatLeadSuit(playedCard, game);
      state.currentTrick.push({ seat: state.currentPlayer, card: playedCard });
      state.message = `${state.players[state.currentPlayer]} spielt ${playedCard.rank}${playedCard.suit}.`;
      if (state.currentTrick.length >= 3) {
        const winnerSeat = determineSkatTrickWinner(state.currentTrick, state.leadSuit, game);
        const trickPoints = state.currentTrick.reduce((sum, play) => sum + getSkatCardPoints(play.card), 0);
        if (game.type !== "null") state.trickPoints[winnerSeat] += trickPoints;
        state.trickWinners.push(winnerSeat);
        state.currentPlayer = winnerSeat;
        state.currentTrick = [];
        state.leadSuit = null;
        state.trickNumber += 1;
        if (state.trickNumber > 10) {
          state.finished = true;
          if (game.type === "null") {
            const declarerTricks = state.trickWinners.filter(seat => seat === state.declarer).length;
            const declarerWins = declarerTricks === 0;
            const nullValue = calculateSkatGameValue({ game, cards: [], hand: state.game?.hand, schneider: false, schwarz: false, ouvert: false });
            state.game.result = { declarerTricks, won: declarerWins, value: declarerWins ? nullValue : -nullValue };
            state.message = declarerWins
              ? `${state.players[state.declarer]} gewinnt Null. Wert: ${nullValue}.`
              : `${state.players[state.declarer]} verliert Null. Wert: ${nullValue}.`;
          } else {
            const totalPoints = state.trickPoints.reduce((sum, v) => sum + v, 0);
            const skatPoints = state.skatPile.reduce((sum, c) => sum + getSkatCardPoints(c), 0);
            const declarerPoints = (state.trickPoints[state.declarer] || 0) + skatPoints;
            const defendersPoints = totalPoints - (state.trickPoints[state.declarer] || 0);
            const declarerWon = declarerPoints >= 61;
            const schneider = declarerPoints >= 90 || defendersPoints <= 30;
            const schwarz = state.trickWinners.every(seat => seat === state.declarer);
            const cardsForValue = state.hands[state.declarer].concat(state.skatPile);
            const gameValue = calculateSkatGameValue({ game, cards: cardsForValue, hand: state.game?.hand, schneider, schwarz, ouvert: false });
            state.game.result = { declarerPoints, defendersPoints, schneider, schwarz, won: declarerWon, value: declarerWon ? gameValue : -gameValue };
            state.message = declarerWon
              ? `${state.players[state.declarer]} gewinnt (${declarerPoints} Augen). Wert: ${gameValue}.`
              : `${state.players[state.declarer]} verliert (${declarerPoints} Augen). Wert: ${gameValue}.`;
          }
        } else {
          state.message = `${state.players[winnerSeat]} gewinnt den Stich.`;
        }
      } else {
        state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
      }
      io.to(room.code).emit("state_update", state);
      persist();
    });

    // ---- Schwimmen ----

    socket.on("schwimmen_swap", ({ code, handIndex, tableIndex }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const state = room.state;
      if (state.gameType !== "schwimmen" || state.finished) return socket.emit("error_msg", { message: "Aktion nicht möglich." });
      if (state.roundPending) return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
      const hIndex = Number(handIndex), tIndex = Number(tableIndex);
      if (![0,1,2].includes(hIndex) || ![0,1,2].includes(tIndex)) return socket.emit("error_msg", { message: "Ungültige Kartenwahl." });
      const hand = state.hands[state.currentPlayer];
      if (!hand || !hand[hIndex] || !state.tableCards[tIndex]) return socket.emit("error_msg", { message: "Ungültige Kartenwahl." });
      const temp = hand[hIndex];
      hand[hIndex] = state.tableCards[tIndex];
      state.tableCards[tIndex] = temp;
      state.passCount = 0;
      state.message = `${state.players[state.currentPlayer]} tauscht eine Karte.`;
      if (handleSchwimmenFeuer(state, state.currentPlayer)) { io.to(room.code).emit("state_update", state); persist(); return; }
      endSchwimmenTurn(state);
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("schwimmen_swap_all", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const state = room.state;
      if (state.gameType !== "schwimmen" || state.finished) return socket.emit("error_msg", { message: "Aktion nicht möglich." });
      if (state.roundPending) return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
      const hand = state.hands[state.currentPlayer];
      if (!hand || hand.length !== 3 || state.tableCards.length !== 3) return socket.emit("error_msg", { message: "Karten fehlen." });
      const temp = hand.slice();
      state.hands[state.currentPlayer] = state.tableCards.slice();
      state.tableCards = temp;
      state.passCount = 0;
      state.message = `${state.players[state.currentPlayer]} tauscht alle Karten.`;
      if (handleSchwimmenFeuer(state, state.currentPlayer)) { io.to(room.code).emit("state_update", state); persist(); return; }
      endSchwimmenTurn(state);
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("schwimmen_pass", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const state = room.state;
      if (state.gameType !== "schwimmen" || state.finished) return socket.emit("error_msg", { message: "Aktion nicht möglich." });
      if (state.roundPending) return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
      state.passCount += 1;
      state.message = `${state.players[state.currentPlayer]} schiebt.`;
      const activeCount = getActiveSchwimmenSeats(state).length;
      if (state.passCount >= activeCount) refreshSchwimmenTable(state);
      if (handleSchwimmenFeuer(state, state.currentPlayer)) { io.to(room.code).emit("state_update", state); persist(); return; }
      endSchwimmenTurn(state);
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("schwimmen_knock", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const state = room.state;
      if (state.gameType !== "schwimmen" || state.finished) return socket.emit("error_msg", { message: "Aktion nicht möglich." });
      if (state.roundPending) return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
      if (state.knockedBy !== null) return socket.emit("error_msg", { message: "Es wurde bereits geklopft." });
      state.passCount = 0;
      state.message = `${state.players[state.currentPlayer]} klopft.`;
      if (handleSchwimmenFeuer(state, state.currentPlayer)) { io.to(room.code).emit("state_update", state); persist(); return; }
      endSchwimmenTurn(state, { knocked: true });
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("schwimmen_start_round", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (state.gameType !== "schwimmen" || state.finished) return socket.emit("error_msg", { message: "Aktion nicht möglich." });
      if (!state.roundPending) return socket.emit("error_msg", { message: "Runde läuft bereits." });
      const seatIndex = room.players.findIndex(p => p.socketId === socket.id);
      if (seatIndex < 0) return;
      const player = room.players[seatIndex];
      const isHost = player?.token === room.hostToken;
      if (typeof state.nextStartingSeat === "number" && seatIndex !== state.nextStartingSeat && !isHost) {
        return socket.emit("error_msg", { message: "Nur der Verlierer darf die nächste Runde starten." });
      }
      startSchwimmenNextRound(state);
      io.to(room.code).emit("state_update", state);
      persist();
    });

    // ---- Würfeln (Schocken/Kniffel/Kwyx) ----

    socket.on("action_roll", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const state = room.state;

      if (state.gameType === "kniffel") {
        if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });
        if (state.throwCount >= state.maxThrowsThisRound) return socket.emit("error_msg", { message: "Keine Würfe mehr übrig." });
        for (let i = 0; i < 5; i++) { if (!state.held[i]) state.dice[i] = rollDie(); }
        state.throwCount++;
        io.to(room.code).emit("state_update", state);
        persist();
        return;
      }
      if (state.gameType === "kwyx") {
        if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });
        if (state.throwCount >= state.maxThrowsThisRound) return socket.emit("error_msg", { message: "Du hast bereits gewürfelt." });
        ensureKwyxTurnState(state);
        resetKwyxTurnState(state);
        clearKwyxCountdown(room, state);
        state.dice = [rollDie(), rollDie(), rollDie(), rollDie(), rollDie(), rollDie()];
        state.throwCount = 1;
        io.to(room.code).emit("state_update", state);
        persist();
        return;
      }
      if (state.gameType === "schwimmen" || state.gameType === "skat") {
        return socket.emit("error_msg", { message: "Diese Aktion ist hier nicht verfügbar." });
      }
      if (state.throwCount >= state.maxThrowsThisRound) return socket.emit("error_msg", { message: "Keine Würfe mehr übrig." });
      if (state.roundJustEnded) { state.message = ""; state.roundJustEnded = false; }
      state.convertedThisTurn = false;
      state.convertedCount = 0;
      state.maxConvertibleThisTurn = 0;
      for (let i = 0; i < 3; i++) { if (!state.held[i]) state.dice[i] = rollDie(); }
      state.throwCount++;
      applyManualSixRule(state);
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("action_toggle", ({ code, index }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const check = canAct(room, socket.id);
      if (!check.ok) return socket.emit("error_msg", { message: check.error });
      const state = room.state;
      const i = Number(index);
      if (state.gameType === "kniffel") {
        if (![0,1,2,3,4].includes(i) || state.finished) return;
        if (state.dice[i] === null) return socket.emit("error_msg", { message: "Bitte zuerst würfeln." });
        state.held[i] = !state.held[i];
        io.to(room.code).emit("state_update", state);
        persist();
        return;
      }
      if (state.gameType === "kwyx" || state.gameType === "schwimmen" || state.gameType === "skat") return;
      if (![0,1,2].includes(i)) return;
      if (state.dice[i] === null) return socket.emit("error_msg", { message: "Bitte zuerst würfeln." });
      const remainingThrows = state.maxThrowsThisRound - state.throwCount;
      if (state.dice[i] === 6 && !state.held[i] && state.convertible[i]) {
        if (remainingThrows <= 0) return socket.emit("error_msg", { message: "Im letzten Wurf darf nicht mehr gedreht werden." });
        if (state.convertedCount >= state.maxConvertibleThisTurn) {
          state.held[i] = true;
          io.to(room.code).emit("state_update", state);
          return;
        }
        state.dice[i] = 1;
        state.convertible[i] = false;
        state.convertedCount++;
        state.convertedThisTurn = true;
        applyManualSixRule(state);
        io.to(room.code).emit("state_update", state);
        persist();
        return;
      }
      state.held[i] = !state.held[i];
      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("action_end_turn", ({ code, category }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (state.gameType !== "kwyx") {
        const check = canAct(room, socket.id);
        if (!check.ok) return socket.emit("error_msg", { message: check.error });
      }

      if (state.gameType === "kniffel") {
        if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });
        if (state.throwCount === 0 || state.dice.includes(null)) return socket.emit("error_msg", { message: "Bitte mindestens einmal würfeln." });
        if (!KNIFFEL_CATEGORIES.includes(category)) return socket.emit("error_msg", { message: "Bitte eine Kategorie wählen." });
        const card = state.scorecard[state.currentPlayer];
        if (!card || card[category] !== null) return socket.emit("error_msg", { message: "Kategorie bereits gewählt." });
        const handBonusEnabled = room.settings?.gameType === "kniffel" ? !!room.settings?.kniffelHandBonus : true;
        const scored = scoreKniffel(state.dice, category, state.throwCount, handBonusEnabled);
        card[category] = scored.score;
        state.totals[state.currentPlayer] = Object.values(card).reduce((acc, val) => acc + (val || 0), 0);
        state.message = `${state.players[state.currentPlayer]} wählt ${scored.label}: ${scored.score} Punkte.`;
        const allDone = state.scorecard.every(sc => KNIFFEL_CATEGORIES.every(cat => sc[cat] !== null));
        if (allDone) {
          state.finished = true;
          const maxScore = Math.max(...state.totals);
          const winners = state.players.filter((_, i) => state.totals[i] === maxScore);
          state.message = `Yahtzee beendet. Gewinner: ${winners.join(", ")} (${maxScore} Punkte).`;
          io.to(room.code).emit("state_update", state);
          persist();
          return;
        }
        state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
        resetKniffelTurn(state);
        io.to(room.code).emit("state_update", state);
        persist();
        return;
      }

      if (state.gameType === "kwyx") {
        if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });
        if (state.throwCount === 0 || state.dice.includes(null)) return socket.emit("error_msg", { message: "Bitte zuerst würfeln." });
        ensureKwyxTurnState(state);
        const seatIndex = getSeatIndexBySocket(room, socket.id);
        if (seatIndex < 0) return socket.emit("error_msg", { message: "Spieler nicht gefunden." });
        if (state.kwyxEnded[seatIndex]) return socket.emit("error_msg", { message: "Du hast deinen Zug bereits beendet." });
        const isActivePlayer = seatIndex === state.currentPlayer;
        const whiteRow = String(category?.whiteRow || "").trim().toLowerCase();
        const colorRow = String(category?.colorRow || "").trim().toLowerCase();
        let colorSum = null;
        if (typeof category?.colorSum === "number" && Number.isFinite(category.colorSum)) {
          colorSum = category.colorSum;
        } else if (typeof category?.colorSum === "string" && category.colorSum.trim() !== "") {
          const parsed = Number(category.colorSum);
          if (Number.isFinite(parsed)) colorSum = parsed;
        }
        const wantsPenalty = !!category?.penalty;
        const whiteSum = state.dice[0] + state.dice[1];
        const colorDice = { red: state.dice[2], yellow: state.dice[3], green: state.dice[4], blue: state.dice[5] };
        if (!isActivePlayer && (colorRow || colorSum !== null || wantsPenalty)) {
          return socket.emit("error_msg", { message: "Passive Spieler dürfen nur die weißen Würfel nutzen." });
        }
        const kcard = state.scorecards[seatIndex];
        if (!kcard) return socket.emit("error_msg", { message: "Scorekarte fehlt." });
        const marks = [];
        if (whiteRow && KWYX_ROWS.includes(whiteRow)) marks.push({ color: whiteRow, value: whiteSum, source: "white" });
        if (isActivePlayer && colorRow && KWYX_ROWS.includes(colorRow)) {
          const die = colorDice[colorRow];
          const possible = [state.dice[0] + die, state.dice[1] + die];
          if (!Number.isFinite(colorSum) || !possible.includes(colorSum)) return socket.emit("error_msg", { message: "Ungültige Farb-Summe." });
          marks.push({ color: colorRow, value: colorSum, source: "color" });
        }
        if (whiteRow && colorRow && whiteRow === colorRow) {
          const whiteIndex = getKwyxRowIndex(whiteRow, whiteSum);
          const colorIndex = getKwyxRowIndex(colorRow, colorSum);
          if (whiteIndex > colorIndex) return socket.emit("error_msg", { message: "Weiß muss vor der Farbmarkierung liegen." });
        }
        const unique = [];
        const seen = new Set();
        for (const mark of marks) {
          const key = `${mark.color}-${mark.value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(mark);
        }
        const applied = [];
        if (!wantsPenalty) {
          for (const mark of unique) {
            const result = canMarkKwyxRow(state, kcard, mark.color, mark.value);
            if (!result.ok) return socket.emit("error_msg", { message: result.error });
            kcard[mark.color][result.index] = true;
            if (result.isLastField) { kcard.locks[mark.color] = true; state.rowLocks[mark.color] = true; }
            applied.push(mark);
          }
        }
        if (applied.length === 0) {
          if (isActivePlayer) {
            kcard.strikes += 1;
            state.message = `${state.players[seatIndex]} streicht einen Fehlwurf (${kcard.strikes}/4).`;
          } else {
            state.message = `${state.players[seatIndex]} beendet ohne Kreuz.`;
          }
        } else {
          state.message = `${state.players[seatIndex]} markiert ${applied.map(m => `${m.color} ${m.value}`).join(" & ")}.`;
        }
        updateKwyxTotals(state);
        state.kwyxPendingFinish = shouldFinishKwyxGame(state);
        state.kwyxEnded[seatIndex] = true;
        const allEnded = state.kwyxEnded.every(Boolean);
        if (allEnded) { finalizeKwyxTurn(io, room, persist); return; }
        if (isActivePlayer && !state.kwyxCountdownEndsAt) {
          const countdownMs = 10 * 1000;
          state.kwyxCountdownEndsAt = Date.now() + countdownMs;
          if (room.kwyxCountdownTimer) clearTimeout(room.kwyxCountdownTimer);
          room.kwyxCountdownTimer = setTimeout(() => finalizeKwyxTurn(io, room, persist), countdownMs);
        }
        io.to(room.code).emit("state_update", state);
        persist();
        return;
      }

      if (state.gameType === "schwimmen") return socket.emit("error_msg", { message: "Aktion nicht verfügbar." });
      if (state.gameType === "skat") return socket.emit("error_msg", { message: "Skat nutzt eigene Aktionen." });

      if (state.throwCount === 0 || state.dice.includes(null)) return socket.emit("error_msg", { message: "Bitte mindestens einmal würfeln, bevor du beendest." });
      if (state.convertedThisTurn) return socket.emit("error_msg", { message: "Nach dem Drehen musst du noch einmal würfeln." });
      const order = activeOrder(state);
      const startPos = seatToOrderPos(order, state.startPlayerIndex);
      const currentPos = seatToOrderPos(order, state.currentPlayer);
      if (currentPos === startPos) state.maxThrowsThisRound = Math.min(3, state.throwCount);
      const score = rateRoll(state.dice, state.throwCount, state.currentPlayer);
      state.scores[state.currentPlayer] = score;
      state.history[state.roundNumber - 1][state.currentPlayer] = {
        label: score.label, throws: score.throws, tier: score.tier, subvalue: score.subvalue
      };
      nextPlayer(state);
      io.to(room.code).emit("state_update", state);
      io.to(room.code).emit("room_update", safeRoom(room));
      persist();
    });

    // ---- Lobby-Management ----

    socket.on("leave_room", ({ code, token }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) return socket.emit("error_msg", { message: "Room-Code nicht gefunden." });
      if (room.status !== "lobby") return socket.emit("error_msg", { message: "Spiel läuft bereits." });
      const seatIndex = room.players.findIndex(p => p.token === token);
      if (seatIndex < 0) return socket.emit("error_msg", { message: "Spieler nicht gefunden." });
      removePlayerFromRoom({ room, seatIndex });
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.emit("room_left", { message: "Lobby verlassen." });
      if (room.players.length === 0) {
        rooms.delete(room.code);
      } else {
        io.to(room.code).emit("room_update", safeRoom(room));
        emitPendingRequests(io, room);
      }
      lobbyList();
      persist();
    });

    socket.on("return_lobby", ({ code, token }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) return;
      if (room.hostToken !== token) return socket.emit("error_msg", { message: "Nur der Host kann alle zurück in die Lobby schicken." });
      room.status = "lobby";
      room.state = null;
      markLobbyActivity(room);
      io.to(room.code).emit("lobby_returned", { message: "Zurück in der Lobby." });
      io.to(room.code).emit("room_update", safeRoom(room));
      emitPendingRequests(io, room);
      lobbyList();
      persist();
    });

    socket.on("keep_lobby", ({ code, token }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "lobby") return;
      if (!room.players.some(p => p.token === token)) return;
      markLobbyActivity(room);
      io.to(room.code).emit("lobby_keep_confirmed", { code: room.code, message: "Lobby bleibt bestehen." });
      lobbyList();
      persist();
    });

    // ---- Disconnect ----

    // ---- Schiffe versenken ----

    socket.on("sv_place_ship", ({ code, shipIndex, row, col, isVertical }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "schiffeversenken") return;
      if (state.phase !== "setup") return socket.emit("error_msg", { message: "Die Aufbauphase ist vorbei." });

      const seatIndex = getSeatIndexBySocket(room, socket.id);
      if (seatIndex < 0) return socket.emit("error_msg", { message: "Spieler nicht gefunden." });
      if (state.readyToStart && state.readyToStart[seatIndex]) return socket.emit("error_msg", { message: "Du hast bereits 'Spiel starten' geklickt." });

      const board = state.boards[seatIndex];
      const idx = Number(shipIndex);
      if (idx < 0 || idx >= board.ships.length) return socket.emit("error_msg", { message: "Ungültiger Schiffsindex." });
      if (board.ships[idx].cells.length > 0) return socket.emit("error_msg", { message: "Dieses Schiff ist bereits platziert." });

      if (!canPlaceShip(board.grid, board.ships[idx].length, row, col, !!isVertical)) {
        return socket.emit("error_msg", { message: "Schiff kann dort nicht platziert werden." });
      }

      placeShip(board, idx, row, col, !!isVertical);

      // Prüfen ob alle Schiffe platziert wurden
      const allPlaced = board.ships.every(s => s.cells.length > 0);
      if (allPlaced) {
        state.setupComplete[seatIndex] = true;
        state.message = `${state.players[seatIndex]}: Alle Schiffe platziert. Bereit zum Starten?`;
      }

      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("sv_remove_ship", ({ code, shipIndex }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "schiffeversenken") return;
      if (state.phase !== "setup") return socket.emit("error_msg", { message: "Die Aufbauphase ist vorbei." });

      const seatIndex = getSeatIndexBySocket(room, socket.id);
      if (seatIndex < 0) return socket.emit("error_msg", { message: "Spieler nicht gefunden." });

      const board = state.boards[seatIndex];
      const idx = Number(shipIndex);
      if (idx < 0 || idx >= board.ships.length) return socket.emit("error_msg", { message: "Ungültiger Schiffsindex." });

      if (!removeShip(board, idx)) return socket.emit("error_msg", { message: "Dieses Schiff ist nicht platziert." });

      // Bereitschaft und setupComplete zurücksetzen
      state.setupComplete[seatIndex] = false;
      if (state.readyToStart) state.readyToStart[seatIndex] = false;
      state.message = `${state.players[seatIndex]} stellt Schiffe um…`;

      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("sv_ready", ({ code }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "schiffeversenken") return;
      if (state.phase !== "setup") return socket.emit("error_msg", { message: "Die Aufbauphase ist vorbei." });

      const seatIndex = getSeatIndexBySocket(room, socket.id);
      if (seatIndex < 0) return socket.emit("error_msg", { message: "Spieler nicht gefunden." });
      if (!state.setupComplete[seatIndex]) return socket.emit("error_msg", { message: "Platziere zuerst alle Schiffe." });

      if (!state.readyToStart) state.readyToStart = [false, false];
      state.readyToStart[seatIndex] = true;

      // Beide bereit? Spiel starten
      if (state.readyToStart[0] && state.readyToStart[1]) {
        state.phase = "playing";
        state.currentPlayer = 0;
        state.message = `${state.players[0]} beginnt!`;
      } else {
        state.message = `${state.players[seatIndex]} ist bereit. Warte auf ${state.players[1 - seatIndex]}…`;
      }

      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("sv_shoot", ({ code, row, col }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room || room.status !== "running") return;
      const state = room.state;
      if (!state || state.gameType !== "schiffeversenken") return;
      if (state.phase !== "playing" || state.winner !== null) return;

      const seatIndex = getSeatIndexBySocket(room, socket.id);
      if (seatIndex < 0) return socket.emit("error_msg", { message: "Spieler nicht gefunden." });
      if (state.currentPlayer !== seatIndex) return socket.emit("error_msg", { message: "Du bist nicht am Zug." });

      const targetSeat = 1 - seatIndex;
      const targetBoard = state.boards[targetSeat];

      const result = recordShot(targetBoard, row, col);
      if (!result.valid) return socket.emit("error_msg", { message: "Dieses Feld wurde bereits beschossen." });

      state.lastShot = { row, col };
      state.lastResult = result.hit ? (result.sunk ? "sunk" : "hit") : "miss";

      if (isGameOver(state.boards)) {
        const winnerIdx = getWinnerIndex(state.boards);
        state.winner = state.players[winnerIdx];
        state.phase = "finished";
        state.message = `🎉 ${state.winner} gewinnt! Alle Schiffe versenkt!`;
      } else if (result.hit) {
        // Bei Treffer darf der Spieler nochmal schießen
        const hitMsg = result.sunk ? "Schiff versenkt!" : "Treffer!";
        state.message = `${hitMsg} ${state.players[seatIndex]} schießt erneut.`;
      } else {
        // Bei Wasser wechselt der Zug
        state.currentPlayer = targetSeat;
        state.message = `Wasser! ${state.players[targetSeat]} ist am Zug.`;
      }

      io.to(room.code).emit("state_update", state);
      persist();
    });

    socket.on("disconnect", () => {
      for (const room of rooms.values()) {
        if (room.pendingRequests) {
          const before = room.pendingRequests.length;
          room.pendingRequests = room.pendingRequests.filter(req => req.socketId !== socket.id);
          if (room.pendingRequests.length !== before) emitPendingRequests(io, room);
        }
        const seat = room.players.findIndex(p => p.socketId === socket.id);
        if (seat >= 0) {
          room.players[seat].connected = false;
          room.players[seat].socketId = null;
          io.to(room.code).emit("room_update", safeRoom(room));
          persist();
          lobbyList();
        }
      }
    });
  });
}
