import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs/promises";

const app = express();
app.use(express.static("public"));

// Keepalive endpoint: hält Free-Service während des Spiels wach
app.get("/ping", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// In-Memory Rooms (persisted to disk)
const rooms = new Map(); // code -> room
const ROOMS_FILE = "./rooms.json";

function makeCode(len = 6) {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isValidCode(code, len = 6) {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  if (!code || code.length !== len) return false;
  return [...code].every(ch => alphabet.includes(ch));
}
function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}
function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

// ---- Game State ----
function createInitialState({ useDeckel }) {
  return {
    useDeckel: !!useDeckel,

    players: [],              // names, index = seat
    currentPlayer: 0,         // seat index
    startPlayerIndex: 0,      // seat index (start of round)
    playerTurnIndex: 0,       // position in round order

    maxThrowsThisRound: 3,
    throwCount: 0,
    dice: [null, null, null],
    held: [false, false, false],
    convertible: [false, false, false],

    scores: [],               // per seat
    wins: [],                 // per seat (non-deckel)
    history: [],              // round history
    roundNumber: 1,

    // 6->1 convert rule bookkeeping
    convertedThisTurn: false,
    convertedCount: 0,
    maxConvertibleThisTurn: 0,

    // Deckel mode bookkeeping
    deckelCount: [],
    halfLossCount: [],
    inFinal: false,
    finalPlayers: [],

    message: ""
  };
}

function resetTurn(state) {
  state.throwCount = 0;
  state.dice = [null, null, null];
  state.held = [false, false, false];
  state.convertible = [false, false, false];
  state.convertedThisTurn = false;
  state.convertedCount = 0;
  state.maxConvertibleThisTurn = 0;
}

function applyManualSixRule(state) {
  state.convertible = [false, false, false];
  const freshSixes = [];
  for (let i = 0; i < 3; i++) {
    if (state.dice[i] === 6 && !state.held[i]) freshSixes.push(i);
  }
  if (freshSixes.length < 2) {
    state.maxConvertibleThisTurn = 0;
    return;
  }
  state.maxConvertibleThisTurn = (freshSixes.length === 3) ? 2 : 1;
  for (const i of freshSixes) state.convertible[i] = true;
}

function rateRoll(dice, throws, playerIndex) {
  const sorted = dice.slice().sort((x, y) => y - x);
  const [a, b, c] = sorted;

  const countOf1 = sorted.filter(d => d === 1).length;
  let label, tier, subvalue;

  if (countOf1 === 3) {
    label = "Schock Out";
    tier = 4; subvalue = 6;
  } else if (countOf1 === 2) {
    label = `Schock ${a}`;
    tier = 3; subvalue = a;
  } else if (a === b && b === c) {
    label = "Pasch";
    tier = 2; subvalue = a;
  } else if (a - b === 1 && b - c === 1) {
    label = "Straße";
    tier = 1; subvalue = 0;
  } else {
    label = `${a}-${b}-${c}`;
    tier = 0; subvalue = parseInt(`${a}${b}${c}`, 10);
  }

  return { label, tier, subvalue, throws, playerIndex };
}

function sortScores(scores) {
  return scores
    .map((s, i) => ({ playerIndex: i, ...s }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return b.tier - a.tier;
      if (a.subvalue !== b.subvalue) return b.subvalue - a.subvalue;
      if (a.throws !== b.throws) return a.throws - b.throws;
      return a.playerIndex - b.playerIndex;
    });
}

// In final mode only those seats act, but we do NOT reindex arrays (seat indices stay stable)
function activeOrder(state) {
  if (state.inFinal && state.finalPlayers.length >= 2) return state.finalPlayers.slice();
  return state.players.map((_, i) => i);
}

function seatToOrderPos(order, seat) {
  const pos = order.indexOf(seat);
  return pos >= 0 ? pos : 0;
}

function setCurrentFromOrder(state, order, orderPos) {
  state.currentPlayer = order[orderPos];
}

function nextPlayer(state) {
  const order = activeOrder(state);
  state.playerTurnIndex++;

  if (state.playerTurnIndex < order.length) {
    setCurrentFromOrder(state, order, seatToOrderPos(order, state.startPlayerIndex) + state.playerTurnIndex);
    resetTurn(state);
    state.message = "";
    return;
  }

  prepareNextRound(state);
}

function rotateCurrentPlayer(state) {
  const order = activeOrder(state);
  if (order.length === 0) return;
  const currentPos = seatToOrderPos(order, state.currentPlayer);
  const nextPos = (currentPos + 1) % order.length;
  const startPos = seatToOrderPos(order, state.startPlayerIndex);

  state.currentPlayer = order[nextPos];
  state.playerTurnIndex = (nextPos - startPos + order.length) % order.length;
  resetTurn(state);
  state.message = "Host hat den nächsten Spieler gewählt.";
}

function prepareNextRound(state) {
  const order = activeOrder(state);

  // Nur die aktiven Spieler zählen für win/lose der Runde:
  const roundScores = order.map(seat => ({ seat, score: state.scores[seat] }));
  const sortable = roundScores.map(x => ({ playerIndex: x.seat, ...x.score }));
  sortable.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    if (a.subvalue !== b.subvalue) return b.subvalue - a.subvalue;
    if (a.throws !== b.throws) return a.throws - b.throws;
    return a.playerIndex - b.playerIndex;
  });

  const winnerSeat = sortable[0].playerIndex;
  const loserSeat = sortable[sortable.length - 1].playerIndex;

  if (state.useDeckel) {
    let penalty;
    switch (sortable[0].tier) {
      case 0: penalty = 1; break;
      case 1: penalty = 2; break;
      case 2: penalty = 3; break;
      case 3: penalty = sortable[0].subvalue; break;
      case 4: penalty = 13; break;
      default: penalty = 1;
    }

    state.deckelCount[loserSeat] += penalty;
    state.message = `Runde ${state.roundNumber} beendet. Gewinner: ${state.players[winnerSeat]} (${sortable[0].label}). Verlierer: ${state.players[loserSeat]} (+${penalty} Deckel).`;

    // Halbzeit/Finale sehr pragmatisch:
    if (state.deckelCount[loserSeat] >= 13) {
      state.halfLossCount[loserSeat]++;

      const halfLosers = state.halfLossCount
        .map((c, i) => ({ c, i }))
        .filter(x => x.c > 0)
        .map(x => x.i);

      if (halfLosers.length >= 2) {
        state.inFinal = true;
        state.finalPlayers = halfLosers.slice(0, 2); // simple: erste zwei Halbzeit-Verlierer
        // Reset Deckel nur für Finalisten
        for (const seat of state.finalPlayers) state.deckelCount[seat] = 0;
        state.message += ` Finale gestartet: ${state.finalPlayers.map(i => state.players[i]).join(" vs ")}.`;
      } else {
        // Neue Halbzeit: alle Deckel reset
        state.deckelCount = state.deckelCount.map(_ => 0);
        state.message += ` Neue Halbzeit startet.`;
      }
    }

  } else {
    state.wins[winnerSeat] += 1;
    state.message = `Runde ${state.roundNumber} beendet. Gewinner: ${state.players[winnerSeat]} (${sortable[0].label}).`;
  }

  // Nächste Runde Setup
  state.roundNumber++;
  state.history.push(new Array(state.players.length).fill(null));

  state.maxThrowsThisRound = 3;
  state.startPlayerIndex = loserSeat; // loser beginnt
  state.playerTurnIndex = 0;

  // reset scores for next round
  state.scores = state.players.map(_ => ({ tier: null, subvalue: null, throws: 0, label: "" }));

  const nextOrder = activeOrder(state);
  // falls loser nicht aktiv ist (Finale), start bei erstem aktiven:
  const startPos = seatToOrderPos(nextOrder, state.startPlayerIndex);
  setCurrentFromOrder(state, nextOrder, startPos);
  resetTurn(state);
}

