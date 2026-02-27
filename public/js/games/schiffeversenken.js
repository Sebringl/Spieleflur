// Schiffe versenken – Client-seitige UI-Logik.

// Schiffsgrößen müssen mit dem Server übereinstimmen.
const SV_SHIP_SIZES = [4, 3, 3, 2, 2, 2];
const SV_SHIP_NAMES = ["Schlachtschiff (4)", "Kreuzer (3)", "Kreuzer (3)", "Zerstörer (2)", "Zerstörer (2)", "Zerstörer (2)"];

// Lokaler Setup-Zustand
let svSelectedShipIndex = null;
let svDirection = "right"; // "right" | "left" | "down" | "up"
let svHoverCells = [];
let svHoverValid = true;    // ob die aktuelle Hover-Position eine gültige Platzierung wäre
let svDragState = null;     // Zieht man zum Platzieren, wird die Richtung per Drag bestimmt
let svPlacementAnchor = null; // { row, col } – gesetzter Fixpunkt; null wenn noch kein Ankerpunkt

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

  const imReady = state.readyToStart && state.readyToStart[mySeat];

  // Warte-Ansicht: Spieler hat "Spiel starten" geklickt
  if (imReady) {
    const setupArea = document.getElementById("svSetupArea");
    if (setupArea) {
      setupArea.innerHTML = `<div class="sv-setup-done">
        <p>✅ Du bist bereit! Warte auf ${state.players[1 - mySeat]}…</p>
        <div class="sv-grid-label" style="margin-top:10px;">Dein Spielfeld</div>
        <div id="svWaitGrid" class="sv-grid"></div>
      </div>`;
      renderSvGridReadonly("svWaitGrid", myBoard.grid, true);
    }
    return;
  }

  // Hinweis-Text je nach Zustand aktualisieren
  const hintEl = document.getElementById("svHintText");
  if (hintEl) {
    if (svSelectedShipIndex === null) {
      hintEl.textContent = "Schiff aus der Liste auswählen.";
    } else if (!svPlacementAnchor) {
      hintEl.textContent = "Auf ein Feld klicken oder in die gewünschte Richtung ziehen um das Schiff zu setzen.";
    } else {
      hintEl.textContent = "Ziehen um das Schiff zu drehen · Auf das Schiff klicken um es zu entfernen.";
    }
  }

  // Normale Setup-Ansicht
  renderSvShipList(myBoard);

  // Hover-Zellen aus Anker aktualisieren, wenn Anker gesetzt
  if (svPlacementAnchor && svSelectedShipIndex !== null) {
    svComputeHoverCells(svPlacementAnchor.row, svPlacementAnchor.col);
  }

  renderSvSetupGrid(myBoard);

  // Bestätigen-Button oder "Spiel starten"-Button
  const startArea = document.getElementById("svStartBtnArea");
  if (startArea) {
    const allPlaced = state.setupComplete && state.setupComplete[mySeat];

    if (svPlacementAnchor && svSelectedShipIndex !== null) {
      // Anker gesetzt: Bestätigen-Button zeigen
      if (svHoverValid) {
        startArea.innerHTML = `<button id="svConfirmBtn" class="btn-primary sv-confirm-btn">✓ Schiff bestätigen</button>`;
        document.getElementById("svConfirmBtn").addEventListener("click", svConfirmPlacement);
      } else {
        startArea.innerHTML = `<span class="sv-invalid-hint">Position ungültig</span>`;
      }
    } else if (allPlaced) {
      startArea.innerHTML = `<button id="svStartBtn" class="btn-primary sv-start-btn">Spiel starten ▶</button>`;
      document.getElementById("svStartBtn").addEventListener("click", () => {
        if (!room) return;
        socket.emit("sv_ready", { code: room.code });
      });
    } else {
      startArea.innerHTML = "";
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
    // Platzierte Schiffe bekommen eine Neu-Setzen-Schaltfläche statt des ✓
    const statusHtml = placed
      ? `<span class="sv-ship-replace" title="Neu platzieren">✏️</span>`
      : "";
    html += `<li class="sv-ship-item${placed ? " sv-ship-placed sv-ship-replaceable" : ""}${selected ? " sv-ship-selected" : ""}" data-idx="${idx}">
      <span class="sv-ship-name">${SV_SHIP_NAMES[idx]}</span>
      <span class="sv-ship-cells">${"▪".repeat(size)}</span>
      ${statusHtml}
    </li>`;
  });
  html += "</ul>";
  container.innerHTML = html;

  // Unplatzierte Schiffe: auswählen
  container.querySelectorAll(".sv-ship-item:not(.sv-ship-placed)").forEach(li => {
    li.onclick = () => {
      const idx = Number(li.dataset.idx);
      if (svSelectedShipIndex === idx) {
        svSelectedShipIndex = null;
        svPlacementAnchor = null;
        svHoverCells = [];
      } else {
        svSelectedShipIndex = idx;
        svPlacementAnchor = null;
        svHoverCells = [];
      }
      renderSvSetup();
    };
  });

  // Platzierte Schiffe: neu setzen (entfernen + auswählen)
  container.querySelectorAll(".sv-ship-item.sv-ship-replaceable").forEach(li => {
    li.onclick = () => {
      if (!room) return;
      const idx = Number(li.dataset.idx);
      svSelectedShipIndex = idx;
      svPlacementAnchor = null;
      svHoverCells = [];
      socket.emit("sv_remove_ship", { code: room.code, shipIndex: idx });
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
      const isTentative = svPlacementAnchor && svHoverCells.some(h => h.r === r && h.c === c);

      if (val === "ship") {
        cell.classList.add("sv-cell-ship");
        // Klick auf platziertes Schiff → entfernen, Listeneintrag reaktivieren
        cell.addEventListener("click", () => svRemoveShipAtCell(r, c, board));
      } else if (isTentative) {
        // Tentative Platzierung (Anker gesetzt, noch nicht bestätigt)
        cell.classList.add(svHoverValid ? "sv-cell-tentative" : "sv-cell-hover-invalid");
        if (svHoverValid) {
          // Klick auf tentatives Schiff → Anker aufheben
          cell.addEventListener("click", () => {
            svPlacementAnchor = null;
            svHoverCells = [];
            renderSvSetup();
          });
        }
      } else if (!svPlacementAnchor && svHoverCells.some(h => h.r === r && h.c === c)) {
        // Normaler Hover-Preview (kein Anker gesetzt)
        cell.classList.add(svHoverValid ? "sv-cell-hover" : "sv-cell-hover-invalid");
      }

      // Maus-Hover für Desktop (nur wenn kein Anker gesetzt)
      if (!svPlacementAnchor) {
        cell.addEventListener("mouseenter", () => svOnHover(r, c));
        cell.addEventListener("mouseleave", () => svClearHover());
      }

      container.appendChild(cell);
    }
  }

  // Pointer-Events (Maus + Touch) für Drag-Richtungserkennung
  svAttachGridPointerEvents(container);
}

