// Raum-Verwaltung: Erstellen, Beitreten, Einstellungen, Cleanup.
import { makeCode, makeToken, normalizeCode, isValidCode, normalizeRoomGameType } from "./utils.js";
import { LOBBY_INACTIVITY_MS, LOBBY_WARNING_MS } from "./config.js";

export function safeRoom(room) {
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    players: room.players.map(p => ({ name: p.name, connected: p.connected })),
    hostSeat: room.hostSeat
  };
}

export function getLobbyList(rooms) {
  cleanupInactiveLobbies(rooms, { emit: false });
  cleanupEmptyLobbies(rooms);
  return [...rooms.values()]
    .filter(room => room.status === "lobby")
    .map(room => ({
      code: room.code,
      hostName: room.players[room.hostSeat]?.name || "Host",
      playerCount: room.players.length,
      useDeckel: !!room.settings.useDeckel,
      kniffelHandBonus: room.settings.kniffelHandBonus !== false,
      gameType: room.settings.gameType || "schocken"
    }));
}

export function pendingSummary(room) {
  return (room.pendingRequests || []).map(req => ({
    id: req.id,
    name: req.name,
    requestedAt: req.requestedAt
  }));
}

export function markLobbyActivity(room) {
  room.lastLobbyActivity = Date.now();
  room.lobbyWarnedAt = null;
}

export function updateRoomSettings({ room, useDeckel, kniffelHandBonus, gameType }) {
  const nextGameType = normalizeRoomGameType(gameType);
  room.settings.gameType = nextGameType;
  room.settings.useDeckel = nextGameType === "schocken" ? !!useDeckel : false;
  room.settings.kniffelHandBonus = nextGameType === "kniffel" ? kniffelHandBonus !== false : true;
}

export function removePlayerFromRoom({ room, seatIndex }) {
  const [removed] = room.players.splice(seatIndex, 1);
  if (seatIndex < room.hostSeat) room.hostSeat -= 1;
  if (removed && removed.token === room.hostToken) {
    if (room.players.length > 0) {
      const nextHostIndex = Math.floor(Math.random() * room.players.length);
      room.hostSeat = nextHostIndex;
      room.hostToken = room.players[nextHostIndex].token;
    }
  }
  return removed;
}

export function cleanupEmptyLobbies(rooms, persistFn) {
  let removed = false;
  for (const room of rooms.values()) {
    if (room.status !== "lobby") continue;
    const hasConnectedPlayer = room.players.some(player => player.connected);
    if (!hasConnectedPlayer) {
      rooms.delete(room.code);
      removed = true;
    }
  }
  if (removed && persistFn) persistFn();
}

export function cleanupInactiveLobbies(rooms, io, { emit = true, persistFn } = {}) {
  let removed = false;
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status !== "lobby") continue;
    const lastActivity = room.lastLobbyActivity || now;
    const elapsed = now - lastActivity;
    const remaining = LOBBY_INACTIVITY_MS - elapsed;
    const hasConnectedPlayer = room.players.some(player => player.connected);
    if (remaining <= 0) {
      if (emit && io) {
        io.to(room.code).emit("lobby_deleted", {
          code: room.code,
          message: "Lobby wurde wegen Inaktivität gelöscht."
        });
      }
      rooms.delete(room.code);
      removed = true;
      continue;
    }
    if (hasConnectedPlayer && remaining <= LOBBY_WARNING_MS) {
      if (!room.lobbyWarnedAt && emit && io) {
        room.lobbyWarnedAt = Date.now();
        io.to(room.code).emit("lobby_expiring", {
          code: room.code,
          secondsLeft: Math.max(1, Math.ceil(remaining / 1000))
        });
      }
    }
  }
  if (removed && persistFn) persistFn();
  return removed;
}

export function createRoom({ socket, rooms, name, useDeckel, kniffelHandBonus, gameType, requestedCode, persistFn, emitLobbyList }) {
  let code;
  const normalizedRequested = normalizeCode(requestedCode);
  if (normalizedRequested) {
    if (!isValidCode(normalizedRequested)) {
      return socket.emit("error_msg", { message: `Room-Code ungültig (nur 5 Zeichen aus 23456789ABCDEFGHJKMNPQRSTUVWXYZ).` });
    }
    if (rooms.has(normalizedRequested)) {
      return socket.emit("error_msg", { message: "Room-Code ist bereits vergeben." });
    }
    code = normalizedRequested;
  } else {
    do { code = makeCode(); } while (rooms.has(code));
  }

  const token = makeToken();
  const normalizedGameType = normalizeRoomGameType(gameType);
  const room = {
    code,
    status: "lobby",
    settings: {
      useDeckel: normalizedGameType === "schocken" ? !!useDeckel : false,
      kniffelHandBonus: normalizedGameType === "kniffel" ? kniffelHandBonus !== false : true,
      gameType: normalizedGameType
    },
    hostToken: token,
    hostSeat: 0,
    lastLobbyActivity: Date.now(),
    lobbyWarnedAt: null,
    players: [{ token, socketId: socket.id, name, connected: true }],
    pendingRequests: [],
    state: null
  };

  rooms.set(code, room);
  socket.join(code);
  socket.data.roomCode = code;

  if (persistFn) persistFn();

  socket.emit("room_joined", {
    code,
    token,
    seatIndex: 0,
    name,
    isHost: true,
    room: safeRoom(room),
    state: null
  });

  return { room, code };
}

export function tryReconnectByName({ room, socket, name, persistFn, io, emitLobbyList, emitPendingRequests }) {
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
    room.pendingRequests = room.pendingRequests.filter(
      req => req.name.toLowerCase() !== cleanName.toLowerCase()
    );
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

  if (io) {
    io.to(room.code).emit("room_update", safeRoom(room));
    if (room.state) io.to(room.code).emit("state_update", room.state);
  }
  if (player.token === room.hostToken && emitPendingRequests) emitPendingRequests(room);
  if (emitLobbyList) emitLobbyList();
  if (persistFn) persistFn();
  return true;
}
