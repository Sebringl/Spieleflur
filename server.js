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

function normalizeRoomGameType(value) {
  const candidate = String(value || "").trim().toLowerCase();
  if (candidate === "kniffel") return "kniffel";
  if (candidate === "schwimmen") return "schwimmen";
  if (candidate === "skat") return "skat";
  if (candidate === "kwyx") return "kwyx";
  return "schocken";
}

// ---- Game State ----
// Initialzustand für Schocken (Würfelspiel).
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

// Kategorienliste für Kniffel.
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

// Initialzustand für Kniffel.
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

// Fisher-Yates zum Mischen eines Kartenstapels (Schwimmen).
function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Erzeugt und mischt das Schwimmen-Deck.
function createSchwimmenDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return shuffleDeck(deck);
}

function hasDuplicateSchwimmenCards(collections) {
  const seen = new Set();
  let total = 0;
  for (const cards of collections) {
    for (const card of cards) {
      if (!card) continue;
      total += 1;
      const key = `${card.rank}${card.suit}`;
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return total !== 32;
}

// Kartenwert für Schwimmen (A=11, Bildkarten=10).
function cardValue(rank) {
  if (rank === "A") return 11;
  if (["K", "Q", "J", "10"].includes(rank)) return 10;
  return Number(rank);
}

// Wertet eine Schwimmen-Hand aus.
function scoreSchwimmenHand(hand) {
  if (!hand || hand.length === 0) return 0;
  const ranks = hand.map(card => card.rank);
  if (ranks.every(rank => rank === "A")) return 33;
  if (ranks.every(rank => rank === ranks[0])) return 30.5;
  const suitTotals = {};
  hand.forEach(card => {
    suitTotals[card.suit] = (suitTotals[card.suit] || 0) + cardValue(card.rank);
  });
  return Math.max(...Object.values(suitTotals));
}

// Initialzustand für Schwimmen inkl. erster Runde.
function createSchwimmenState(players) {
  const state = {
    gameType: "schwimmen",
    players,
    currentPlayer: 0,
    deck: [],
    hands: [],
    tableCards: [],
    passCount: 0,
    knockedBy: null,
    lastTurnsRemaining: null,
    finished: false,
    scores: [],
    message: "",
    roundNumber: 1,
    lives: players.map(() => 3),
    eliminated: players.map(() => false),
    history: [],
    fireResolved: false,
    roundPending: false,
    nextStartingSeat: null
  };
  setupSchwimmenRound(state, { resetScores: true });
  return state;
}

function createSkatDeck() {
  const suits = ["♣", "♠", "♥", "♦"];
  const ranks = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return shuffleDeck(deck);
}

const SKAT_BID_VALUES = [
  18, 20, 22, 23, 24, 27, 30, 33, 35, 36, 40, 44, 45, 46, 48, 50, 54, 55, 59, 60,
  63, 66, 70, 72, 77, 80, 81, 84, 88, 90, 96, 99, 100, 108, 110, 120, 121, 126, 132,
  135, 144, 150, 153, 160, 162, 168, 176, 180, 187, 192, 198, 204, 216, 220, 240, 264
];

const SKAT_BASE_VALUES = {
  "♣": 12,
  "♠": 11,
  "♥": 10,
  "♦": 9,
  grand: 24
};

const SKAT_EYE_VALUES = {
  A: 11,
  "10": 10,
  K: 4,
  Q: 3,
  J: 2,
  "9": 0,
  "8": 0,
  "7": 0
};

const SKAT_NULL_VALUES = {
  normal: 23,
  hand: 35,
  ouvert: 46,
  handOuvert: 59
};

function dealSkatHands(players) {
  const deck = createSkatDeck();
  const hands = players.map(() => deck.splice(0, 10));
  const skat = deck.splice(0, 2);
  return { hands, skat };
}

function getSkatRankValue(rank, { nullGame } = {}) {
  if (nullGame) {
    const order = ["7", "8", "9", "10", "J", "Q", "K", "A"];
    return order.indexOf(rank);
  }
  const order = ["7", "8", "9", "Q", "K", "10", "A"];
  return order.indexOf(rank);
}

function isSkatTrump(card, game) {
  if (!card || !game) return false;
  if (game.type === "null") return false;
  if (card.rank === "J") return true;
  if (game.type === "suit") {
    return card.suit === game.suit;
  }
  return false;
}

function getSkatTrickRank(card, game, leadSuit) {
  if (!card) return -1;
  if (game.type === "null") {
    const order = ["7", "8", "9", "10", "J", "Q", "K", "A"];
    if (leadSuit && card.suit !== leadSuit) return -1;
    return order.indexOf(card.rank);
  }
  if (isSkatTrump(card, game)) {
    if (card.rank === "J") {
      const jackOrder = ["♣", "♠", "♥", "♦"];
      return 100 + (jackOrder.length - jackOrder.indexOf(card.suit));
    }
    const trumpOrder = ["7", "8", "9", "Q", "K", "10", "A"];
    return 50 + trumpOrder.indexOf(card.rank);
  }
  if (leadSuit === "trump" && isSkatTrump(card, game)) {
    if (card.rank === "J") {
      const jackOrder = ["♣", "♠", "♥", "♦"];
      return 100 + (jackOrder.length - jackOrder.indexOf(card.suit));
    }
    const trumpOrder = ["7", "8", "9", "Q", "K", "10", "A"];
    return 50 + trumpOrder.indexOf(card.rank);
  }
  if (leadSuit && leadSuit !== "trump" && card.suit === leadSuit) {
    return getSkatRankValue(card.rank);
  }
  return -1;
}

function getSkatLeadSuit(card, game) {
  if (!card) return null;
  if (game.type !== "null" && isSkatTrump(card, game)) {
    return "trump";
  }
  return card.suit;
}

function determineSkatTrickWinner(trick, leadSuit, game) {
  let bestIndex = 0;
  let bestValue = -1;
  trick.forEach((play, index) => {
    if (!play.card) return;
    const value = getSkatTrickRank(play.card, game, leadSuit);
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  });
  return trick[bestIndex]?.seat ?? trick[0]?.seat ?? 0;
}

function getSkatCardPoints(card) {
  return SKAT_EYE_VALUES[card?.rank] ?? 0;
}

function countSkatTrumps(cards, game) {
  return cards.filter(card => isSkatTrump(card, game)).length;
}

function getSkatMatadors(cards, game) {
  if (game.type === "null") return 0;
  const topTrumps = [
    { suit: "♣", rank: "J" },
    { suit: "♠", rank: "J" },
    { suit: "♥", rank: "J" },
    { suit: "♦", rank: "J" }
  ];
  let count = 0;
  for (const jack of topTrumps) {
    const hasJack = cards.some(card => card.suit === jack.suit && card.rank === jack.rank);
    if (hasJack) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function calculateSkatGameValue({ game, cards, hand, schneider, schwarz, ouvert }) {
  if (game.type === "null") {
    if (hand && ouvert) return SKAT_NULL_VALUES.handOuvert;
    if (hand) return SKAT_NULL_VALUES.hand;
    if (ouvert) return SKAT_NULL_VALUES.ouvert;
    return SKAT_NULL_VALUES.normal;
  }
  const base = game.type === "grand" ? SKAT_BASE_VALUES.grand : SKAT_BASE_VALUES[game.suit];
  const matadors = getSkatMatadors(cards, game);
  let multiplier = 1 + matadors;
  if (hand) multiplier += 1;
  if (schneider) multiplier += 1;
  if (schwarz) multiplier += 1;
  if (ouvert) multiplier += 1;
  return base * multiplier;
}

function initializeSkatBidding(state) {
  const dealerSeat = state.dealerSeat;
  const forehand = (dealerSeat + 1) % state.players.length;
  const middlehand = (dealerSeat + 2) % state.players.length;
  const rearhand = dealerSeat;
  state.forehand = forehand;
  state.middlehand = middlehand;
  state.rearhand = rearhand;
  state.phase = "bidding";
  state.bidding = {
    stage: "forehand_middlehand",
    bidder: forehand,
    listener: middlehand,
    currentBidIndex: -1,
    pendingBidIndex: null,
    highestBidIndex: -1,
    highestBidder: null,
    passed: state.players.map(() => false),
    waitingFor: "bidder"
  };
  state.currentPlayer = forehand;
  state.message = `${state.players[forehand]} reizt ${state.players[middlehand]}.`;
}

function concludeSkatBidding(state) {
  const highestBidIndex = state.bidding.highestBidIndex;
  if (highestBidIndex < 0 || state.bidding.highestBidder === null) {
    state.finished = true;
    state.message = "Alle passen. Skat-Runde endet ohne Spiel.";
    return;
  }
  state.declarer = state.bidding.highestBidder;
  state.highestBid = SKAT_BID_VALUES[highestBidIndex];
  state.phase = "skat";
  state.currentPlayer = state.declarer;
  state.message = `${state.players[state.declarer]} gewinnt das Reizen (${state.highestBid}) und nimmt den Skat.`;
}

function advanceSkatBidding(state) {
  const bidding = state.bidding;
  if (bidding.stage === "forehand_middlehand") {
    if (!bidding.passed[bidding.listener] && !bidding.passed[bidding.bidder]) return;
    let winner = bidding.bidder;
    if (bidding.passed[bidding.bidder]) winner = bidding.listener;
    if (bidding.passed[bidding.listener]) winner = bidding.bidder;
    bidding.stage = "winner_rearhand";
    bidding.bidder = winner;
    bidding.listener = state.rearhand;
    if (bidding.currentBidIndex >= 0) {
      bidding.pendingBidIndex = bidding.currentBidIndex;
      bidding.waitingFor = "listener";
      state.currentPlayer = bidding.listener;
      state.message = `${state.players[bidding.listener]}: hältst du ${SKAT_BID_VALUES[bidding.currentBidIndex]}?`;
    } else {
      bidding.pendingBidIndex = null;
      bidding.waitingFor = "bidder";
      state.currentPlayer = bidding.bidder;
      state.message = `${state.players[bidding.bidder]} reizt ${state.players[bidding.listener]}.`;
    }
    return;
  }
  if (bidding.stage === "winner_rearhand") {
    if (bidding.passed[bidding.listener]) {
      concludeSkatBidding(state);
      return;
    }
    if (bidding.passed[bidding.bidder]) {
      if (bidding.currentBidIndex >= 0) {
        bidding.highestBidder = bidding.listener;
        bidding.highestBidIndex = bidding.currentBidIndex;
      } else {
        bidding.highestBidder = null;
        bidding.highestBidIndex = -1;
      }
      concludeSkatBidding(state);
    }
  }
}

function createSkatState(players) {
  const { hands, skat } = dealSkatHands(players);
  const state = {
    gameType: "skat",
    players,
    currentPlayer: 0,
    hands,
    skat,
    skatPile: [],
    skatTaken: false,
    discarded: false,
    dealerSeat: 0,
    forehand: 0,
    middlehand: 0,
    rearhand: 0,
    phase: "bidding",
    bidding: null,
    declarer: null,
    highestBid: null,
    game: null,
    trickPoints: players.map(() => 0),
    currentTrick: [],
    leadSuit: null,
    trickNumber: 1,
    trickWinners: [],
    finished: false,
    message: ""
  };
  initializeSkatBidding(state);
  return state;
}

const KWYX_ROWS = ["red", "yellow", "green", "blue"];
const KWYX_NUMBERS = {
  red: Array.from({ length: 11 }, (_, i) => i + 2),
  yellow: Array.from({ length: 11 }, (_, i) => i + 2),
  green: Array.from({ length: 11 }, (_, i) => 12 - i),
  blue: Array.from({ length: 11 }, (_, i) => 12 - i)
};

function createKwyxCard() {
  return {
    red: Array(11).fill(false),
    yellow: Array(11).fill(false),
    green: Array(11).fill(false),
    blue: Array(11).fill(false),
    locks: {
      red: false,
      yellow: false,
      green: false,
      blue: false
    },
    strikes: 0
  };
}

function createKwyxState(players) {
  return {
    gameType: "kwyx",
    players,
    currentPlayer: 0,
    dice: [null, null, null, null, null, null],
    throwCount: 0,
    maxThrowsThisRound: 1,
    scorecards: players.map(() => createKwyxCard()),
    rowLocks: {
      red: false,
      yellow: false,
      green: false,
      blue: false
    },
    totals: players.map(() => 0),
    finished: false,
    message: ""
  };
}

function getKwyxRowIndex(color, value) {
  const numbers = KWYX_NUMBERS[color];
  if (!numbers) return -1;
  return numbers.indexOf(value);
}

function countKwyxMarks(row) {
  return row.reduce((acc, marked) => acc + (marked ? 1 : 0), 0);
}

function canMarkKwyxRow(state, card, color, value) {
  if (!KWYX_ROWS.includes(color)) {
    return { ok: false, error: "Unbekannte Reihe." };
  }
  if (state.rowLocks[color]) {
    return { ok: false, error: "Diese Reihe ist gesperrt." };
  }
  const index = getKwyxRowIndex(color, value);
  if (index < 0) {
    return { ok: false, error: "Ungültiger Wert." };
  }
  const row = card[color];
  if (row[index]) {
    return { ok: false, error: "Dieses Feld ist bereits markiert." };
  }
  const lastIndex = row.reduce((acc, marked, idx) => (marked ? Math.max(acc, idx) : acc), -1);
  if (lastIndex >= 0 && index <= lastIndex) {
    return { ok: false, error: "Du musst weiter rechts markieren." };
  }
  const isLastField = index === KWYX_NUMBERS[color].length - 1;
  if (isLastField) {
    const marks = countKwyxMarks(row);
    if (marks < 5) {
      return { ok: false, error: "Zum Schließen brauchst du mindestens 5 Kreuze." };
    }
  }
  return { ok: true, index, isLastField };
}

function scoreKwyxCard(card) {
  const rowScore = color => {
    const marks = countKwyxMarks(card[color]);
    const lockBonus = card.locks?.[color] ? 1 : 0;
    return (marks * (marks + 1)) / 2 + lockBonus;
  };
  const totalRows = KWYX_ROWS.reduce((acc, color) => acc + rowScore(color), 0);
  return totalRows - card.strikes * 5;
}

function updateKwyxTotals(state) {
  state.totals = state.scorecards.map(card => scoreKwyxCard(card));
}

// Aktive (nicht eliminierte) Sitzplätze in Schwimmen.
function getActiveSchwimmenSeats(state) {
  return state.players
    .map((_, i) => i)
    .filter(i => !state.eliminated?.[i]);
}

// Nächster aktiver Sitzplatz im Uhrzeigersinn.
function getNextActiveSchwimmenSeat(state, fromSeat) {
  const total = state.players.length;
  for (let offset = 1; offset <= total; offset++) {
    const seat = (fromSeat + offset) % total;
    if (!state.eliminated?.[seat]) return seat;
  }
  return fromSeat;
}

// Richtet eine neue Schwimmen-Runde ein.
function setupSchwimmenRound(state, { startingSeat, resetScores = false } = {}) {
  let deck = [];
  let hands = [];
  let tableCards = [];
  let attempts = 0;
  do {
    deck = createSchwimmenDeck();
    hands = state.players.map((_, seat) => {
      if (state.eliminated?.[seat]) return [];
      return deck.splice(0, 3);
    });
    tableCards = deck.splice(0, 3);
    attempts += 1;
  } while (hasDuplicateSchwimmenCards([deck, ...hands, tableCards]) && attempts < 5);

  state.deck = deck;
  state.hands = hands;
  state.tableCards = tableCards;
  state.passCount = 0;
  state.knockedBy = null;
  state.lastTurnsRemaining = null;
  state.finished = false;
  state.fireResolved = false;
  state.roundPending = false;
  state.nextStartingSeat = null;
  state.message = "";
  if (resetScores) {
    state.scores = [];
  }
  state.currentPlayer = typeof startingSeat === "number"
    ? startingSeat
    : (getActiveSchwimmenSeats(state)[0] ?? 0);
}

// Startet die nächste Runde mit dem gemerkten Startspieler.
function startSchwimmenNextRound(state) {
  const startSeat = typeof state.nextStartingSeat === "number"
    ? state.nextStartingSeat
    : (getActiveSchwimmenSeats(state)[0] ?? 0);
  setupSchwimmenRound(state, { startingSeat: startSeat });
}

// Erneuert die Tischkarten (Schwimmen).
function refreshSchwimmenTable(state) {
  if (state.deck.length < 3) {
    state.message = "Alle schieben – nicht genug Karten zum Erneuern.";
    state.passCount = 0;
    return;
  }
  state.tableCards = state.deck.splice(0, 3);
  state.message = "Alle schieben – Tischkarten wurden erneuert.";
  state.passCount = 0;
}

// Verliert ein Leben oder wird eliminiert (Schwimmen).
function applySchwimmenLifeLoss(state, seat) {
  if (state.lives[seat] > 0) {
    state.lives[seat] -= 1;
    return { swimmingNow: state.lives[seat] === 0 };
  }
  state.eliminated[seat] = true;
  return { eliminatedNow: true };
}

// Spezialregel "Feuer" (drei Asse) für Schwimmen.
function handleSchwimmenFeuer(state, seat) {
  if (state.finished || state.fireResolved) return false;
  const hand = state.hands?.[seat];
  if (!hand || hand.length !== 3) return false;
  if (!hand.every(card => card.rank === "A")) return false;

  state.fireResolved = true;

  const activeSeats = getActiveSchwimmenSeats(state).filter(i => i !== seat);
  const swimmingNow = [];
  const eliminatedNow = [];

  activeSeats.forEach(otherSeat => {
    const result = applySchwimmenLifeLoss(state, otherSeat);
    if (result?.swimmingNow) swimmingNow.push(otherSeat);
    if (result?.eliminatedNow) eliminatedNow.push(otherSeat);
  });

  let message = `Feuer! ${state.players[seat]} deckt drei Asse auf. Alle anderen verlieren ein Leben.`;
  if (swimmingNow.length) {
    message += ` ${swimmingNow.map(i => state.players[i]).join(", ")} schwimmt jetzt.`;
  }
  if (eliminatedNow.length) {
    message += ` ${eliminatedNow.map(i => state.players[i]).join(", ")} geht unter.`;
  }

  state.history.push(state.players.map((_, i) => ({
    score: scoreSchwimmenHand(state.hands[i]),
    lives: state.lives[i],
    eliminated: state.eliminated[i],
    swimming: state.lives[i] === 0 && !state.eliminated[i]
  })));
  state.roundNumber += 1;

  const remaining = getActiveSchwimmenSeats(state);
  if (remaining.length <= 1) {
    const winnerSeat = remaining[0];
    state.finished = true;
    state.message = winnerSeat !== undefined
      ? `${message} Gesamtsieger: ${state.players[winnerSeat]}.`
      : message;
    return true;
  }

  const startSeat = getNextActiveSchwimmenSeat(state, seat);
  state.roundPending = true;
  state.nextStartingSeat = startSeat;
  state.currentPlayer = startSeat;
  state.message = message;
  return true;
}

// Beendet eine Schwimmen-Runde und verarbeitet Leben/Eliminierung.
function finishSchwimmenRound(state) {
  const activeSeats = getActiveSchwimmenSeats(state);
  if (activeSeats.length <= 1) {
    const winnerSeat = activeSeats[0];
    state.finished = true;
    state.message = winnerSeat !== undefined
      ? `Schwimmen beendet. Gesamtsieger: ${state.players[winnerSeat]}.`
      : "Schwimmen beendet.";
    return;
  }

  state.scores = state.players.map((_, i) => {
    if (state.eliminated?.[i]) return null;
    return scoreSchwimmenHand(state.hands[i]);
  });
  const activeScores = activeSeats.map(i => state.scores[i]);
  const maxScore = Math.max(...activeScores);
  const minScore = Math.min(...activeScores);
  const winners = activeSeats.filter(i => state.scores[i] === maxScore);
  const losers = activeSeats.filter(i => state.scores[i] === minScore);

  const eliminatedNow = [];
  const swimmingNow = [];

  losers.forEach(seat => {
    if (state.lives[seat] > 0) {
      state.lives[seat] -= 1;
      if (state.lives[seat] === 0) {
        swimmingNow.push(seat);
      }
    } else {
      state.eliminated[seat] = true;
      eliminatedNow.push(seat);
    }
  });

  const winnerNames = winners.map(i => state.players[i]).join(", ");
  const loserNames = losers.map(i => state.players[i]).join(", ");
  let message = `Runde ${state.roundNumber} beendet. Gewinner: ${winnerNames} (${maxScore} Punkte). Verlierer: ${loserNames} (${minScore} Punkte).`;
  if (swimmingNow.length) {
    message += ` ${swimmingNow.map(i => state.players[i]).join(", ")} schwimmt jetzt.`;
  }
  if (eliminatedNow.length) {
    message += ` ${eliminatedNow.map(i => state.players[i]).join(", ")} geht unter.`;
  }

  state.message = message;
  state.history.push(state.players.map((_, i) => ({
    score: state.scores[i],
    lives: state.lives[i],
    eliminated: state.eliminated[i],
    swimming: state.lives[i] === 0 && !state.eliminated[i]
  })));
  state.roundNumber += 1;

  const remaining = getActiveSchwimmenSeats(state);
  if (remaining.length <= 1) {
    const winnerSeat = remaining[0];
    state.finished = true;
    state.message += winnerSeat !== undefined
      ? ` Gesamtsieger: ${state.players[winnerSeat]}.`
      : "";
    return;
  }

  const preferredStartSeat = losers[0];
  const startSeat = (preferredStartSeat !== undefined && !state.eliminated?.[preferredStartSeat])
    ? preferredStartSeat
    : getNextActiveSchwimmenSeat(state, preferredStartSeat ?? state.currentPlayer);
  state.roundPending = true;
  state.nextStartingSeat = startSeat;
  state.currentPlayer = startSeat;
}

// Beendet einen Zug in Schwimmen (inkl. Klopfen-Logik).
function endSchwimmenTurn(state, { knocked } = { knocked: false }) {
  if (state.finished) return;
  const currentSeat = state.currentPlayer;
  const activeSeats = getActiveSchwimmenSeats(state);
  if (knocked && state.knockedBy === null) {
    state.knockedBy = currentSeat;
    state.lastTurnsRemaining = activeSeats.length - 1;
  } else if (state.knockedBy !== null && currentSeat !== state.knockedBy) {
    state.lastTurnsRemaining = Math.max(0, (state.lastTurnsRemaining ?? 0) - 1);
    if (state.lastTurnsRemaining <= 0) {
      finishSchwimmenRound(state);
      return;
    }
  }
  state.currentPlayer = getNextActiveSchwimmenSeat(state, currentSeat);
}

// Gemeinsamer Helfer für Würfelspiele: Würfel/Weitermachen zurücksetzen.
function resetDiceState(state, diceCount) {
  state.throwCount = 0;
  state.dice = Array(diceCount).fill(null);
  state.held = Array(diceCount).fill(false);
}

// Setzt den Schocken-Zugzustand zurück.
function resetTurn(state) {
  resetDiceState(state, 3);
  state.convertible = [false, false, false];
  state.convertedThisTurn = false;
  state.convertedCount = 0;
  state.maxConvertibleThisTurn = 0;
}

// 6-zu-1-Regel im Schocken manuell anwenden.
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

// Setzt den Kniffel-Zugzustand zurück.
function resetKniffelTurn(state) {
  resetDiceState(state, 5);
}

// Bewertet einen Kniffel-Wurf für eine Kategorie.
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
    case "yahtzee": return { score: hasN(5) ? 50 : 0, label: "Yahtzee" };
    case "chance": return { score: sum, label: "Chance" };
    default: return { score: 0, label: "Unbekannt" };
  }
}

// Bewertet einen Schocken-Wurf (Rangfolge, Wurfanzahl etc.).
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
  } else if (room.settings.gameType === "schwimmen") {
    room.state = createSchwimmenState(room.players.map(p => p.name));
  } else if (room.settings.gameType === "skat") {
    room.state = createSkatState(room.players.map(p => p.name));
  } else if (room.settings.gameType === "kwyx") {
    room.state = createKwyxState(room.players.map(p => p.name));
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
  const nextGameType = normalizeRoomGameType(gameType);
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
  const normalizedGameType = normalizeRoomGameType(gameType);
  const room = {
    code,
    status: "lobby",
    settings: { useDeckel: normalizedGameType === "schocken" ? !!useDeckel : false, gameType: normalizedGameType },
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
    if (room.settings.gameType === "skat" && room.players.length !== 3) {
      return socket.emit("error_msg", { message: "Skat benötigt genau 3 Spieler." });
    }
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

  socket.on("skat_bid", ({ code, value }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;
    const state = room.state;
    if (!state || state.gameType !== "skat" || state.phase !== "bidding") return;
    if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const bidding = state.bidding;
    if (!bidding || bidding.waitingFor !== "bidder") {
      return socket.emit("error_msg", { message: "Du bist nicht am Reizen." });
    }
    if (state.currentPlayer !== bidding.bidder) {
      return socket.emit("error_msg", { message: "Du bist nicht der Reizende." });
    }

    const bidValue = Number(value);
    const bidIndex = SKAT_BID_VALUES.indexOf(bidValue);
    if (bidIndex < 0) {
      return socket.emit("error_msg", { message: "Ungültiger Reizwert." });
    }
    if (bidIndex <= bidding.currentBidIndex) {
      return socket.emit("error_msg", { message: "Der Reizwert muss höher sein." });
    }

    bidding.pendingBidIndex = bidIndex;
    bidding.waitingFor = "listener";
    state.currentPlayer = bidding.listener;
    state.message = `${state.players[bidding.bidder]} reizt ${bidValue}.`;

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("skat_hold", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;
    const state = room.state;
    if (!state || state.gameType !== "skat" || state.phase !== "bidding") return;
    if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const bidding = state.bidding;
    if (!bidding || bidding.waitingFor !== "listener") {
      return socket.emit("error_msg", { message: "Du kannst gerade nicht halten." });
    }
    if (state.currentPlayer !== bidding.listener) {
      return socket.emit("error_msg", { message: "Du bist nicht der Antwortende." });
    }
    if (bidding.pendingBidIndex === null) {
      return socket.emit("error_msg", { message: "Kein Reizwert offen." });
    }

    bidding.currentBidIndex = bidding.pendingBidIndex;
    bidding.highestBidIndex = bidding.pendingBidIndex;
    bidding.highestBidder = bidding.bidder;
    bidding.pendingBidIndex = null;
    bidding.waitingFor = "bidder";
    state.currentPlayer = bidding.bidder;
    state.message = `${state.players[bidding.listener]} hält ${SKAT_BID_VALUES[bidding.currentBidIndex]}.`;

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("skat_pass", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;
    const state = room.state;
    if (!state || state.gameType !== "skat" || state.phase !== "bidding") return;
    if (state.finished) return socket.emit("error_msg", { message: "Spiel ist beendet." });

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const bidding = state.bidding;
    if (!bidding) return;
    const actor = state.currentPlayer;
    if (bidding.waitingFor === "listener" && actor !== bidding.listener) {
      return socket.emit("error_msg", { message: "Du kannst gerade nicht passen." });
    }
    if (bidding.waitingFor === "bidder" && actor !== bidding.bidder) {
      return socket.emit("error_msg", { message: "Du kannst gerade nicht passen." });
    }

    bidding.passed[actor] = true;
    if (bidding.waitingFor === "listener") {
      bidding.currentBidIndex = bidding.pendingBidIndex ?? bidding.currentBidIndex;
      bidding.highestBidIndex = bidding.currentBidIndex;
      bidding.highestBidder = bidding.bidder;
      bidding.pendingBidIndex = null;
    } else {
      if (bidding.currentBidIndex < 0) {
        bidding.highestBidIndex = -1;
        bidding.highestBidder = null;
      } else {
        bidding.highestBidIndex = bidding.currentBidIndex;
        bidding.highestBidder = bidding.listener;
      }
    }
    state.message = `${state.players[actor]} passt.`;
    advanceSkatBidding(state);

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("skat_take_skat", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;
    const state = room.state;
    if (!state || state.gameType !== "skat" || state.phase !== "skat") return;
    if (state.declarer === null) return;
    if (state.skatTaken) {
      return socket.emit("error_msg", { message: "Skat wurde bereits aufgenommen." });
    }
    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });
    if (state.currentPlayer !== state.declarer) {
      return socket.emit("error_msg", { message: "Nur der Alleinspieler darf den Skat nehmen." });
    }

    state.hands[state.declarer] = state.hands[state.declarer].concat(state.skat);
    state.skat = [];
    state.skatTaken = true;
    state.message = `${state.players[state.declarer]} nimmt den Skat und legt ab.`;

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("skat_discard", ({ code, cards }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;
    const state = room.state;
    if (!state || state.gameType !== "skat" || state.phase !== "skat") return;
    if (!state.skatTaken) {
      return socket.emit("error_msg", { message: "Skat wurde noch nicht aufgenommen." });
    }
    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });
    if (state.currentPlayer !== state.declarer) {
      return socket.emit("error_msg", { message: "Nur der Alleinspieler darf abwerfen." });
    }
    const discardCards = Array.isArray(cards) ? cards : [];
    if (discardCards.length !== 2) {
      return socket.emit("error_msg", { message: "Du musst genau zwei Karten abwerfen." });
    }
    const hand = state.hands[state.declarer] || [];
    const removed = [];
    discardCards.forEach(card => {
      const index = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
      if (index >= 0) {
        removed.push(hand.splice(index, 1)[0]);
      }
    });
    if (removed.length !== 2) {
      return socket.emit("error_msg", { message: "Abwurfkarten nicht gefunden." });
    }
    state.skatPile = removed;
    state.discarded = true;
    state.message = `${state.players[state.declarer]} hat abgeworfen und wählt das Spiel.`;

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("skat_choose_game", ({ code, type, suit, hand }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;
    const state = room.state;
    if (!state || state.gameType !== "skat" || state.phase !== "skat") return;
    if (state.declarer === null) return;
    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });
    if (state.currentPlayer !== state.declarer) {
      return socket.emit("error_msg", { message: "Nur der Alleinspieler darf das Spiel wählen." });
    }
    const gameType = String(type || "").toLowerCase();
    const wantsHand = Boolean(hand);
    if (wantsHand && state.skatTaken) {
      return socket.emit("error_msg", { message: "Handspiel ohne Skataufnahme." });
    }
    if (!wantsHand && state.skatTaken && !state.discarded) {
      return socket.emit("error_msg", { message: "Bitte zuerst zwei Karten abwerfen." });
    }
    if (gameType === "suit") {
      if (!["♣", "♠", "♥", "♦"].includes(suit)) {
        return socket.emit("error_msg", { message: "Ungültige Trumpffarbe." });
      }
    } else if (gameType !== "grand" && gameType !== "null") {
      return socket.emit("error_msg", { message: "Ungültige Spielart." });
    }

    const game = {
      type: gameType,
      suit: gameType === "suit" ? suit : null,
      hand: wantsHand,
      ouvert: false
    };

    const matadorCards = state.hands[state.declarer].concat(state.skatTaken ? state.skatPile : []);
    const baseValue = calculateSkatGameValue({
      game,
      cards: matadorCards,
      hand: wantsHand,
      schneider: false,
      schwarz: false,
      ouvert: false
    });

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
    persistRooms();
  });

  socket.on("skat_play_card", ({ code, card }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const state = room.state;
    if (!state || state.gameType !== "skat") return;
    if (state.phase !== "playing") {
      return socket.emit("error_msg", { message: "Skat ist noch nicht im Stichspiel." });
    }
    if (state.finished) {
      return socket.emit("error_msg", { message: "Spiel ist beendet." });
    }

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const suit = String(card?.suit || "");
    const rank = String(card?.rank || "");
    if (!suit || !rank) {
      return socket.emit("error_msg", { message: "Ungültige Karte." });
    }

    const hand = state.hands[state.currentPlayer] || [];
    const cardIndex = hand.findIndex(c => c.suit === suit && c.rank === rank);
    if (cardIndex < 0) {
      return socket.emit("error_msg", { message: "Karte nicht auf der Hand." });
    }

    const game = state.game;
    if (!game) return socket.emit("error_msg", { message: "Spielart fehlt." });
    if (state.leadSuit) {
      if (state.leadSuit === "trump") {
        const hasTrump = hand.some(c => isSkatTrump(c, game));
        if (hasTrump && !isSkatTrump({ suit, rank }, game)) {
          return socket.emit("error_msg", { message: "Du musst Trumpf bedienen." });
        }
      } else {
        const hasLeadSuit = hand.some(c => c.suit === state.leadSuit && !isSkatTrump(c, game));
        if (hasLeadSuit && (suit !== state.leadSuit || isSkatTrump({ suit, rank }, game))) {
          return socket.emit("error_msg", { message: "Du musst Farbe bedienen." });
        }
      }
    }

    const playedCard = hand.splice(cardIndex, 1)[0];
    if (!state.leadSuit) {
      state.leadSuit = getSkatLeadSuit(playedCard, game);
    }
    state.currentTrick.push({ seat: state.currentPlayer, card: playedCard });
    state.message = `${state.players[state.currentPlayer]} spielt ${playedCard.rank}${playedCard.suit}.`;

    if (state.currentTrick.length >= 3) {
      const winnerSeat = determineSkatTrickWinner(state.currentTrick, state.leadSuit, game);
      const trickPoints = state.currentTrick.reduce((sum, play) => sum + getSkatCardPoints(play.card), 0);
      if (game.type !== "null") {
        state.trickPoints[winnerSeat] += trickPoints;
      }
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
          const nullValue = calculateSkatGameValue({
            game,
            cards: [],
            hand: state.game?.hand,
            schneider: false,
            schwarz: false,
            ouvert: false
          });
          state.game.result = {
            declarerTricks,
            won: declarerWins,
            value: declarerWins ? nullValue : -nullValue
          };
          state.message = declarerWins
            ? `${state.players[state.declarer]} gewinnt Null. Wert: ${nullValue}.`
            : `${state.players[state.declarer]} verliert Null. Wert: ${nullValue}.`;
        } else {
          const totalPoints = state.trickPoints.reduce((sum, value) => sum + value, 0);
          const skatPoints = state.skatPile.reduce((sum, card) => sum + getSkatCardPoints(card), 0);
          const declarerPoints = (state.trickPoints[state.declarer] || 0) + skatPoints;
          const defendersPoints = totalPoints - (state.trickPoints[state.declarer] || 0);
          const declarerWon = declarerPoints >= 61;
          const schneider = declarerPoints >= 90 || defendersPoints <= 30;
          const schwarz = state.trickWinners.every(seat => seat === state.declarer);
          const cardsForValue = state.hands[state.declarer].concat(state.skatPile);
          const gameValue = calculateSkatGameValue({
            game,
            cards: cardsForValue,
            hand: state.game?.hand,
            schneider,
            schwarz,
            ouvert: false
          });
          state.game.result = {
            declarerPoints,
            defendersPoints,
            schneider,
            schwarz,
            won: declarerWon,
            value: declarerWon ? gameValue : -gameValue
          };
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
    persistRooms();
  });

  socket.on("schwimmen_swap", ({ code, handIndex, tableIndex }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;
    if (state.gameType !== "schwimmen") return;
    if (state.finished) {
      return socket.emit("error_msg", { message: "Spiel ist beendet." });
    }
    if (state.roundPending) {
      return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
    }

    const hIndex = Number(handIndex);
    const tIndex = Number(tableIndex);
    if (![0, 1, 2].includes(hIndex) || ![0, 1, 2].includes(tIndex)) {
      return socket.emit("error_msg", { message: "Ungültige Kartenwahl." });
    }
    const hand = state.hands[state.currentPlayer];
    if (!hand || !hand[hIndex] || !state.tableCards[tIndex]) {
      return socket.emit("error_msg", { message: "Ungültige Kartenwahl." });
    }

    const temp = hand[hIndex];
    hand[hIndex] = state.tableCards[tIndex];
    state.tableCards[tIndex] = temp;
    state.passCount = 0;
    state.message = `${state.players[state.currentPlayer]} tauscht eine Karte.`;
    if (handleSchwimmenFeuer(state, state.currentPlayer)) {
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }
    endSchwimmenTurn(state);

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("schwimmen_swap_all", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;
    if (state.gameType !== "schwimmen") return;
    if (state.finished) {
      return socket.emit("error_msg", { message: "Spiel ist beendet." });
    }
    if (state.roundPending) {
      return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
    }

    const hand = state.hands[state.currentPlayer];
    if (!hand || hand.length !== 3 || state.tableCards.length !== 3) {
      return socket.emit("error_msg", { message: "Karten fehlen." });
    }

    const temp = hand.slice();
    state.hands[state.currentPlayer] = state.tableCards.slice();
    state.tableCards = temp;
    state.passCount = 0;
    state.message = `${state.players[state.currentPlayer]} tauscht alle Karten.`;
    if (handleSchwimmenFeuer(state, state.currentPlayer)) {
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }
    endSchwimmenTurn(state);

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("schwimmen_pass", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;
    if (state.gameType !== "schwimmen") return;
    if (state.finished) {
      return socket.emit("error_msg", { message: "Spiel ist beendet." });
    }
    if (state.roundPending) {
      return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
    }

    state.passCount += 1;
    state.message = `${state.players[state.currentPlayer]} schiebt.`;
    const activeCount = getActiveSchwimmenSeats(state).length;
    if (state.passCount >= activeCount) {
      refreshSchwimmenTable(state);
    }
    if (handleSchwimmenFeuer(state, state.currentPlayer)) {
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }
    endSchwimmenTurn(state);

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("schwimmen_knock", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const check = canAct(room, socket.id);
    if (!check.ok) return socket.emit("error_msg", { message: check.error });

    const state = room.state;
    if (state.gameType !== "schwimmen") return;
    if (state.finished) {
      return socket.emit("error_msg", { message: "Spiel ist beendet." });
    }
    if (state.roundPending) {
      return socket.emit("error_msg", { message: "Runde ist beendet. Bitte neue Runde starten." });
    }
    if (state.knockedBy !== null) {
      return socket.emit("error_msg", { message: "Es wurde bereits geklopft." });
    }

    state.passCount = 0;
    state.message = `${state.players[state.currentPlayer]} klopft.`;
    if (handleSchwimmenFeuer(state, state.currentPlayer)) {
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }
    endSchwimmenTurn(state, { knocked: true });

    io.to(room.code).emit("state_update", state);
    persistRooms();
  });

  socket.on("schwimmen_start_round", ({ code }) => {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.status !== "running") return;

    const state = room.state;
    if (state.gameType !== "schwimmen") return;
    if (state.finished) {
      return socket.emit("error_msg", { message: "Spiel ist beendet." });
    }
    if (!state.roundPending) {
      return socket.emit("error_msg", { message: "Runde läuft bereits." });
    }

    const seatIndex = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIndex < 0) return;
    const player = room.players[seatIndex];
    const isHost = player?.token === room.hostToken;
    if (typeof state.nextStartingSeat === "number" && seatIndex !== state.nextStartingSeat && !isHost) {
      return socket.emit("error_msg", { message: "Nur der Verlierer darf die nächste Runde starten." });
    }

    startSchwimmenNextRound(state);
    io.to(room.code).emit("state_update", state);
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
    if (state.gameType === "kwyx") {
      if (state.finished) {
        return socket.emit("error_msg", { message: "Spiel ist beendet." });
      }
      if (state.throwCount >= state.maxThrowsThisRound) {
        return socket.emit("error_msg", { message: "Du hast bereits gewürfelt." });
      }
      state.dice = [rollDie(), rollDie(), rollDie(), rollDie(), rollDie(), rollDie()];
      state.throwCount = 1;
      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }
    if (state.gameType === "schwimmen") {
      return socket.emit("error_msg", { message: "Diese Aktion ist in Schwimmen nicht verfügbar." });
    }
    if (state.gameType === "skat") {
      return socket.emit("error_msg", { message: "Skat nutzt eigene Aktionen." });
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
    if (state.gameType === "kwyx") {
      return socket.emit("error_msg", { message: "Diese Aktion ist in Kwyx nicht verfügbar." });
    }
    if (state.gameType === "schwimmen") {
      return socket.emit("error_msg", { message: "Diese Aktion ist in Schwimmen nicht verfügbar." });
    }
    if (state.gameType === "skat") {
      return socket.emit("error_msg", { message: "Skat nutzt eigene Aktionen." });
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
        state.message = `Yahtzee beendet. Gewinner: ${winners.join(", ")} (${maxScore} Punkte).`;
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
    if (state.gameType === "kwyx") {
      if (state.finished) {
        return socket.emit("error_msg", { message: "Spiel ist beendet." });
      }
      if (state.throwCount === 0 || state.dice.includes(null)) {
        return socket.emit("error_msg", { message: "Bitte zuerst würfeln." });
      }

      const whiteRow = String(category?.whiteRow || "").trim().toLowerCase();
      const colorRow = String(category?.colorRow || "").trim().toLowerCase();
      const colorSum = Number(category?.colorSum);
      const whiteSum = state.dice[0] + state.dice[1];
      const colorDice = {
        red: state.dice[2],
        yellow: state.dice[3],
        green: state.dice[4],
        blue: state.dice[5]
      };
      const card = state.scorecards[state.currentPlayer];
      if (!card) {
        return socket.emit("error_msg", { message: "Scorekarte fehlt." });
      }

      const marks = [];
      if (whiteRow && KWYX_ROWS.includes(whiteRow)) {
        marks.push({ color: whiteRow, value: whiteSum, source: "white" });
      }
      if (colorRow && KWYX_ROWS.includes(colorRow)) {
        const die = colorDice[colorRow];
        const possible = [state.dice[0] + die, state.dice[1] + die];
        if (!Number.isFinite(colorSum) || !possible.includes(colorSum)) {
          return socket.emit("error_msg", { message: "Ungültige Farb-Summe." });
        }
        marks.push({ color: colorRow, value: colorSum, source: "color" });
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
      for (const mark of unique) {
        const result = canMarkKwyxRow(state, card, mark.color, mark.value);
        if (!result.ok) {
          return socket.emit("error_msg", { message: result.error });
        }
        card[mark.color][result.index] = true;
        if (result.isLastField) {
          card.locks[mark.color] = true;
          state.rowLocks[mark.color] = true;
        }
        applied.push(mark);
      }

      if (applied.length === 0) {
        card.strikes += 1;
        state.message = `${state.players[state.currentPlayer]} streicht einen Fehlwurf (${card.strikes}/4).`;
      } else {
        const markText = applied.map(mark => `${mark.color} ${mark.value}`).join(" & ");
        state.message = `${state.players[state.currentPlayer]} markiert ${markText}.`;
      }

      updateKwyxTotals(state);

      const lockedRows = KWYX_ROWS.filter(color => state.rowLocks[color]).length;
      const strikeOut = state.scorecards.some(scorecard => scorecard.strikes >= 4);
      if (lockedRows >= 2 || strikeOut) {
        state.finished = true;
        const maxScore = Math.max(...state.totals);
        const winners = state.players.filter((_, i) => state.totals[i] === maxScore);
        state.message = `Kwyx beendet. Gewinner: ${winners.join(", ")} (${maxScore} Punkte).`;
      } else {
        state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
        state.throwCount = 0;
        state.dice = [null, null, null, null, null, null];
      }

      io.to(room.code).emit("state_update", state);
      persistRooms();
      return;
    }
    if (state.gameType === "schwimmen") {
      return socket.emit("error_msg", { message: "Diese Aktion ist in Schwimmen nicht verfügbar." });
    }
    if (state.gameType === "skat") {
      return socket.emit("error_msg", { message: "Skat nutzt eigene Aktionen." });
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