// ---- Hover / Positionsberechnung ----

// Berechnet Zellpositionen anhand von Ankerpunkt und Richtung (client-seitig)
function svGetCellsForDirection(row, col, length, direction) {
  const cells = [];
  for (let i = 0; i < length; i++) {
    let r = row, c = col;
    if (direction === "right") c = col + i;
    else if (direction === "left") c = col - i;
    else if (direction === "down") r = row + i;
    else if (direction === "up") r = row - i;
    cells.push({ r, c });
  }
  return cells;
}

// Nur berechnen, nicht rendern
function svComputeHoverCells(row, col) {
  if (svSelectedShipIndex === null) {
    svHoverCells = [];
    return;
  }
  const myBoard = svGetMyBoard();
  if (!myBoard) return;
  const ship = myBoard.ships[svSelectedShipIndex];
  if (!ship || ship.cells.length > 0) {
    svHoverCells = [];
    return;
  }

  svHoverCells = svGetCellsForDirection(row, col, ship.length, svDirection)
    .filter(({ r, c }) => r >= 0 && r < 10 && c >= 0 && c < 10);
  svHoverValid = svClientCanPlace(myBoard.grid, ship.length, row, col, svDirection);
}

// Berechnen + Grid neu rendern (für Maus-Events ohne Anker)
function svOnHover(row, col) {
  if (svSelectedShipIndex === null) return;
  if (svPlacementAnchor) return; // Anker gesetzt → Position nicht per Hover ändern
  svComputeHoverCells(row, col);
  const myBoard = svGetMyBoard();
  if (myBoard) renderSvSetupGrid(myBoard);
}

function svClearHover() {
  if (svPlacementAnchor) return; // Anker gesetzt → nicht löschen
  svHoverCells = [];
  const myBoard = svGetMyBoard();
  if (myBoard) renderSvSetupGrid(myBoard);
}