function startNewGame(room) {
  const state = createInitialState({ useDeckel: room.settings.useDeckel });
  state.players = room.players.map(p => p.name);

  state.scores = state.players.map(_ => ({ tier: null, subvalue: null, throws: 0, label: "" }));
  state.wins = state.players.map(_ => 0);
  state.history = [new Array(state.players.length).fill(null)];

  if (state.useDeckel) {
    state.deckelCount = state.players.map(_ => 0);
    state.halfLossCount = state.players.map(_ => 0);
  } else {
    state.deckelCount = state.players.map(_ => 0);
    state.halfLossCount = state.players.map(_ => 0);
  }

  state.startPlayerIndex = 0;
  state.playerTurnIndex = 0;
  state.currentPlayer = 0;

  room.state = state;
  room.status = "running";
}

function canAct(room, socketId) {
  const state = room.state;
  const seat = state.currentPlayer;
  const player = room.players[seat];
  if (!player) return { ok: false, error: "Aktueller Spieler existiert nicht." };
  if (player.socketId !== socketId) return { ok: false, error: "Du bist nicht am Zug." };
  return { ok: true };
}

function safeRoom(room) {
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    players: room.players.map(p => ({ name: p.name, connected: p.connected })),
    hostSeat: room.hostSeat
  };
}

