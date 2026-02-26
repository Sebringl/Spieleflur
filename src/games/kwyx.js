// Kwyx: Spielzustand und gesamte Spiellogik.

export const KWYX_ROWS = ["red", "yellow", "green", "blue"];

export const KWYX_NUMBERS = {
  red: Array.from({ length: 11 }, (_, i) => i + 2),
  yellow: Array.from({ length: 11 }, (_, i) => i + 2),
  green: Array.from({ length: 11 }, (_, i) => 12 - i),
  blue: Array.from({ length: 11 }, (_, i) => 12 - i)
};

export function createKwyxCard() {
  return {
    red: Array(11).fill(false),
    yellow: Array(11).fill(false),
    green: Array(11).fill(false),
    blue: Array(11).fill(false),
    locks: { red: false, yellow: false, green: false, blue: false },
    strikes: 0
  };
}

export function createKwyxState(players) {
  return {
    gameType: "kwyx",
    players,
    currentPlayer: 0,
    dice: [null, null, null, null, null, null],
    throwCount: 0,
    maxThrowsThisRound: 1,
    scorecards: players.map(() => createKwyxCard()),
    rowLocks: { red: false, yellow: false, green: false, blue: false },
    totals: players.map(() => 0),
    finished: false,
    kwyxEnded: players.map(() => false),
    kwyxCountdownEndsAt: null,
    kwyxPendingFinish: false,
    message: ""
  };
}

export function getKwyxRowIndex(color, value) {
  const numbers = KWYX_NUMBERS[color];
  if (!numbers) return -1;
  return numbers.indexOf(value);
}

export function countKwyxMarks(row) {
  return row.reduce((acc, marked) => acc + (marked ? 1 : 0), 0);
}

export function canMarkKwyxRow(state, card, color, value) {
  if (!KWYX_ROWS.includes(color)) return { ok: false, error: "Unbekannte Reihe." };
  if (state.rowLocks[color]) return { ok: false, error: "Diese Reihe ist gesperrt." };
  const index = getKwyxRowIndex(color, value);
  if (index < 0) return { ok: false, error: "Ungültiger Wert." };
  const row = card[color];
  if (row[index]) return { ok: false, error: "Dieses Feld ist bereits markiert." };
  const lastIndex = row.reduce((acc, marked, idx) => (marked ? Math.max(acc, idx) : acc), -1);
  if (lastIndex >= 0 && index <= lastIndex) return { ok: false, error: "Du musst weiter rechts markieren." };
  const isLastField = index === KWYX_NUMBERS[color].length - 1;
  if (isLastField && countKwyxMarks(row) < 5) return { ok: false, error: "Zum Schließen brauchst du mindestens 5 Kreuze." };
  return { ok: true, index, isLastField };
}

export function scoreKwyxCard(card) {
  const rowScore = color => {
    const marks = countKwyxMarks(card[color]);
    const lockBonus = card.locks?.[color] ? 1 : 0;
    return (marks * (marks + 1)) / 2 + lockBonus;
  };
  const totalRows = KWYX_ROWS.reduce((acc, color) => acc + rowScore(color), 0);
  return totalRows - card.strikes * 5;
}

export function updateKwyxTotals(state) {
  state.totals = state.scorecards.map(card => scoreKwyxCard(card));
}

export function ensureKwyxTurnState(state) {
  if (!Array.isArray(state.kwyxEnded) || state.kwyxEnded.length !== state.players.length) {
    state.kwyxEnded = state.players.map(() => false);
  }
  if (typeof state.kwyxCountdownEndsAt !== "number") state.kwyxCountdownEndsAt = null;
  if (typeof state.kwyxPendingFinish !== "boolean") state.kwyxPendingFinish = false;
}

export function resetKwyxTurnState(state) {
  state.kwyxEnded = state.players.map(() => false);
  state.kwyxCountdownEndsAt = null;
  state.kwyxPendingFinish = false;
}

export function clearKwyxCountdown(room, state) {
  if (room.kwyxCountdownTimer) {
    clearTimeout(room.kwyxCountdownTimer);
    room.kwyxCountdownTimer = null;
  }
  state.kwyxCountdownEndsAt = null;
}

export function shouldFinishKwyxGame(state) {
  const lockedRows = KWYX_ROWS.filter(color => state.rowLocks[color]).length;
  const strikeOut = state.scorecards.some(scorecard => scorecard.strikes >= 4);
  return lockedRows >= 2 || strikeOut;
}
