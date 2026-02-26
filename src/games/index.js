// Zentrale Fabrik-Funktion zum Starten aller Spieltypen.
import { initializeSchockenRoom } from "./schocken.js";
import { initializeKniffelRoom } from "./kniffel.js";
import { createSchwimmenState } from "./schwimmen.js";
import { createSkatState } from "./skat.js";
import { createKwyxState } from "./kwyx.js";

export function startNewGame(room) {
  const gameType = room.settings.gameType;
  const playerNames = room.players.map(p => p.name);

  switch (gameType) {
    case "kniffel":
      room.state = initializeKniffelRoom(room);
      break;
    case "schwimmen":
      room.state = createSchwimmenState(playerNames);
      break;
    case "skat":
      room.state = createSkatState(playerNames);
      break;
    case "kwyx":
      room.state = createKwyxState(playerNames);
      break;
    default:
      room.state = initializeSchockenRoom(room);
  }

  room.status = "running";
}

export function canAct(room, socketId) {
  const state = room.state;
  const seat = state.currentPlayer;
  const player = room.players[seat];
  if (!player) return { ok: false, error: "Aktueller Spieler existiert nicht." };
  if (player.socketId !== socketId) return { ok: false, error: "Du bist nicht am Zug." };
  return { ok: true };
}

export function getSeatIndexBySocket(room, socketId) {
  return room.players.findIndex(player => player.socketId === socketId);
}