async function persistRooms() {
  const data = [...rooms.values()].map(room => ({
    code: room.code,
    status: room.status,
    settings: room.settings,
    hostToken: room.hostToken,
    hostSeat: room.hostSeat,
    players: room.players.map(p => ({
      token: p.token,
      name: p.name,
      connected: false,
      socketId: null
    })),
    state: room.state
  }));
  try {
    await fs.writeFile(ROOMS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Konnte Rooms nicht speichern:", err);
  }
}

async function loadRooms() {
  try {
    const raw = await fs.readFile(ROOMS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;
    data.forEach(room => {
      const normalizedCode = normalizeCode(room.code);
      if (!normalizedCode) return;
      rooms.set(normalizedCode, {
        ...room,
        code: normalizedCode,
        players: (room.players || []).map(p => ({
          ...p,
          connected: false,
          socketId: null
        }))
      });
    });
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Konnte Rooms nicht laden:", err);
    }
  }
}

loadRooms();

// ---- Socket.IO ----
io.on("connection", (socket) => {
  socket.on("create_room", ({ name, useDeckel, requestedCode }) => {
    const cleanName = String(name || "").trim() || "Spieler";
    let code;
    const normalizedRequested = normalizeCode(requestedCode);
    if (normalizedRequested) {
      if (!isValidCode(normalizedRequested)) {
        return socket.emit("error_msg", { message: "Room-Code ungültig (nur 6 Zeichen aus 23456789ABCDEFGHJKMNPQRSTUVWXYZ)." });
      }
      if (rooms.has(normalizedRequested)) {
        return socket.emit("error_msg", { message: "Room-Code ist bereits vergeben." });
      }
      code = normalizedRequested;
    } else {
      do { code = makeCode(); } while (rooms.has(code));
    }

    const token = makeToken();
    const room = {
      code,
      status: "lobby",
      settings: { useDeckel: !!useDeckel },
      hostToken: token,
      hostSeat: 0,
      players: [
        { token, socketId: socket.id, name: cleanName, connected: true }
      ],
      state: null
    };

    rooms.set(code, room);
    socket.join(code);

    persistRooms();

    socket.emit("room_joined", {
      code,
      token,
      seatIndex: 0,
      name: cleanName,
      isHost: true,
      room: safeRoom(room),
      state: null
    });

    io.to(code).emit("room_update", safeRoom(room));
  });

  socket.on("join_room", ({ code, name }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room) return socket.emit("error_msg", { message: "Room-Code nicht gefunden." });
    if (room.status !== "lobby") return socket.emit("error_msg", { message: "Spiel läuft bereits." });

    const cleanName = String(name || "").trim() || "Spieler";
    if (room.players.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return socket.emit("error_msg", { message: "Name ist schon vergeben. Bitte anderen Namen wählen." });
    }

    const token = makeToken();
    const seatIndex = room.players.length;
    room.players.push({ token, socketId: socket.id, name: cleanName, connected: true });

    socket.join(room.code);

    socket.emit("room_joined", {
      code: room.code,
      token,
      seatIndex,
      name: cleanName,
      isHost: false,
      room: safeRoom(room),
      state: room.state
    });

    io.to(room.code).emit("room_update", safeRoom(room));
    persistRooms();
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

    socket.emit("room_joined", {
      code: room.code,
      token,
      seatIndex,
      name: player.name,
      isHost: token === room.hostToken,
      room: safeRoom(room),
      state: room.state
    });

    io.to(room.code).emit("room_update", safeRoom(room));
    if (room.state) io.to(room.code).emit("state_update", room.state);
    persistRooms();
  });

  socket.on("start_game", ({ code, token }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room) return;
    if (room.hostToken !== token) return socket.emit("error_msg", { message: "Nur der Host kann starten." });
    if (room.players.length < 2) return socket.emit("error_msg", { message: "Mindestens 2 Spieler nötig." });

    startNewGame(room);

    io.to(room.code).emit("room_update", safeRoom(room));
    io.to(room.code).emit("state_update", room.state);
    persistRooms();
  });

  socket.on("action_roll", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;

    if (state.throwCount >= state.maxThrowsThisRound) {
      return socket.emit("error_msg", { message: "Keine Würfe mehr übrig." });
    }

    state.convertedThisTurn = false;
    state.convertedCount = 0;
    state.maxConvertibleThisTurn = 0;

    for (let i = 0; i < 3; i++) {
      if (!state.held[i]) state.dice[i] = rollDie();
    }
    state.throwCount++;

    applyManualSixRule(state);
    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("action_toggle", ({ code, index }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;
    const i = Number(index);
    if (![0, 1, 2].includes(i)) return;

    if (state.dice[i] === null) return socket.emit("error_msg", { message: "Bitte zuerst würfeln." });

    const remainingThrows = state.maxThrowsThisRound - state.throwCount;

    // 6 -> 1 convert (nur wenn convertible)
    if (state.dice[i] === 6 && !state.held[i] && state.convertible[i]) {
      if (remainingThrows <= 0) {
        return socket.emit("error_msg", { message: "Im letzten Wurf darf nicht mehr gedreht werden." });
      }
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
      persistRooms();
      return;
    }

    // hold/unhold
    state.held[i] = !state.held[i];
    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("action_end_turn", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;

    if (state.throwCount === 0 || state.dice.includes(null)) {
      return socket.emit("error_msg", { message: "Bitte mindestens einmal würfeln, bevor du beendest." });
    }
    if (state.convertedThisTurn) {
      return socket.emit("error_msg", { message: "Nach dem Drehen musst du noch einmal würfeln." });
    }

    // Startspieler setzt maxThrows für die Runde (wie im Original-Konzept)
    const order = activeOrder(state);
    const startPos = seatToOrderPos(order, state.startPlayerIndex);
    const currentPos = seatToOrderPos(order, state.currentPlayer);
    if (currentPos === startPos) {
      state.maxThrowsThisRound = Math.min(3, state.throwCount);
    }

    const score = rateRoll(state.dice, state.throwCount, state.currentPlayer);
    state.scores[state.currentPlayer] = score;

    // Historie (speichern pro seat)
    state.history[state.roundNumber - 1][state.currentPlayer] = {
      label: score.label,
      throws: score.throws,
      tier: score.tier,
      subvalue: score.subvalue
    };

    nextPlayer(state);

    io.to(room.code).emit("state_update", state);
    io.to(room.code).emit("room_update", safeRoom(room));
    persistRooms();
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const seat = room.players.findIndex(p => p.socketId === socket.id);
      if (seat >= 0) {
        room.players[seat].connected = false;
        room.players[seat].socketId = null;
        io.to(room.code).emit("room_update", safeRoom(room));
        persistRooms();
      }
    }
  });
});

// Render: an PORT + 0.0.0.0 binden (Render forwarded dann Requests) :contentReference[oaicite:12]{index=12}
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
