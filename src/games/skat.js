// Skat: Spielzustand und gesamte Spiellogik.
import crypto from "crypto";

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export const SKAT_BID_VALUES = [
  18, 20, 22, 23, 24, 27, 30, 33, 35, 36, 40, 44, 45, 46, 48, 50, 54, 55, 59, 60,
  63, 66, 70, 72, 77, 80, 81, 84, 88, 90, 96, 99, 100, 108, 110, 120, 121, 126, 132,
  135, 144, 150, 153, 160, 162, 168, 176, 180, 187, 192, 198, 204, 216, 220, 240, 264
];

export const SKAT_BASE_VALUES = { "♣": 12, "♠": 11, "♥": 10, "♦": 9, grand: 24 };
export const SKAT_EYE_VALUES = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };
export const SKAT_NULL_VALUES = { normal: 23, hand: 35, ouvert: 46, handOuvert: 59 };

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

export function dealSkatHands(players) {
  const deck = createSkatDeck();
  const hands = players.map(() => deck.splice(0, 10));
  const skat = deck.splice(0, 2);
  return { hands, skat };
}

export function getSkatRankValue(rank, { nullGame } = {}) {
  if (nullGame) {
    const order = ["7", "8", "9", "10", "J", "Q", "K", "A"];
    return order.indexOf(rank);
  }
  const order = ["7", "8", "9", "Q", "K", "10", "A"];
  return order.indexOf(rank);
}

export function isSkatTrump(card, game) {
  if (!card || !game) return false;
  if (game.type === "null") return false;
  if (card.rank === "J") return true;
  if (game.type === "suit") return card.suit === game.suit;
  return false;
}

export function getSkatTrickRank(card, game, leadSuit) {
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

export function getSkatLeadSuit(card, game) {
  if (!card) return null;
  if (game.type !== "null" && isSkatTrump(card, game)) return "trump";
  return card.suit;
}

export function determineSkatTrickWinner(trick, leadSuit, game) {
  let bestIndex = 0, bestValue = -1;
  trick.forEach((play, index) => {
    if (!play.card) return;
    const value = getSkatTrickRank(play.card, game, leadSuit);
    if (value > bestValue) { bestValue = value; bestIndex = index; }
  });
  return trick[bestIndex]?.seat ?? trick[0]?.seat ?? 0;
}

export function getSkatCardPoints(card) {
  return SKAT_EYE_VALUES[card?.rank] ?? 0;
}

export function getSkatMatadors(cards, game) {
  if (game.type === "null") return 0;
  const topTrumps = [
    { suit: "♣", rank: "J" }, { suit: "♠", rank: "J" },
    { suit: "♥", rank: "J" }, { suit: "♦", rank: "J" }
  ];
  const hasTopJack = cards.some(card => card.suit === topTrumps[0].suit && card.rank === topTrumps[0].rank);
  let count = 0;
  if (hasTopJack) {
    for (const jack of topTrumps) {
      const hasJack = cards.some(card => card.suit === jack.suit && card.rank === jack.rank);
      if (hasJack) count += 1; else break;
    }
    return count;
  }
  for (const jack of topTrumps) {
    const hasJack = cards.some(card => card.suit === jack.suit && card.rank === jack.rank);
    if (hasJack) break;
    count += 1;
  }
  return count;
}

export function calculateSkatGameValue({ game, cards, hand, schneider, schwarz, ouvert }) {
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

export function initializeSkatBidding(state) {
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

export function concludeSkatBidding(state) {
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

export function advanceSkatBidding(state) {
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

export function createSkatState(players) {
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
