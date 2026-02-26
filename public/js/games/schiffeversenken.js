// Schiffe versenken – Client-seitige UI-Logik.

// Schiffsgrößen müssen mit dem Server übereinstimmen.
const SV_SHIP_SIZES = [4, 3, 3, 2, 2, 2];
const SV_SHIP_NAMES = ["Schlachtschiff (4)", "Kreuzer (3)", "Kreuzer (3)", "Zerstörer (2)", "Zerstörer (2)", "Zerstörer (2)"];

// Lokaler Setup-Zustand
let svSelectedShipIndex = null;
let svIsVertical = false;
let svHoverCells = [];

function svGetMyBoard() {
  if (!state || !state.boards) return null;
  return state.boards[mySeat];
}

function svGetEnemyBoard() {
  if (!state || !state.boards) return null;
  return state.boards[1 - mySeat];
}

// Haupt-Renderfunktion
function renderSchiffeversenkenGame() {
  if (!state || state.gameType !== "schiffeversenken") return;

  // Alle anderen Spielansichten verstecken
  ["schockenView", "kniffelView", "kwyxView", "schwimmenView", "skatView"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  const svView = document.getElementById("schiffeversenkenView");
  if (!svView) return;
  svView.style.display = "block";

  // Nachricht anzeigen
  const msgEl = document.getElementById("svMessage");
  if (msgEl) msgEl.textContent = state.message || "";

  // Spieler-Anzeige in der Kopfzeile
  const playerDisplay = document.getElementById("playerDisplay");
  if (playerDisplay) {
    if (state.phase === "setup") {
      playerDisplay.textContent = "Aufbauphase – Schiffe platzieren";
    } else if (state.phase === "playing") {
      const currentName = state.players[state.currentPlayer];
      const isMyTurnNow = state.currentPlayer === mySeat;
      playerDisplay.textContent = isMyTurnNow ? "Du bist am Zug!" : `Am Zug: ${currentName}`;
    } else {
      playerDisplay.textContent = state.winner ? `Sieger: ${state.winner}` : "Spiel beendet";
    }
  }

  const setupArea = document.getElementById("svSetupArea");
  const playArea = document.getElementById("svPlayArea");

  if (state.phase === "setup") {
    if (setupArea) setupArea.style.display = "block";
    if (playArea) playArea.style.display = "none";
    renderSvSetup();
  } else {
    if (setupArea) setupArea.style.display = "none";
    if (playArea) playArea.style.display = "block";
    renderSvPlay();
  }
}

// ---- Setup-Phase ----

function renderSvSetup() {
  const myBoard = svGetMyBoard();
  if (!myBoard) return;

  renderSvShipList(myBoard);
  renderSvSetupGrid(myBoard);

  // Drehen-Button
  const rotateBtn = document.getElementById("svRotateBtn");
  if (rotateBtn) {
    rotateBtn.textContent = svIsVertical ? "Ausrichtung: Senkrecht ↕" : "Ausrichtung: Waagerecht ↔";
    rotateBtn.onclick = () => {
      svIsVertical = !svIsVertical;
      renderSvSetup();
    };
  }

  // Bereits vollständig aufgebaut?
  if (state.setupComplete && state.setupComplete[mySeat]) {
    const setupArea = document.getElementById("svSetupArea");
    if (setupArea) {
      setupArea.innerHTML = `<div class="sv-setup-done">
        <p>✅ Du hast alle Schiffe platziert. Warte auf den Gegner…</p>
        <div class="sv-grid-label" style="margin-top:10px;">Dein Spielfeld</div>
        <div id="svWaitGrid" class="sv-grid"></div>
      </div>`;
      renderSvGridReadonly("svWaitGrid", myBoard.grid, true);
    }
  }
}

function renderSvShipList(board) {
  const container = document.getElementById("svShipList");
  if (!container) return;

  let html = "<h4>Schiffe</h4><ul class='sv-ships'>";
  SV_SHIP_SIZES.forEach((size, idx) => {
    const ship = board.ships[idx];
    const placed = ship && ship.cells.length > 0;
    const selected = svSelectedShipIndex === idx;
    html += `<li class="sv-ship-item${placed ? " sv-ship-placed" : ""}${selected ? " sv-ship-selected" : ""}" data-idx="${idx}">
      <span class="sv-ship-name">${SV_SHIP_NAMES[idx]}</span>
      <span class="sv-ship-cells">${"▪".repeat(size)}</span>
      ${placed ? '<span class="sv-ship-status">✓</span>' : ""}
    </li>`;
  });
  html += "</ul>";
  container.innerHTML = html;

  container.querySelectorAll(".sv-ship-item:not(.sv-ship-placed)").forEach(li => {
    li.onclick = () => {
      const idx = Number(li.dataset.idx);
      svSelectedShipIndex = (svSelectedShipIndex === idx) ? null : idx;
      renderSvSetup();
    };
  });
}

function renderSvSetupGrid(board) {
  const container = document.getElementById("svSetupGrid");
  if (!container) return;
  container.innerHTML = "";

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.className = "sv-cell";
      cell.dataset.row = r;
      cell.dataset.col = c;

      const val = board.grid[r][c];
      if (val === "ship") {
        cell.classList.add("sv-cell-ship");
      }
      if (svHoverCells.some(h => h.r === r && h.c === c)) {
        cell.classList.add("sv-cell-hover");
      }

      cell.addEventListener("mouseenter", () => svOnHover(r, c));
      cell.addEventListener("mouseleave", () => svClearHover());
      cell.addEventListener("click", () => svOnSetupClick(r, c));

      container.appendChild(cell);
    }
  }
}

