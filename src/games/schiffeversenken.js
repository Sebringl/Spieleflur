// Spiellogik für Schiffe versenken (Battleship) – genau 2 Spieler.

// Schiffsgrößen: 1x Schlachtschiff (4), 2x Kreuzer (3), 3x Zerstörer (2)
export const SV_SHIP_SIZES = [4, 3, 3, 2, 2, 2];
export const SV_TOTAL_HEALTH = SV_SHIP_SIZES.reduce((a, b) => a + b, 0); // 16

function createEmptyGrid() {
  return Array(10).fill(null).map(() => Array(10).fill(null));
}

function createBoard() {
  return {
    // null = leer, "ship" = Schiff, "hit" = Treffer, "miss" = Wasser
    grid: createEmptyGrid(),
    ships: SV_SHIP_SIZES.map(length => ({ length, cells: [], sunk: false })),
    shipsPlaced: 0,
    health: SV_TOTAL_HEALTH
  };
}

export function createSchiffeversenkenState(playerNames) {
  return {
    gameType: "schiffeversenken",
    players: playerNames,
    // "setup" -> "playing" -> "finished"
    phase: "setup",
    boards: [createBoard(), createBoard()],
    setupComplete: [false, false],  // alle Schiffe platziert
    readyToStart: [false, false],   // "Spiel starten" geklickt
    currentPlayer: 0, // Wer gerade schießt (wird im Setup auch genutzt für canAct-Kompatibilität)
    winner: null,
    lastShot: null,
    lastResult: null, // "hit" | "sunk" | "miss"
    message: `Beide Spieler platzieren ihre Schiffe.`
  };
}

// Berechnet die Zellpositionen eines Schiffs basierend auf Ankerpunkt und Richtung.
// direction: "right" | "left" | "down" | "up"
function getShipCellPositions(row, col, length, direction) {
  const cells = [];
  for (let i = 0; i < length; i++) {
    let r = row, c = col;
    if (direction === "right") c = col + i;
    else if (direction === "left") c = col - i;
    else if (direction === "down") r = row + i;
    else if (direction === "up") r = row - i;
    cells.push({ row: r, col: c });
  }
  return cells;
}

// Prüft, ob ein Schiff an dieser Position platziert werden kann.
// Schiffe dürfen sich nicht überlappen und nicht direkt nebeneinander stehen (oben/unten/links/rechts).
// Diagonal berühren ist erlaubt.
// direction: "right" | "left" | "down" | "up"
export function canPlaceShip(grid, length, row, col, direction) {
  for (const { row: r, col: c } of getShipCellPositions(row, col, length, direction)) {
    if (r < 0 || r >= 10 || c < 0 || c >= 10) return false;
    if (grid[r][c] !== null) return false;
    // Direkte Nachbarzellen (oben/unten/links/rechts) dürfen kein platziertes Schiff enthalten
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10 && grid[nr][nc] === "ship") return false;
    }
  }
  return true;
}

// Platziert ein Schiff auf dem Board.
// Gibt false zurück, wenn das Schiff bereits platziert ist oder die Position ungültig ist.
// direction: "right" | "left" | "down" | "up"
export function placeShip(board, shipIndex, row, col, direction) {
  const ship = board.ships[shipIndex];
  if (!ship) return false;
  if (ship.cells.length > 0) return false; // bereits platziert

  if (!canPlaceShip(board.grid, ship.length, row, col, direction)) return false;

  const cells = getShipCellPositions(row, col, ship.length, direction);
  for (const { row: r, col: c } of cells) {
    board.grid[r][c] = "ship";
  }
  ship.cells = cells;
  board.shipsPlaced++;
  return true;
}

// Entfernt ein bereits platziertes Schiff vom Board (für Neuplatzierung).
export function removeShip(board, shipIndex) {
  const ship = board.ships[shipIndex];
  if (!ship || ship.cells.length === 0) return false;
  for (const { row: r, col: c } of ship.cells) {
    board.grid[r][c] = null;
  }
  ship.cells = [];
  ship.sunk = false;
  board.shipsPlaced--;
  return true;
}

// Verarbeitet einen Schuss auf das Ziel-Board.
export function recordShot(board, row, col) {
  const cell = board.grid[row][col];
  if (cell === "hit" || cell === "miss") {
    return { valid: false };
  }

  if (cell === "ship") {
    board.grid[row][col] = "hit";
    board.health--;

    // Prüfen ob ein Schiff versenkt wurde
    for (const ship of board.ships) {
      if (ship.sunk) continue;
      const allHit = ship.cells.every(({ row: r, col: c }) => board.grid[r][c] === "hit");
      if (allHit) {
        ship.sunk = true;
        return { valid: true, hit: true, sunk: true };
      }
    }
    return { valid: true, hit: true, sunk: false };
  }

  // Wasser
  board.grid[row][col] = "miss";
  return { valid: true, hit: false, sunk: false };
}

export function isGameOver(boards) {
  return boards.some(b => b.health === 0);
}

export function getWinnerIndex(boards) {
  if (boards[0].health === 0) return 1;
  if (boards[1].health === 0) return 0;
  return -1;
}
