// Schocken: Spielzustand und gesamte Spiellogik.
import { rollDie } from "../utils.js";

// Initialzustand für Schocken.
export function createInitialState({ useDeckel }) {
  return {
    gameType: "schocken",
    useDeckel: !!useDeckel,
    players: [],
    currentPlayer: 0,
    startPlayerIndex: 0,
    playerTurnIndex: 0,
    maxThrowsThisRound: 3,
    throwCount: 0,
    dice: [null, null, null],
    held: [false, false, false],
    convertible: [false, false, false],
    scores: [],
    wins: [],
    history: [],
    roundNumber: 1,
    convertedThisTurn: false,
    convertedCount: 0,
    maxConvertibleThisTurn: 0,
    deckelCount: [],
    halfLossCount: [],
    inFinal: false,
    finalPlayers: [],
    // Deckelmodus: Phase 1 = Verteilen aus Mitte, Phase 2 = Sammeln unter Spielern
    deckelPhase: 1,
    centerCount: 13,
    deckelLoser: null,
    message: "",
    roundJustEnded: false
  };
}

export function resetDiceState(state, diceCount) {
  state.throwCount = 0;
  state.dice = Array(diceCount).fill(null);
  state.held = Array(diceCount).fill(false);
}

export function resetTurn(state) {
  resetDiceState(state, 3);
  state.convertible = [false, false, false];
  state.convertedThisTurn = false;
  state.convertedCount = 0;
  state.maxConvertibleThisTurn = 0;
}