function svOnHover(row, col) {
  if (svSelectedShipIndex === null) return;
  const myBoard = svGetMyBoard();
  if (!myBoard) return;
  const ship = myBoard.ships[svSelectedShipIndex];
  if (!ship || ship.cells.length > 0) return;

  svHoverCells = [];
  for (let i = 0; i < ship.length; i++) {
    const r = svIsVertical ? row + i : row;
    const c = svIsVertical ? col : col + i;
    if (r >= 0 && r < 10 && c >= 0 && c < 10) {
      svHoverCells.push({ r, c });
    }
  }
  renderSvSetupGrid(myBoard);
}

function svClearHover() {
  svHoverCells = [];
  const myBoard = svGetMyBoard();
  if (myBoard) renderSvSetupGrid(myBoard);
}

function svOnSetupClick(row, col) {
  if (svSelectedShipIndex === null) return;
  if (!room) return;
  socket.emit("sv_place_ship", {
    code: room.code,
    shipIndex: svSelectedShipIndex,
    row,
    col,
    isVertical: svIsVertical
  });
  svSelectedShipIndex = null;
  svHoverCells = [];
}

// ---- Spielphase ----

function renderSvPlay() {
  const myBoard = svGetMyBoard();
  const enemyBoard = svGetEnemyBoard();
  if (!myBoard || !enemyBoard) return;

  // Eigenes Gitter (zeigt Schiffe + Treffer/Wasser des Gegners)
  renderSvGridReadonly("svMyGrid", myBoard.grid, true);

  // Gegner-Gitter (nur Treffer/Wasser sichtbar, Schiffe versteckt)
  renderSvEnemyGrid("svEnemyGrid", enemyBoard.grid);
}

function renderSvGridReadonly(containerId, grid, showShips) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.className = "sv-cell";
      const val = grid[r][c];

      if (val === "hit") {
        cell.classList.add("sv-cell-hit");
        cell.textContent = "✕";
      } else if (val === "miss") {
        cell.classList.add("sv-cell-miss");
        cell.textContent = "•";
      } else if (val === "ship" && showShips) {
        cell.classList.add("sv-cell-ship");
      }
      container.appendChild(cell);
    }
  }
}

function renderSvEnemyGrid(containerId, grid) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  const isMyTurnNow = state && state.currentPlayer === mySeat && state.phase === "playing";

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement("div");
      cell.className = "sv-cell";
      const val = grid[r][c];

      if (val === "hit") {
        cell.classList.add("sv-cell-hit");
        cell.textContent = "✕";
      } else if (val === "miss") {
        cell.classList.add("sv-cell-miss");
        cell.textContent = "•";
      } else if (val === "ship") {
        // Gegnerische Schiffe nicht anzeigen (nur nach Spielende)
        if (state.phase === "finished") {
          cell.classList.add("sv-cell-ship-hidden");
          cell.textContent = "▪";
        }
      }

      // Klickbar wenn am Zug und Feld noch nicht beschossen
      if (isMyTurnNow && !val) {
        cell.classList.add("sv-cell-shootable");
        cell.addEventListener("click", () => {
          if (!room) return;
          socket.emit("sv_shoot", { code: room.code, row: r, col: c });
        });
        cell.addEventListener("mouseenter", () => cell.classList.add("sv-cell-aim"));
        cell.addEventListener("mouseleave", () => cell.classList.remove("sv-cell-aim"));
      }

      container.appendChild(cell);
    }
  }
}
