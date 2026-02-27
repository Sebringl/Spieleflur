// Schiffe versenken – Client-seitige UI-Logik.

// Schiffsgrößen müssen mit dem Server übereinstimmen.
const SV_SHIP_SIZES = [4, 3, 3, 2, 2, 2];
const SV_SHIP_NAMES = ["Schlachtschiff (4)", "Kreuzer (3)", "Kreuzer (3)", "Zerstörer (2)", "Zerstörer (2)", "Zerstörer (2)"];

// Lokaler Setup-Zustand
let svSelectedShipIndex = null;
let svIsVertical = false;
let svHoverCells = [];
let svDragState = null; // Zieht man zum Platzieren, wird die Richtung per Drag bestimmt

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
  svUpdateRotateBtn();

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

      // Maus-Hover für Desktop
      cell.addEventListener("mouseenter", () => svOnHover(r, c));
      cell.addEventListener("mouseleave", () => svClearHover());
      // Kein click-Listener mehr – wird über pointerup abgehandelt

      container.appendChild(cell);
    }
  }

  // Pointer-Events (Maus + Touch) für Drag-Richtungserkennung
  svAttachGridPointerEvents(container);
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
  const justPlacedIndex = svSelectedShipIndex;
  socket.emit("sv_place_ship", {
    code: room.code,
    shipIndex: svSelectedShipIndex,
    row,
    col,
    isVertical: svIsVertical
  });
  svSelectedShipIndex = null;
  svHoverCells = [];

  // Nächstes unplatziertes Schiff automatisch auswählen
  const myBoard = svGetMyBoard();
  if (myBoard) {
    for (let i = 0; i < SV_SHIP_SIZES.length; i++) {
      if (i === justPlacedIndex) continue;
      const ship = myBoard.ships[i];
      if (ship && ship.cells.length === 0) {
        svSelectedShipIndex = i;
        break;
      }
    }
  }
}

// Drehen-Button-Text aktualisieren
function svUpdateRotateBtn() {
  const rotateBtn = document.getElementById("svRotateBtn");
  if (!rotateBtn) return;
  rotateBtn.textContent = svIsVertical ? "Ausrichtung: Senkrecht ↕" : "Ausrichtung: Waagerecht ↔";
  rotateBtn.onclick = () => {
    svIsVertical = !svIsVertical;
    renderSvSetup();
  };
}

// Pointer-Events einmalig am Grid-Container registrieren.
// Zieht man nach rechts/links → waagerecht; nach oben/unten → senkrecht.
// Kurzes Antippen → behält die bisherige Ausrichtung.
function svAttachGridPointerEvents(container) {
  if (container.dataset.svListeners) return; // Nur einmal anhängen
  container.dataset.svListeners = "1";

  container.addEventListener("pointerdown", e => {
    if (svSelectedShipIndex === null) return;
    const cell = e.target.closest(".sv-cell");
    if (!cell) return;

    svDragState = {
      startRow: Number(cell.dataset.row),
      startCol: Number(cell.dataset.col),
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
    };
    svOnHover(svDragState.startRow, svDragState.startCol);
  });

  container.addEventListener("pointermove", e => {
    if (!svDragState) {
      // Touch-Hover ohne aktiven Drag: Vorschau unter dem Finger aktualisieren
      if (e.pointerType !== "mouse") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el.dataset.row !== undefined) {
          svOnHover(Number(el.dataset.row), Number(el.dataset.col));
        }
      }
      return;
    }

    const dx = e.clientX - svDragState.startX;
    const dy = e.clientY - svDragState.startY;

    if (Math.sqrt(dx * dx + dy * dy) > 8) {
      svDragState.isDragging = true;
      // Richtung aus der Drag-Geste ableiten
      const newIsVertical = Math.abs(dy) >= Math.abs(dx);
      if (newIsVertical !== svIsVertical) {
        svIsVertical = newIsVertical;
        svUpdateRotateBtn();
      }
      svOnHover(svDragState.startRow, svDragState.startCol);
    }
  });

  container.addEventListener("pointerup", e => {
    if (!svDragState) return;
    const { startRow, startCol } = svDragState;
    svDragState = null;
    svOnSetupClick(startRow, startCol);
  });

  container.addEventListener("pointercancel", () => {
    svDragState = null;
    svClearHover();
  });
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
      } else if (val === "miss") {
        cell.classList.add("sv-cell-miss");
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
      } else if (val === "miss") {
        cell.classList.add("sv-cell-miss");
      } else if (val === "ship") {
        // Gegnerische Schiffe nicht anzeigen (nur nach Spielende)
        if (state.phase === "finished") {
          cell.classList.add("sv-cell-ship-hidden");
        }
      }

      // Klickbar wenn am Zug und Feld noch nicht beschossen (weder Treffer noch Wasser)
      if (isMyTurnNow && val !== "hit" && val !== "miss") {
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
