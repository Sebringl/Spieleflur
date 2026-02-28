    // Kwyx-Farbreihen und deren Labels.
    const kwyxRows = ["red", "yellow", "green", "blue"];
    const kwyxRowLabels = {
      red: "Rot",
      yellow: "Gelb",
      green: "Grün",
      blue: "Blau"
    };
    const kwyxNumbers = {
      red: Array.from({ length: 11 }, (_, i) => i + 2),
      yellow: Array.from({ length: 11 }, (_, i) => i + 2),
      green: Array.from({ length: 11 }, (_, i) => 12 - i),
      blue: Array.from({ length: 11 }, (_, i) => 12 - i)
    };

    function getKwyxDiceSums() {
      const whiteA = state?.dice?.[0];
      const whiteB = state?.dice?.[1];
      const whiteSum = (Number.isFinite(whiteA) && Number.isFinite(whiteB)) ? whiteA + whiteB : null;
      const colorDice = {
        red: state?.dice?.[2],
        yellow: state?.dice?.[3],
        green: state?.dice?.[4],
        blue: state?.dice?.[5]
      };
      const colorSums = {};
      kwyxRows.forEach(color => {
        const die = colorDice[color];
        if (Number.isFinite(die) && Number.isFinite(whiteA) && Number.isFinite(whiteB)) {
          colorSums[color] = Array.from(new Set([whiteA + die, whiteB + die]));
        } else {
          colorSums[color] = [];
        }
      });
      return { whiteSum, colorSums };
    }

    function resetKwyxSelections() {
      kwyxSelections = { whiteRow: "", colorRow: "", colorSum: "", penalty: false };
      updateKwyxSelectionSummary();
    }

    function updateKwyxSelectionSummary() {
      return;
    }

    function getKwyxCountdownSeconds() {
      if (!state || !state.kwyxCountdownEndsAt) return null;
      const remainingMs = state.kwyxCountdownEndsAt - Date.now();
      if (remainingMs <= 0) return 0;
      return Math.ceil(remainingMs / 1000);
    }

    function updateKwyxEndButton() {
      const endBtn = document.getElementById("kwyxEndTurnBtn");
      if (!endBtn || !state) return;
      const myEnded = !!state.kwyxEnded?.[mySeat];
      const hasSelection = !!(kwyxSelections.whiteRow || kwyxSelections.colorRow || kwyxSelections.penalty);
      const canEnd = mySeat >= 0
        && !state.finished
        && state.throwCount > 0
        && !myEnded
        && hasSelection;
      endBtn.disabled = !canEnd;

      const countdown = getKwyxCountdownSeconds();
      const baseLabel = myEnded ? "Zug beendet" : "Zug beenden";
      endBtn.textContent = countdown !== null ? `${baseLabel} (${countdown}s)` : baseLabel;
    }

    function stopKwyxCountdownTimer() {
      if (kwyxCountdownTimer) {
        clearInterval(kwyxCountdownTimer);
        kwyxCountdownTimer = null;
      }
    }

    function updateKwyxCountdownTimer() {
      const countdown = getKwyxCountdownSeconds();
      if (countdown === null || !isKwyxGame()) {
        stopKwyxCountdownTimer();
        updateKwyxEndButton();
        return;
      }
      updateKwyxEndButton();
      if (!kwyxCountdownTimer) {
        kwyxCountdownTimer = setInterval(() => {
          if (!isKwyxGame() || !state) {
            stopKwyxCountdownTimer();
            return;
          }
          if (getKwyxCountdownSeconds() === null) {
            stopKwyxCountdownTimer();
          }
          updateKwyxEndButton();
        }, 250);
      }
    }

    function renderKwyxCardRows({ allowWhiteSelect, allowColorSelect, allowPenalty }) {
      const container = document.getElementById("kwyxCardRows");
      if (!container || !state) return;

      const card = state.scorecards?.[mySeat];
      const highlightColor = getKwyxHighlightColor();
      const { whiteSum, colorSums } = getKwyxDiceSums();
      const allowSelect = allowWhiteSelect || allowColorSelect;

      container.innerHTML = "";
      kwyxRows.forEach(color => {
        const row = document.createElement("div");
        row.className = `kwyx-row ${color}`;
        if (highlightColor === color) {
          row.classList.add(`highlight-${color}`);
        }
        const cells = document.createElement("div");
        cells.className = "kwyx-cells";
        const numbers = kwyxNumbers[color];
        const lastValue = numbers[numbers.length - 1];
        numbers.forEach((value, index) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "kwyx-cell";
          btn.textContent = String(value);

          const marked = !!card?.[color]?.[index];
          if (marked) btn.classList.add("marked");
          const locked = !!state.rowLocks?.[color];

          const canSelectWhite = allowWhiteSelect && Number.isFinite(whiteSum) && value === whiteSum;
          const canSelectColor = allowColorSelect && colorSums[color]?.includes(value);
          if (!allowSelect || marked || locked || (!canSelectWhite && !canSelectColor)) {
            if (locked) btn.classList.add("inactive");
          } else {
            btn.onclick = () => {
              if (marked || locked) return;
              kwyxSelections.penalty = false;
              const isWhiteSelected = kwyxSelections.whiteRow === color && whiteSum === value;
              const isColorSelected = kwyxSelections.colorRow === color && Number(kwyxSelections.colorSum) === value;
              if (isWhiteSelected) {
                kwyxSelections.whiteRow = "";
              } else if (isColorSelected) {
                kwyxSelections.colorRow = "";
                kwyxSelections.colorSum = "";
              } else if (canSelectWhite && (!kwyxSelections.whiteRow || !canSelectColor)) {
                kwyxSelections.whiteRow = color;
              } else if (canSelectColor) {
                kwyxSelections.colorRow = color;
                kwyxSelections.colorSum = String(value);
              }
              renderKwyxCardRows({ allowWhiteSelect, allowColorSelect, allowPenalty });
              updateKwyxSelectionSummary();
              updateKwyxEndButton();
            };
          }

          if (kwyxSelections.whiteRow === color && whiteSum === value) {
            btn.classList.add("selected-white");
          }
          if (kwyxSelections.colorRow === color && Number(kwyxSelections.colorSum) === value) {
            btn.classList.add(`selected-color-${color}`);
          }

          cells.appendChild(btn);
        });

        const lockCell = document.createElement("button");
        lockCell.type = "button";
        lockCell.className = "kwyx-cell lock";
        lockCell.textContent = "🔒";
        if (state.rowLocks?.[color]) {
          lockCell.classList.add("locked");
        }
          const canSelectLockWhite = allowWhiteSelect && Number.isFinite(whiteSum) && lastValue === whiteSum;
          const canSelectLockColor = allowColorSelect && colorSums[color]?.includes(lastValue);
          if (!allowSelect || state.rowLocks?.[color] || (!canSelectLockWhite && !canSelectLockColor)) {
            if (state.rowLocks?.[color]) lockCell.classList.add("inactive");
          } else {
            lockCell.onclick = () => {
            if (state.rowLocks?.[color]) return;
            kwyxSelections.penalty = false;
            const isWhiteSelected = kwyxSelections.whiteRow === color && whiteSum === lastValue;
            const isColorSelected = kwyxSelections.colorRow === color && Number(kwyxSelections.colorSum) === lastValue;
            if (isWhiteSelected) {
              kwyxSelections.whiteRow = "";
            } else if (isColorSelected) {
              kwyxSelections.colorRow = "";
              kwyxSelections.colorSum = "";
            } else if (canSelectLockWhite && (!kwyxSelections.whiteRow || !canSelectLockColor)) {
              kwyxSelections.whiteRow = color;
            } else if (canSelectLockColor) {
              kwyxSelections.colorRow = color;
              kwyxSelections.colorSum = String(lastValue);
            }
            renderKwyxCardRows({ allowWhiteSelect, allowColorSelect, allowPenalty });
            updateKwyxSelectionSummary();
            updateKwyxEndButton();
          };
        }
        if (kwyxSelections.whiteRow === color && whiteSum === lastValue) {
          lockCell.classList.add("selected-white");
        }
        if (kwyxSelections.colorRow === color && Number(kwyxSelections.colorSum) === lastValue) {
          lockCell.classList.add(`selected-color-${color}`);
        }
        cells.appendChild(lockCell);
        row.appendChild(cells);

        container.appendChild(row);
      });

      const penaltyRow = document.createElement("div");
      penaltyRow.className = "kwyx-row penalty";
      const penaltyLabel = document.createElement("div");
      penaltyLabel.className = "kwyx-row-label";
      penaltyLabel.textContent = "Strafwürfe";
      penaltyRow.appendChild(penaltyLabel);
      const penaltyCells = document.createElement("div");
      penaltyCells.className = "kwyx-cells";
      const strikes = card?.strikes ?? 0;
      const canSelectPenalty = allowPenalty && strikes < 4;
      for (let i = 0; i < 4; i++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kwyx-cell";
        const isFilled = i < strikes;
        btn.textContent = isFilled ? "X" : "";
        if (!canSelectPenalty || isFilled) {
          btn.classList.add("inactive");
        } else {
          btn.onclick = () => {
            if (kwyxSelections.penalty) {
              kwyxSelections = { whiteRow: "", colorRow: "", colorSum: "", penalty: false };
            } else {
              kwyxSelections = { whiteRow: "", colorRow: "", colorSum: "", penalty: true };
            }
            renderKwyxCardRows({ allowWhiteSelect, allowColorSelect, allowPenalty });
            updateKwyxSelectionSummary();
            updateKwyxEndButton();
          };
        }
        if (kwyxSelections.penalty && i === strikes) {
          btn.classList.add("selected-penalty");
        }
        penaltyCells.appendChild(btn);
      }
      penaltyRow.appendChild(penaltyCells);
      container.appendChild(penaltyRow);

      updateKwyxSelectionSummary();
      updateKwyxEndButton();
    }

    function renderKwyxGame() {
      if (!state) return;
      document.getElementById("schockenView").style.display = "none";
      document.getElementById("kniffelView").style.display = "none";
      document.getElementById("kwyxView").style.display = "block";
      document.getElementById("schwimmenView").style.display = "none";
      document.getElementById("skatView").style.display = "none";
      document.getElementById("historyTable").style.display = "none";
      document.getElementById("historyTable").innerHTML = "";

      const currentName = state.players[state.currentPlayer] || "-";
      if (state.finished) {
        document.getElementById("playerDisplay").textContent = state.winner ? `Sieger: ${state.winner}` : "Spiel beendet";
        document.getElementById("playerDisplay").style.color = "";
        setBodyBackgroundColor("");
      } else {
        document.getElementById("playerDisplay").textContent = `Am Zug: ${currentName}`;
        const colorIdx = state.currentPlayer % playerTextColors.length;
        document.getElementById("playerDisplay").style.color = playerTextColors[colorIdx];
        setBodyBackgroundColor(playerBgColors[colorIdx]);
      }

      const diceElements = [
        "kwyxDieWhite0",
        "kwyxDieWhite1",
        "kwyxDieRed",
        "kwyxDieYellow",
        "kwyxDieGreen",
        "kwyxDieBlue"
      ];
      diceElements.forEach((id, idx) => {
        const el = document.getElementById(id);
        if (!el) return;
        const val = state.dice?.[idx];
        el.textContent = val ? diceSymbols[val - 1] : "□";
        const isColorDie = idx >= 2;
        el.classList.toggle("inactive", !isMyTurn() && isColorDie);
      });

      const myTurn = isMyTurn();
      const rollBtn = document.getElementById("kwyxRollBtn");
      rollBtn.disabled = !myTurn || state.throwCount >= state.maxThrowsThisRound || state.finished;
      rollBtn.textContent = state.throwCount >= state.maxThrowsThisRound ? "Bereits gewürfelt" : "Würfeln";

      updateKwyxEndButton();

      const kwyxTurnHint = document.getElementById("kwyxTurnHint");
      if (kwyxTurnHint) {
        const countdown = getKwyxCountdownSeconds();
        const myEnded = !!state.kwyxEnded?.[mySeat];
        const hasSelection = !!(kwyxSelections.whiteRow || kwyxSelections.colorRow || kwyxSelections.penalty);
        const showPassiveCountdownHint = countdown !== null
          && !myTurn
          && !myEnded
          && mySeat >= 0
          && !hasSelection;
        kwyxTurnHint.textContent = showPassiveCountdownHint
          ? "Countdown läuft – du hast noch kein Feld ausgewählt."
          : "";
      }
      document.getElementById("turnHint").textContent = "";
      document.getElementById("backToLobbyWrap").style.display = canShowBackToLobby() ? "block" : "none";
      updateDeckelToggleState();
      updateLobbyVisibility();

      const myTurnNow = myTurn;
      if (myTurnNow && !wasMyTurn) {
        notifyMyTurn(currentName);
      }
      wasMyTurn = myTurnNow;

      if (state.throwCount === 0 || state.currentPlayer !== lastKwyxPlayer || state.throwCount !== lastKwyxThrowCount) {
        if (state.throwCount === 0) resetKwyxSelections();
        lastKwyxPlayer = state.currentPlayer;
        lastKwyxThrowCount = state.throwCount;
      }

      const myEnded = !!state.kwyxEnded?.[mySeat];
      const canInteract = state.throwCount > 0 && !state.finished && mySeat >= 0 && !myEnded;
      const allowWhiteSelect = canInteract;
      const allowColorSelect = canInteract && myTurn;
      const allowPenalty = canInteract && myTurn;
      if (!allowColorSelect && (kwyxSelections.colorRow || kwyxSelections.colorSum)) {
        kwyxSelections.colorRow = "";
        kwyxSelections.colorSum = "";
      }
      if (!allowPenalty && kwyxSelections.penalty) {
        kwyxSelections.penalty = false;
      }
      renderKwyxCardRows({ allowWhiteSelect, allowColorSelect, allowPenalty });

      const msg = state.message || "";
      document.getElementById("kwyxResult").textContent = msg;

      updateKwyxCountdownTimer();
    }
