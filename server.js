import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs/promises";

const app = express();
app.use((req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.use(express.static("public"));

// Keepalive endpoint: hält Free-Service während des Spiels wach
app.get("/ping", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const LOBBY_INACTIVITY_MS = 120 * 1000;
const LOBBY_WARNING_MS = 30 * 1000;

// In-Memory Rooms (persisted to disk)
const rooms = new Map(); // code -> room
const ROOMS_FILE = "./rooms.json";
const CODE_LENGTH = 5;
const DEFAULT_GAME_TYPE = "classic";
const GAME_TYPES = new Set(["classic", "quick"]);

function makeCode(len = CODE_LENGTH) {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isValidCode(code, len = CODE_LENGTH) {
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
function normalizeGameType(value) {
  const candidate = String(value || "").trim().toLowerCase();
  if (GAME_TYPES.has(candidate)) return candidate;
  return DEFAULT_GAME_TYPE;
}

// ---- Game State ----
function createInitialState({ useDeckel }) {
  return {
    gameType: "schocken",
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

const KNIFFEL_CATEGORIES = [
  "ones",
  "twos",
  "threes",
  "fours",
  "fives",
  "sixes",
  "threeKind",
  "fourKind",
  "fullHouse",
  "smallStraight",
  "largeStraight",
  "yahtzee",
  "chance"
];

function createKniffelState() {
  return {
    gameType: "kniffel",
    players: [],
    currentPlayer: 0,
    throwCount: 0,
    maxThrowsThisRound: 3,
    dice: [null, null, null, null, null],
    held: [false, false, false, false, false],
    scorecard: [],
    totals: [],
    message: "",
    finished: false
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

function resetKniffelTurn(state) {
  state.throwCount = 0;
  state.dice = [null, null, null, null, null];
  state.held = [false, false, false, false, false];
}

function scoreKniffel(dice, category) {
  const counts = [0, 0, 0, 0, 0, 0];
  dice.forEach(d => { counts[d - 1]++; });
  const sum = dice.reduce((acc, val) => acc + val, 0);
  const hasN = n => counts.some(c => c >= n);
  const hasExact = (a, b) => counts.includes(a) && counts.includes(b);
  const unique = new Set(dice);
  const hasStraight = (seq) => seq.every(n => unique.has(n));

  switch (category) {
    case "ones": return { score: counts[0] * 1, label: "Einer" };
    case "twos": return { score: counts[1] * 2, label: "Zweier" };
    case "threes": return { score: counts[2] * 3, label: "Dreier" };
    case "fours": return { score: counts[3] * 4, label: "Vierer" };
    case "fives": return { score: counts[4] * 5, label: "Fünfer" };
    case "sixes": return { score: counts[5] * 6, label: "Sechser" };
    case "threeKind": return { score: hasN(3) ? sum : 0, label: "Dreierpasch" };
    case "fourKind": return { score: hasN(4) ? sum : 0, label: "Viererpasch" };
    case "fullHouse": return { score: hasExact(3, 2) ? 25 : 0, label: "Full House" };
    case "smallStraight":
      return { score: (hasStraight([1, 2, 3, 4]) || hasStraight([2, 3, 4, 5]) || hasStraight([3, 4, 5, 6])) ? 30 : 0, label: "Kleine Straße" };
    case "largeStraight":
      return { score: (hasStraight([1, 2, 3, 4, 5]) || hasStraight([2, 3, 4, 5, 6])) ? 40 : 0, label: "Große Straße" };
    case "yahtzee": return { score: hasN(5) ? 50 : 0, label: "Kniffel" };
    case "chance": return { score: sum, label: "Chance" };
    default: return { score: 0, label: "Unbekannt" };
  }
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
  if (room.settings.gameType === "kniffel") {
    const state = createKniffelState();
    state.players = room.players.map(p => p.name);
    state.scorecard = state.players.map(() => {
      const card = {};
      KNIFFEL_CATEGORIES.forEach(cat => { card[cat] = null; });
      return card;
    });
    state.totals = state.players.map(_ => 0);
    state.currentPlayer = 0;
    room.state = state;
  } else {
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
  }
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

function getLobbyList() {
  cleanupInactiveLobbies({ emit: false });
  cleanupEmptyLobbies();
  return [...rooms.values()]
    .filter(room => room.status === "lobby")
    .map(room => ({
      code: room.code,
      hostName: room.players[room.hostSeat]?.name || "Host",
      playerCount: room.players.length,
      useDeckel: !!room.settings.useDeckel,
      gameType: room.settings.gameType || "schocken"
    }));
}

function emitLobbyList() {
  io.emit("lobby_list", { lobbies: getLobbyList() });
}

function cleanupEmptyLobbies() {
  let removed = false;
  for (const room of rooms.values()) {
    if (room.status !== "lobby") continue;
    const hasConnectedPlayer = room.players.some(player => player.connected);
    if (!hasConnectedPlayer) {
      rooms.delete(room.code);
      removed = true;
    }
  }
  if (removed) {
    persistRooms();
  }
}

function markLobbyActivity(room) {
  room.lastLobbyActivity = Date.now();
  room.lobbyWarnedAt = null;
}

function warnLobbyExpiry(room, secondsLeft) {
  if (room.lobbyWarnedAt) return;
  room.lobbyWarnedAt = Date.now();
  io.to(room.code).emit("lobby_expiring", {
    code: room.code,
    secondsLeft
  });
}

function deleteExpiredLobby(room) {
  io.to(room.code).emit("lobby_deleted", {
    code: room.code,
    message: "Lobby wurde wegen Inaktivität gelöscht."
  });
  rooms.delete(room.code);
}

function cleanupInactiveLobbies({ emit = true } = {}) {
  let removed = false;
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status !== "lobby") continue;
    const lastActivity = room.lastLobbyActivity || now;
    const elapsed = now - lastActivity;
    const remaining = LOBBY_INACTIVITY_MS - elapsed;
    const hasConnectedPlayer = room.players.some(player => player.connected);
    if (remaining <= 0) {
      deleteExpiredLobby(room);
      removed = true;
      continue;
    }
    if (hasConnectedPlayer && remaining <= LOBBY_WARNING_MS) {
      warnLobbyExpiry(room, Math.max(1, Math.ceil(remaining / 1000)));
    }
  }
  if (removed) {
    if (emit) {
      emitLobbyList();
    }
    persistRooms();
  }
}

function getSocketRoom(socket) {
  const code = normalizeCode(socket.data?.roomCode);
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) {
    socket.data.roomCode = null;
    return null;
  }
  return room;
}

function blockIfAlreadyInRoom(socket) {
  if (getSocketRoom(socket)) {
    socket.emit("error_msg", { message: "Du bist bereits in einer Lobby. Bitte wieder beitreten." });
    return true;
  }
  return false;
}

function pendingSummary(room) {
  return (room.pendingRequests || []).map(req => ({
    id: req.id,
    name: req.name,
    requestedAt: req.requestedAt
  }));
}

function emitPendingRequests(room) {
  const host = room.players[room.hostSeat];
  if (host?.socketId) {
    io.to(host.socketId).emit("join_requests_update", {
      code: room.code,
      requests: pendingSummary(room)
    });
  }
}

function updateRoomSettings({ room, useDeckel, gameType }) {
  const nextGameType = gameType === "kniffel" ? "kniffel" : "schocken";
  room.settings.gameType = nextGameType;
  room.settings.useDeckel = nextGameType === "schocken" ? !!useDeckel : false;
}

function removePlayerFromRoom({ room, seatIndex }) {
  const [removed] = room.players.splice(seatIndex, 1);
  if (seatIndex < room.hostSeat) {
    room.hostSeat -= 1;
  }
  if (removed && removed.token === room.hostToken) {
    if (room.players.length > 0) {
      const nextHostIndex = Math.floor(Math.random() * room.players.length);
      room.hostSeat = nextHostIndex;
      room.hostToken = room.players[nextHostIndex].token;
    }
  }
  return removed;
}

function handleJoinRequest(socket, { code, name }) {
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
      name: cleanName,
      code: room.code,
      requestId: request.id
    });
  }
  emitPendingRequests(room);
}

function tryReconnectByName({ room, socket, name }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return false;
  const seatIndex = room.players.findIndex(
    p => p.name.toLowerCase() === cleanName.toLowerCase() && !p.connected
  );
  if (seatIndex < 0) return false;

  const player = room.players[seatIndex];
  player.socketId = socket.id;
  player.connected = true;
  if (room.pendingRequests) {
    room.pendingRequests = room.pendingRequests.filter(req => req.name.toLowerCase() !== cleanName.toLowerCase());
  }

  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.emit("room_joined", {
    code: room.code,
    token: player.token,
    seatIndex,
    name: player.name,
    isHost: player.token === room.hostToken,
    room: safeRoom(room),
    state: room.state
  });

  io.to(room.code).emit("room_update", safeRoom(room));
  if (room.state) io.to(room.code).emit("state_update", room.state);
  if (player.token === room.hostToken) emitPendingRequests(room);
  emitLobbyList();
  persistRooms();
  return true;
}

function createRoom({ socket, name, useDeckel, gameType, requestedCode }) {
  let code;
  const normalizedRequested = normalizeCode(requestedCode);
  if (normalizedRequested) {
    if (!isValidCode(normalizedRequested)) {
      return socket.emit("error_msg", { message: `Room-Code ungültig (nur ${CODE_LENGTH} Zeichen aus 23456789ABCDEFGHJKMNPQRSTUVWXYZ).` });
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
    settings: { useDeckel: !!useDeckel, gameType: "schocken" },
    hostToken: token,
    hostSeat: 0,
    lastLobbyActivity: Date.now(),
    lobbyWarnedAt: null,
    players: [
      { token, socketId: socket.id, name, connected: true }
    ],
    pendingRequests: [],
    state: null
  };

  rooms.set(code, room);
  socket.join(code);
  socket.data.roomCode = code;

  persistRooms();

  socket.emit("room_joined", {
    code,
    token,
    seatIndex: 0,
    name,
    isHost: true,
    room: safeRoom(room),
    state: null
  });

  io.to(code).emit("room_update", safeRoom(room));
  emitPendingRequests(room);
  emitLobbyList();
}

async function persistRooms() {
  const data = [...rooms.values()].map(room => ({
    code: room.code,
    status: room.status,
    settings: room.settings,
    hostToken: room.hostToken,
    hostSeat: room.hostSeat,
    lastLobbyActivity: room.lastLobbyActivity || null,
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
      const settings = {
        useDeckel: !!room.settings?.useDeckel,
        gameType: normalizeGameType(room.settings?.gameType)
      };
      rooms.set(normalizedCode, {
        ...room,
        code: normalizedCode,
        settings: {
          useDeckel: !!room.settings?.useDeckel,
          gameType: room.settings?.gameType === "kniffel" ? "kniffel" : "schocken"
        },
        lastLobbyActivity: room.lastLobbyActivity || Date.now(),
        lobbyWarnedAt: null,
        players: (room.players || []).map(p => ({
          ...p,
          connected: false,
          socketId: null
        })),
        pendingRequests: []
      });
    });
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Konnte Rooms nicht laden:", err);
    }
  }
}

loadRooms();

setInterval(() => {
  cleanupInactiveLobbies();
}, 5000);

// ---- Socket.IO ----
io.on("connection", (socket) => {
  socket.emit("lobby_list", { lobbies: getLobbyList() });

  socket.on("get_lobby_list", () => {
    socket.emit("lobby_list", { lobbies: getLobbyList() });
  });

  socket.on("create_room", ({ name, useDeckel, gameType, requestedCode }) => {
    if (blockIfAlreadyInRoom(socket)) return;
    const cleanName = String(name || "").trim() || "Spieler";
    createRoom({ socket, name: cleanName, useDeckel, gameType, requestedCode });
  });

  socket.on("request_join", ({ code, name }) => {
    handleJoinRequest(socket, { code, name });
  });

  socket.on("enter_room", ({ name, requestedCode, useDeckel, gameType }) => {
    if (blockIfAlreadyInRoom(socket)) return;
    const cleanName = String(name || "").trim() || "Spieler";
    const normalized = normalizeCode(requestedCode);
    if (normalized) {
      const room = rooms.get(normalized);
      if (room) {
        if (tryReconnectByName({ room, socket, name: cleanName })) return;
        return handleJoinRequest(socket, { code: normalized, name: cleanName });
      }
    }
    createRoom({ socket, name: cleanName, useDeckel, gameType, requestedCode: normalized });
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
      if (targetSocket) {
        targetSocket.emit("join_denied", { message: "Host hat den Beitritt abgelehnt." });
      }
      emitPendingRequests(room);
      return;
    }

    if (room.status !== "lobby") {
      if (targetSocket) targetSocket.emit("join_denied", { message: "Spiel läuft bereits." });
      emitPendingRequests(room);
      return;
    }

    if (room.players.some(p => p.name.toLowerCase() === request.name.toLowerCase())) {
      if (targetSocket) targetSocket.emit("join_denied", { message: "Name ist schon vergeben. Bitte anderen Namen wählen." });
      emitPendingRequests(room);
      return;
    }

    if (!targetSocket) {
      socket.emit("error_msg", { message: "Spieler ist nicht mehr verbunden." });
      emitPendingRequests(room);
      return;
    }

    const newToken = makeToken();
    const seatIndex = room.players.length;
    room.players.push({
      token: newToken,
      socketId: request.socketId,
      name: request.name,
      connected: true
    });
    markLobbyActivity(room);

    targetSocket.join(room.code);
    targetSocket.data.roomCode = room.code;
    targetSocket.emit("room_joined", {
      code: room.code,
      token: newToken,
      seatIndex,
      name: request.name,
      isHost: false,
      room: safeRoom(room),
      state: room.state
    });

    io.to(room.code).emit("room_update", safeRoom(room));
    emitPendingRequests(room);
    emitLobbyList();
    persistRooms();
  });

  socket.on("join_room", ({ code, name }) => {
    handleJoinRequest(socket, { code, name });
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
    if (token === room.hostToken) emitPendingRequests(room);
    persistRooms();
  });

  socket.on("start_game", ({ code, token }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room) return;
    if (room.hostToken !== token) return socket.emit("error_msg", { message: "Nur der Host kann starten." });
    if (room.players.length < 2) return socket.emit("error_msg", { message: "Mindestens 2 Spieler nötig." });

    startNewGame(room);
    room.lobbyWarnedAt = null;

    io.to(room.code).emit("room_update", safeRoom(room));
    io.to(room.code).emit("state_update", room.state);
    emitLobbyList();
    persistRooms();
  });

  socket.on("update_room_settings", ({ code, token, useDeckel, gameType }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room) return;
    if (room.hostToken !== token) return socket.emit("error_msg", { message: "Nur der Host kann Einstellungen ändern." });
    if (room.status !== "lobby") return socket.emit("error_msg", { message: "Spiel läuft bereits." });

    updateRoomSettings({ room, useDeckel, gameType });
    io.to(room.code).emit("room_update", safeRoom(room));
    emitLobbyList();
    persistRooms();
  });

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
      emitPendingRequests(room);
    }
    emitLobbyList();
    persistRooms();
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
    emitPendingRequests(room);
    emitLobbyList();
    persistRooms();
  });

  socket.on("keep_lobby", ({ code, token }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room) return;
    if (room.status !== "lobby") return;
    const isMember = room.players.some(player => player.token === token);
    if (!isMember) return;
    markLobbyActivity(room);
    io.to(room.code).emit("lobby_keep_confirmed", {
      code: room.code,
      message: "Lobby bleibt bestehen."
    });
    emitLobbyList();
    persistRooms();
  });

  socket.on("action_roll", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;

    if (state.gameType === "kniffel") {
      if (state.finished) {
        return socket.emit("error_msg", { message: "Spiel ist beendet." });
      }
      if (state.throwCount >= state.maxThrowsThisRound) {
        return socket.emit("error_msg", { message: "Keine Würfe mehr übrig." });
      }
      for (let i = 0; i < 5; i++) {
        if (!state.held[i]) state.dice[i] = rollDie();
      }
      state.throwCount++;
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }

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
    if (state.gameType === "kniffel") {
      if (![0, 1, 2, 3, 4].includes(i)) return;
      if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });
      if (state.dice[i] === null) return socket.emit("error_msg", { message: "Bitte zuerst würfeln." });
      state.held[i] = !state.held[i];
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }

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

  socket.on("action_end_turn", ({ code, category }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;

    if (state.gameType === "kniffel") {
      if (state.finished) {
        return socket.emit("error_msg", { message: "Spiel ist beendet." });
      }
      if (state.throwCount === 0 || state.dice.includes(null)) {
        return socket.emit("error_msg", { message: "Bitte mindestens einmal würfeln, bevor du beendest." });
      }
      if (!KNIFFEL_CATEGORIES.includes(category)) {
        return socket.emit("error_msg", { message: "Bitte eine Kategorie wählen." });
      }
      const card = state.scorecard[state.currentPlayer];
      if (!card || card[category] !== null) {
        return socket.emit("error_msg", { message: "Kategorie bereits gewählt." });
      }
      const scored = scoreKniffel(state.dice, category);
      card[category] = scored.score;
      state.totals[state.currentPlayer] = Object.values(card).reduce((acc, val) => acc + (val || 0), 0);
      state.message = `${state.players[state.currentPlayer]} wählt ${scored.label}: ${scored.score} Punkte.`;

      const allDone = state.scorecard.every(sc => KNIFFEL_CATEGORIES.every(cat => sc[cat] !== null));
      if (allDone) {
        state.finished = true;
        const maxScore = Math.max(...state.totals);
        const winners = state.players.filter((_, i) => state.totals[i] === maxScore);
        state.message = `Kniffel beendet. Gewinner: ${winners.join(", ")} (${maxScore} Punkte).`;
        io.to(room.code).emit("state_update", state);
        persistRooms();
        return;
      }

      state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
      resetKniffelTurn(state);
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }

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
      if (room.pendingRequests) {
        const pendingBefore = room.pendingRequests.length;
        room.pendingRequests = room.pendingRequests.filter(req => req.socketId !== socket.id);
        if (room.pendingRequests.length !== pendingBefore) {
          emitPendingRequests(room);
        }
      }
      const seat = room.players.findIndex(p => p.socketId === socket.id);
      if (seat >= 0) {
        room.players[seat].connected = false;
        room.players[seat].socketId = null;
        io.to(room.code).emit("room_update", safeRoom(room));
        persistRooms();
        emitLobbyList();
      }
    }
  });
});

// Render: an PORT + 0.0.0.0 binden (Render forwarded dann Requests) :contentReference[oaicite:12]{index=12}
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
