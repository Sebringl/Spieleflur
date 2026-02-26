// Wiederverwendbare Hilfsfunktionen.
import crypto from "crypto";
import { CODE_ALPHABET, CODE_LENGTH, DEFAULT_GAME_TYPE, DEFAULT_ROOM_GAME_TYPE, GAME_TYPES, ROOM_GAME_TYPES } from "./config.js";

export function makeCode(len = CODE_LENGTH) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

export function isValidCode(code, len = CODE_LENGTH) {
  if (!code || code.length !== len) return false;
  return [...code].every(ch => CODE_ALPHABET.includes(ch));
}

export function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

export function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

export function normalizeGameType(value) {
  const candidate = String(value || "").trim().toLowerCase();
  if (GAME_TYPES.has(candidate)) return candidate;
  return DEFAULT_GAME_TYPE;
}

export function normalizeRoomGameType(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return ROOM_GAME_TYPES.has(candidate) ? candidate : DEFAULT_ROOM_GAME_TYPE;
}

export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
