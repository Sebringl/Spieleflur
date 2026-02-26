// Zentrale Konfiguration und Konstanten für den Spieleflur-Server.

export const LOBBY_INACTIVITY_MS = 120 * 1000;
export const LOBBY_WARNING_MS = 30 * 1000;

export const ROOMS_FILE = "./rooms.json";
export const CODE_LENGTH = 5;
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const DEFAULT_GAME_TYPE = "classic";
export const GAME_TYPES = new Set(["classic", "quick"]);

export const DEFAULT_ROOM_GAME_TYPE = "schocken";
export const ROOM_GAME_TYPES = new Set(["schocken", "kniffel", "schwimmen", "skat", "kwyx", "schiffeversenken"]);

export const PORT = process.env.PORT || 3000;