export function applyManualSixRule(state) {
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

export function rateRoll(dice, throws, playerIndex) {
  const sorted = dice.slice().sort((x, y) => y - x);
  const [a, b, c] = sorted;
  const countOf1 = sorted.filter(d => d === 1).length;
  let label, tier, subvalue;

  if (countOf1 === 3) {
    label = "Schock Out"; tier = 4; subvalue = 6;
  } else if (countOf1 === 2) {
    label = `Schock ${a}`; tier = 3; subvalue = a;
  } else if (a === b && b === c) {
    label = "Pasch"; tier = 2; subvalue = a;
  } else if (a - b === 1 && b - c === 1) {
    label = "Straße"; tier = 1; subvalue = 0;
  } else {
    label = `${a}-${b}-${c}`; tier = 0; subvalue = parseInt(`${a}${b}${c}`, 10);
  }

  return { label, tier, subvalue, throws, playerIndex };
}

export function activeOrder(state) {
  if (state.inFinal && state.finalPlayers.length >= 2) return state.finalPlayers.slice();
  return state.players.map((_, i) => i);
}

export function seatToOrderPos(order, seat) {
  const pos = order.indexOf(seat);
  return pos >= 0 ? pos : 0;
}

export function setCurrentFromOrder(state, order, orderPos) {
  state.currentPlayer = order[orderPos];
}

export function rotateCurrentPlayer(state) {
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

export function nextPlayer(state) {
  const order = activeOrder(state);
  state.playerTurnIndex++;
  if (state.playerTurnIndex < order.length) {
    const startPos = seatToOrderPos(order, state.startPlayerIndex);
    const nextPos = (startPos + state.playerTurnIndex) % order.length;
    setCurrentFromOrder(state, order, nextPos);
    resetTurn(state);
    state.message = "";
    return;
  }
  prepareNextRound(state);
}

export function prepareNextRound(state) {
  const order = activeOrder(state);
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
    // Deckelanzahl richtet sich nach dem BESTEN Wurf (Gewinner)
    let penalty;
    switch (sortable[0].tier) {
      case 1: penalty = 2; break; // Straße
      case 2: penalty = 3; break; // General (Pasch)
      case 3: penalty = 4; break; // Schock
      case 4: penalty = 4; break; // Schock Out
      default: penalty = 1;       // normaler Wurf
    }

    if (state.deckelPhase === 1) {
      // Phase 1: Deckel kommen aus der Mitte
      const actual = Math.min(penalty, state.centerCount);
      state.deckelCount[loserSeat] += actual;
      state.centerCount -= actual;
      state.message = `Runde ${state.roundNumber}: ${state.players[winnerSeat]} (${sortable[0].label}) gibt ${actual} Deckel aus der Mitte an ${state.players[loserSeat]}. Mitte: ${state.centerCount} Deckel.`;
      if (state.centerCount === 0) {
        state.deckelPhase = 2;
        state.message += ` Alle Deckel verteilt – jetzt spielen sich die Deckel gegenseitig zu!`;
      }
    } else {
      // Phase 2: Deckel wandern vom Gewinner zum Verlierer
      const actual = Math.min(penalty, state.deckelCount[winnerSeat]);
      state.deckelCount[winnerSeat] -= actual;
      state.deckelCount[loserSeat] += actual;
      state.message = `Runde ${state.roundNumber}: ${state.players[winnerSeat]} (${sortable[0].label}) gibt ${actual} Deckel an ${state.players[loserSeat]}.`;

      // Prüfen ob ein Spieler alle 13 Deckel hat (Halbzeit-Verlierer)
      const halfLossPlayerSeat = order.find(seat => state.deckelCount[seat] >= 13);
      if (halfLossPlayerSeat !== undefined) {
        if (state.inFinal) {
          // Finale-Verlierer → Gesamtverlierer steht fest
          state.deckelLoser = halfLossPlayerSeat;
          state.message += ` ${state.players[halfLossPlayerSeat]} hat alle 13 Deckel und verliert das Finale – zahlt eine Runde!`;
        } else {
          state.halfLossCount[halfLossPlayerSeat]++;
          if (state.halfLossCount[halfLossPlayerSeat] >= 2) {
            // Selber Spieler verliert beide Halbzeiten → direkter Gesamtverlierer
            state.deckelLoser = halfLossPlayerSeat;
            state.message += ` ${state.players[halfLossPlayerSeat]} verliert beide Halbzeiten und zahlt eine Runde!`;
          } else {
            const halfLosers = state.halfLossCount
              .map((c, i) => ({ c, i }))
              .filter(x => x.c > 0)
              .map(x => x.i);
            if (halfLosers.length >= 2) {
              state.inFinal = true;
              state.finalPlayers = halfLosers.slice(0, 2);
              for (const seat of state.finalPlayers) state.deckelCount[seat] = 0;
              state.centerCount = 13;
              state.deckelPhase = 1;
              state.message += ` ${state.players[halfLossPlayerSeat]} verliert die Halbzeit! Finale: ${state.finalPlayers.map(i => state.players[i]).join(" vs ")}.`;
            } else {
              // Zweite Halbzeit beginnt
              state.deckelCount = state.deckelCount.map(_ => 0);
              state.centerCount = 13;
              state.deckelPhase = 1;
              state.message += ` ${state.players[halfLossPlayerSeat]} verliert die Halbzeit! Zweite Halbzeit beginnt.`;
            }
          }
        }
      }
    }
  } else {
    state.wins[winnerSeat] += 1;
    state.message = `Runde ${state.roundNumber} beendet. Gewinner: ${state.players[winnerSeat]} (${sortable[0].label}).`;
  }

  state.roundNumber++;
  state.history.push(new Array(state.players.length).fill(null));
  state.roundJustEnded = true;
  state.maxThrowsThisRound = 3;
  state.startPlayerIndex = loserSeat;
  state.playerTurnIndex = 0;
  state.scores = state.players.map(_ => ({ tier: null, subvalue: null, throws: 0, label: "" }));

  const nextOrder = activeOrder(state);
  const startPos = seatToOrderPos(nextOrder, state.startPlayerIndex);
  setCurrentFromOrder(state, nextOrder, startPos);
  resetTurn(state);
}

export function initializeSchockenRoom(room) {
  const state = createInitialState({ useDeckel: room.settings.useDeckel });
  state.players = room.players.map(p => p.name);
  state.scores = state.players.map(_ => ({ tier: null, subvalue: null, throws: 0, label: "" }));
  state.wins = state.players.map(_ => 0);
  state.history = [new Array(state.players.length).fill(null)];
  state.deckelCount = state.players.map(_ => 0);
  state.halfLossCount = state.players.map(_ => 0);
  state.deckelPhase = 1;
  state.centerCount = 13;
  state.deckelLoser = null;
  state.startPlayerIndex = 0;
  state.playerTurnIndex = 0;
  state.currentPlayer = 0;
  return state;
}
