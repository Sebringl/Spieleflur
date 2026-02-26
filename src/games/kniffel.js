// Kniffel (Yahtzee): Spielzustand und Spiellogik.

export const KNIFFEL_CATEGORIES = [
  "ones", "twos", "threes", "fours", "fives", "sixes",
  "threeKind", "fourKind", "fullHouse", "smallStraight", "largeStraight", "yahtzee", "chance"
];

export function createKniffelState() {
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

export function resetKniffelTurn(state) {
  state.throwCount = 0;
  state.dice = Array(5).fill(null);
  state.held = Array(5).fill(false);
}

export function scoreKniffel(dice, category) {
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
      return { score: (hasStraight([1,2,3,4]) || hasStraight([2,3,4,5]) || hasStraight([3,4,5,6])) ? 30 : 0, label: "Kleine Straße" };
    case "largeStraight":
      return { score: (hasStraight([1,2,3,4,5]) || hasStraight([2,3,4,5,6])) ? 40 : 0, label: "Große Straße" };
    case "yahtzee": return { score: hasN(5) ? 50 : 0, label: "Yahtzee" };
    case "chance": return { score: sum, label: "Chance" };
    default: return { score: 0, label: "Unbekannt" };
  }
}

export function initializeKniffelRoom(room) {
  const state = createKniffelState();
  state.players = room.players.map(p => p.name);
  state.scorecard = state.players.map(() => {
    const card = {};
    KNIFFEL_CATEGORIES.forEach(cat => { card[cat] = null; });
    return card;
  });
  state.totals = state.players.map(_ => 0);
  state.currentPlayer = 0;
  return state;
}