// Client-seitige Platzierungsprüfung (spiegelt die Server-Logik inkl. Abstandsregel)
// direction: "right" | "left" | "down" | "up"
function svClientCanPlace(grid, length, row, col, direction) {
  for (const { r, c } of svGetCellsForDirection(row, col, length, direction)) {
    if (r < 0 || r >= 10 || c < 0 || c >= 10) return false;
    if (grid[r][c] !== null) return false;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10 && grid[nr][nc] === "ship") return false;
    }
  }
  return true;
}

// ---- Platzierung bestätigen ----

function svConfirmPlacement() {
  if (svSelectedShipIndex === null || !svPlacementAnchor || !svHoverValid) return;
  if (!room) return;

  const justPlacedIndex = svSelectedShipIndex;
  socket.emit("sv_place_ship", {
    code: room.code,
    shipIndex: svSelectedShipIndex,
    row: svPlacementAnchor.row,
    col: svPlacementAnchor.col,
    direction: svDirection
  });

  svPlacementAnchor = null;
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

// Platziertes Schiff im Grid per Klick entfernen
function svRemoveShipAtCell(r, c, board) {
  if (!room) return;
  for (let i = 0; i < board.ships.length; i++) {
    const ship = board.ships[i];
    if (ship && ship.cells.some(cell => cell.row === r && cell.col === c)) {
      svPlacementAnchor = null;
      svHoverCells = [];
      svSelectedShipIndex = i;
      socket.emit("sv_remove_ship", { code: room.code, shipIndex: i });
      return;
    }
  }
}


// Pointer-Events einmalig am Grid-Container registrieren.
// Phase 1: Klick (kein Drag) → Anker setzen.
// Phase 2: Drag vom Anker → Ausrichtung bestimmen (rechts/links = waagerecht, oben/unten = senkrecht).
// Phase 3: "Bestätigen"-Button klicken → Schiff platzieren.
function svAttachGridPointerEvents(container) {
  if (container.dataset.svListeners) return; // Nur einmal anhängen
  container.dataset.svListeners = "1";

  container.addEventListener("pointerdown", e => {
    if (svSelectedShipIndex === null) return;
    const cell = e.target.closest(".sv-cell");
    if (!cell) return;

    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);

    svDragState = {
      startRow: row,
      startCol: col,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
    };

    // Hover-Preview vom angeklickten Feld anzeigen (nur wenn noch kein Anker)
    if (!svPlacementAnchor) {
      svComputeHoverCells(row, col);
      const myBoard = svGetMyBoard();
      if (myBoard) renderSvSetupGrid(myBoard);
    }
  });

  container.addEventListener("pointermove", e => {
    if (!svDragState) {
      // Touch-Hover ohne aktiven Drag: Vorschau unter dem Finger (nur ohne Anker)
      if (e.pointerType !== "mouse" && !svPlacementAnchor) {
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
      // Richtung aus der Drag-Geste ableiten (alle 4 Richtungen)
      let newDirection;
      if (Math.abs(dx) >= Math.abs(dy)) {
        newDirection = dx >= 0 ? "right" : "left";
      } else {
        newDirection = dy >= 0 ? "down" : "up";
      }
      if (newDirection !== svDirection) {
        svDirection = newDirection;
      }
      // Preview vom Anker (wenn gesetzt) oder vom Drag-Start aktualisieren
      const anchorRow = svPlacementAnchor ? svPlacementAnchor.row : svDragState.startRow;
      const anchorCol = svPlacementAnchor ? svPlacementAnchor.col : svDragState.startCol;
      svComputeHoverCells(anchorRow, anchorCol);
      const myBoard = svGetMyBoard();
      if (myBoard) renderSvSetupGrid(myBoard);
    }
  });

  container.addEventListener("pointerup", e => {
    if (!svDragState) return;
    const { startRow, startCol } = svDragState;
    svDragState = null;

    // Kein Anker noch gesetzt → jetzt setzen (egal ob Tap oder Drag)
    if (!svPlacementAnchor) {
      svPlacementAnchor = { row: startRow, col: startCol };
      svComputeHoverCells(startRow, startCol);
      renderSvSetup(); // Bestätigen-Button einblenden
    }
    // Anker bereits gesetzt → Ausrichtung wurde während Drag aktualisiert; nichts weiter tun
  });

  container.addEventListener("pointercancel", () => {
    svDragState = null;
    if (!svPlacementAnchor) svClearHover();
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
