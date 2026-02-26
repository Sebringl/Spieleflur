// Persistenz-Schicht: Rooms auf Disk speichern und laden.
import fs from "fs/promises";
import { ROOMS_FILE } from "./config.js";
import { normalizeCode, normalizeRoomGameType } from "./utils.js";

export async function persistRooms(rooms) {
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

export async function loadRooms(rooms) {
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
        settings: {
          useDeckel: !!room.settings?.useDeckel,
          gameType: normalizeRoomGameType(room.settings?.gameType)
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
