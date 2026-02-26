// Spieleflur – Einstiegspunkt.
// Express liefert statische Dateien, Socket.IO sorgt für Echtzeit-Spielzüge.
import express from "express";
import http from "http";
import { Server } from "socket.io";

import { PORT } from "./src/config.js";
import { loadRooms, persistRooms } from "./src/persistence.js";
import { cleanupInactiveLobbies } from "./src/roomManager.js";
import { registerSocketHandlers } from "./src/socketHandlers.js";

// ---- HTTP / Express ----
const app = express();

app.use((req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.use(express.static("public"));
app.get("/ping", (req, res) => res.status(200).send("ok"));

// ---- Socket.IO ----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- In-Memory Rooms ----
const rooms = new Map();
const persist = () => persistRooms(rooms);

// ---- Initialisierung ----
await loadRooms(rooms);

registerSocketHandlers(io, rooms, persistRooms);

// Regelmäßig inaktive Lobbys aufräumen.
setInterval(() => {
  cleanupInactiveLobbies(rooms, io, { emit: true, persistFn: persist });
}, 5000);

// ---- Server starten ----
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Spieleflur läuft auf Port ${PORT}`);
});
