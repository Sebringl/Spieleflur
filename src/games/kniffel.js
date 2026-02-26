// Kniffel (Yahtzee): Spielzustand und Spiellogik.

export const KNIFFEL_CATEGORIES = [
  "ones", "twos", "threes", "fours", "fives", "sixes",
  "threeKind", "fourKind", "fullHouse", "smallStraight", "largeStraight", "yahtzee", "chance"
];

const KNIFFEL_LOWER_CATEGORIES = new Set(KNIFFEL_CATEGORIES.slice(6));
const KNIFFEL_HAND_BONUS = 5;

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

export function scoreKniffel(dice, category, throwCount = 0, handBonusEnabled = true) {
  const counts = [0, 0, 0, 0, 0, 0];
  dice.forEach(d => { counts[d - 1]++; });
  const sum = dice.reduce((acc, val) => acc + val, 0);
  const hasN = n => counts.some(c => c >= n);
  const hasExact = (a, b) => counts.includes(a) && counts.includes(b);
  const unique = new Set(dice);
  const hasStraight = (seq) => seq.every(n => unique.has(n));

  let score = 0;
  let label = "Unbekannt";
  switch (category) {
    case "ones":
      score = counts[0] * 1;
      label = "Einer";
      break;
    case "twos":
      score = counts[1] * 2;
      label = "Zweier";
      break;
    case "threes":
      score = counts[2] * 3;
      label = "Dreier";
      break;
    case "fours":
      score = counts[3] * 4;
      label = "Vierer";
      break;
    case "fives":
      score = counts[4] * 5;
      label = "Fünfer";
      break;
    case "sixes":
      score = counts[5] * 6;
      label = "Sechser";
      break;
    case "threeKind":
      score = hasN(3) ? sum : 0;
      label = "Dreierpasch";
      break;
    case "fourKind":
      score = hasN(4) ? sum : 0;
      label = "Viererpasch";
      break;
    case "fullHouse":
      score = hasExact(3, 2) ? 25 : 0;
      label = "Full House";
      break;
    case "smallStraight":
      score = (hasStraight([1,2,3,4]) || hasStraight([2,3,4,5]) || hasStraight([3,4,5,6])) ? 30 : 0;
      label = "Kleine Straße";
      break;
    case "largeStraight":
      score = (hasStraight([1,2,3,4,5]) || hasStraight([2,3,4,5,6])) ? 40 : 0;
      label = "Große Straße";
      break;
    case "yahtzee":
      score = hasN(5) ? 50 : 0;
      label = "Yahtzee";
      break;
    case "chance":
      score = sum;
      label = "Chance";
      break;
    default: return { score: 0, label: "Unbekannt" };
  }

  if (handBonusEnabled && throwCount === 1 && KNIFFEL_LOWER_CATEGORIES.has(category) && score > 0) {
    score += KNIFFEL_HAND_BONUS;
  }

  return { score, label };
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
