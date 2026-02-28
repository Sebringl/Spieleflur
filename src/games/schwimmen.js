// Schwimmen: Spielzustand und gesamte Spiellogik.
import crypto from "crypto";

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function createSchwimmenDeck() {
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

export function cardValue(rank) {
  if (rank === "A") return 11;
  if (["K", "Q", "J", "10"].includes(rank)) return 10;
  return Number(rank);
}

export function scoreSchwimmenHand(hand) {
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

export function getActiveSchwimmenSeats(state) {
  return state.players
    .map((_, i) => i)
    .filter(i => !state.eliminated?.[i]);
}

export function getNextActiveSchwimmenSeat(state, fromSeat) {
  const total = state.players.length;
  for (let offset = 1; offset <= total; offset++) {
    const seat = (fromSeat + offset) % total;
    if (!state.eliminated?.[seat]) return seat;
  }
  return fromSeat;
}

export function setupSchwimmenRound(state, { startingSeat, resetScores = false } = {}) {
  let deck = [], hands = [], tableCards = [];
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
  if (resetScores) state.scores = [];
  state.currentPlayer = typeof startingSeat === "number"
    ? startingSeat
    : (getActiveSchwimmenSeats(state)[0] ?? 0);
}

export function startSchwimmenNextRound(state) {
  const startSeat = typeof state.nextStartingSeat === "number"
    ? state.nextStartingSeat
    : (getActiveSchwimmenSeats(state)[0] ?? 0);
  setupSchwimmenRound(state, { startingSeat: startSeat });
}

export function refreshSchwimmenTable(state) {
  if (state.deck.length < 3) {
    state.message = "Alle schieben – nicht genug Karten zum Erneuern.";
    state.passCount = 0;
    return;
  }
  state.tableCards = state.deck.splice(0, 3);
  state.message = "Alle schieben – Tischkarten wurden erneuert.";
  state.passCount = 0;
}

export function applySchwimmenLifeLoss(state, seat) {
  if (state.lives[seat] > 0) {
    state.lives[seat] -= 1;
    return { swimmingNow: state.lives[seat] === 0 };
  }
  state.eliminated[seat] = true;
  return { eliminatedNow: true };
}

export function handleSchwimmenFeuer(state, seat) {
  if (state.finished || state.fireResolved) return false;
  const hand = state.hands?.[seat];
  if (!hand || hand.length !== 3) return false;
  if (!hand.every(card => card.rank === "A")) return false;

  state.fireResolved = true;
  const activeSeats = getActiveSchwimmenSeats(state).filter(i => i !== seat);
  const swimmingNow = [], eliminatedNow = [];

  activeSeats.forEach(otherSeat => {
    const result = applySchwimmenLifeLoss(state, otherSeat);
    if (result?.swimmingNow) swimmingNow.push(otherSeat);
    if (result?.eliminatedNow) eliminatedNow.push(otherSeat);
  });

  let message = `Feuer! ${state.players[seat]} deckt drei Asse auf. Alle anderen verlieren ein Leben.`;
  if (swimmingNow.length) message += ` ${swimmingNow.map(i => state.players[i]).join(", ")} schwimmt jetzt.`;
  if (eliminatedNow.length) message += ` ${eliminatedNow.map(i => state.players[i]).join(", ")} geht unter.`;

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
    state.winner = winnerSeat !== undefined ? state.players[winnerSeat] : undefined;
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

export function finishSchwimmenRound(state) {
  const activeSeats = getActiveSchwimmenSeats(state);
  if (activeSeats.length <= 1) {
    const winnerSeat = activeSeats[0];
    state.finished = true;
    state.winner = winnerSeat !== undefined ? state.players[winnerSeat] : undefined;
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

  const eliminatedNow = [], swimmingNow = [];
  losers.forEach(seat => {
    if (state.lives[seat] > 0) {
      state.lives[seat] -= 1;
      if (state.lives[seat] === 0) swimmingNow.push(seat);
    } else {
      state.eliminated[seat] = true;
      eliminatedNow.push(seat);
    }
  });

  const winnerNames = winners.map(i => state.players[i]).join(", ");
  const loserNames = losers.map(i => state.players[i]).join(", ");
  let message = `Runde ${state.roundNumber} beendet. Gewinner: ${winnerNames} (${maxScore} Punkte). Verlierer: ${loserNames} (${minScore} Punkte).`;
  if (swimmingNow.length) message += ` ${swimmingNow.map(i => state.players[i]).join(", ")} schwimmt jetzt.`;
  if (eliminatedNow.length) message += ` ${eliminatedNow.map(i => state.players[i]).join(", ")} geht unter.`;

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
    state.winner = winnerSeat !== undefined ? state.players[winnerSeat] : undefined;
    state.message += winnerSeat !== undefined ? ` Gesamtsieger: ${state.players[winnerSeat]}.` : "";
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

export function endSchwimmenTurn(state, { knocked } = { knocked: false }) {
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

export function createSchwimmenState(players) {
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
