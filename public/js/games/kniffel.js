    // Anzeigenamen der Kniffel-Kategorien.
    const kniffelCategories = [
      { key: "ones", label: "Einer" },
      { key: "twos", label: "Zweier" },
      { key: "threes", label: "Dreier" },
      { key: "fours", label: "Vierer" },
      { key: "fives", label: "Fünfer" },
      { key: "sixes", label: "Sechser" },
      { key: "threeKind", label: "Dreierpasch", pointsInfo: "Würfelsumme" },
      { key: "fourKind", label: "Viererpasch", pointsInfo: "Würfelsumme" },
      { key: "fullHouse", label: "Full House", pointsInfo: "25" },
      { key: "smallStraight", label: "Kleine Straße", pointsInfo: "30" },
      { key: "largeStraight", label: "Große Straße", pointsInfo: "40" },
      { key: "yahtzee", label: "Yahtzee", pointsInfo: "50" },
      { key: "chance", label: "Chance", pointsInfo: "Würfelsumme" }
    ];
    const kniffelUpperKeys = kniffelCategories.slice(0, 6).map(cat => cat.key);
    const kniffelLowerKeys = kniffelCategories.slice(6).map(cat => cat.key);

    function getKniffelTotals(card = {}) {
      const sumValues = (keys) => keys.reduce((sum, key) => {
        const value = card[key];
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);
      const upperSum = sumValues(kniffelUpperKeys);
      const bonus = upperSum >= 63 ? 35 : 0;
      const lowerSum = sumValues(kniffelLowerKeys);
      const upperTotal = upperSum + bonus;
      const grandTotal = upperTotal + lowerSum;
      return { upperSum, bonus, lowerSum, upperTotal, grandTotal };
    }


    function renderKniffelScoreTable(myTurn) {
      if (!state || !Array.isArray(state.scorecard)) {
        document.getElementById("kniffelScoreTable").innerHTML = "";
        return;
      }
      const canInteract = myTurn && !state.finished;
      const upperCategories = kniffelCategories.slice(0, 6);
      const lowerCategories = kniffelCategories.slice(6);
      const fallbackPlayers = state.scorecard.map((_, idx) => `Spieler ${idx + 1}`);
      const playerNames = (Array.isArray(state.players) && state.players.length > 0)
        ? state.players
        : fallbackPlayers;
      const totalsByPlayer = playerNames.map((_, pIdx) => getKniffelTotals(state.scorecard[pIdx] || {}));
      let html = "<h3>Scorecard</h3><table class='score-table'>";
      html += "<tr><th>Kategorie</th>";
      playerNames.forEach((name, i) => {
        html += `<th style="color:${playerTextColors[i % playerTextColors.length]};">${escapeHtml(name)}</th>`;
      });
      html += "</tr>";

      upperCategories.forEach(cat => {
        html += `<tr><td>${cat.label}</td>`;
        playerNames.forEach((_, pIdx) => {
          const val = state.scorecard[pIdx]?.[cat.key];
          const isEmpty = val === null || typeof val === "undefined";
          if (pIdx === mySeat && isEmpty) {
            const isSelected = kniffelSelectedCategory === cat.key;
            const label = isSelected ? "✓" : "-";
            const classes = [
              "kniffel-cell-button",
              isSelected ? "selected" : "",
              canInteract ? "selectable" : ""
            ].filter(Boolean).join(" ");
            const disabledAttr = canInteract ? "" : "disabled";
            html += `<td class="kniffel-score-cell"><button type="button" class="${classes}" data-category="${cat.key}" ${disabledAttr}>${label}</button></td>`;
          } else {
            const label = isEmpty ? "-" : val;
            html += `<td class="kniffel-score-cell"><span class="kniffel-cell-text">${label}</span></td>`;
          }
        });
        html += "</tr>";
      });

      html += "<tr class=\"kniffel-subtotal\"><th>Zwischensumme (oben)</th>";
      totalsByPlayer.forEach(totals => {
        html += `<td class="kniffel-score-cell"><span class="kniffel-cell-text">${totals.upperSum}</span></td>`;
      });
      html += "</tr>";

      const anyBonusAchieved = totalsByPlayer.some(totals => totals.bonus > 0);
      html += `<tr class="kniffel-subtotal"><th class="${anyBonusAchieved ? "bonus-achieved" : ""}">Bonus (ab 63)</th>`;
      totalsByPlayer.forEach(totals => {
        const cellClass = totals.bonus > 0 ? "bonus-achieved" : "";
        html += `<td class="kniffel-score-cell ${cellClass}"><span class="kniffel-cell-text">${totals.bonus}</span></td>`;
      });
      html += "</tr>";

      lowerCategories.forEach(cat => {
        const labelWithScore = cat.pointsInfo ? `${cat.label} (${cat.pointsInfo})` : cat.label;
        html += `<tr><td>${labelWithScore}</td>`;
        playerNames.forEach((_, pIdx) => {
          const val = state.scorecard[pIdx]?.[cat.key];
          const isEmpty = val === null || typeof val === "undefined";
          if (pIdx === mySeat && isEmpty) {
            const isSelected = kniffelSelectedCategory === cat.key;
            const label = isSelected ? "✓" : "-";
            const classes = [
              "kniffel-cell-button",
              isSelected ? "selected" : "",
              canInteract ? "selectable" : ""
            ].filter(Boolean).join(" ");
            const disabledAttr = canInteract ? "" : "disabled";
            html += `<td class="kniffel-score-cell"><button type="button" class="${classes}" data-category="${cat.key}" ${disabledAttr}>${label}</button></td>`;
          } else {
            const label = isEmpty ? "-" : val;
            html += `<td class="kniffel-score-cell"><span class="kniffel-cell-text">${label}</span></td>`;
          }
        });
        html += "</tr>";
      });

      html += "<tr class=\"kniffel-subtotal\"><th>Summe oberer Bereich</th>";
      totalsByPlayer.forEach(totals => {
        html += `<td class="kniffel-score-cell"><span class="kniffel-cell-text">${totals.upperTotal}</span></td>`;
      });
      html += "</tr>";

      html += "<tr class=\"kniffel-subtotal\"><th>Summe unterer Bereich</th>";
      totalsByPlayer.forEach(totals => {
        html += `<td class="kniffel-score-cell"><span class="kniffel-cell-text">${totals.lowerSum}</span></td>`;
      });
      html += "</tr>";

      html += "<tr><th>Gesamtsumme</th>";
      playerNames.forEach((_, pIdx) => {
        html += `<th>${totalsByPlayer[pIdx]?.grandTotal ?? 0}</th>`;
      });
      html += "</tr></table>";
      document.getElementById("kniffelScoreTable").innerHTML = html;
      const buttons = document.querySelectorAll("#kniffelScoreTable .kniffel-cell-button[data-category]");
      buttons.forEach(btn => {
        btn.addEventListener("click", () => {
          const category = btn.dataset.category || "";
          if (!category) return;
          if (kniffelSelectedCategory === category) {
            kniffelSelectedCategory = "";
          } else {
            kniffelSelectedCategory = category;
          }
          renderKniffelScoreTable(isMyTurn());
          updateKniffelEndButton();
        });
      });
    }

    function updateKniffelEndButton() {
      const endBtn = document.getElementById("kniffelEndTurnBtn");
      if (!endBtn || !state) return;
      const myTurn = isMyTurn();
      const card = state.scorecard?.[mySeat] || {};
      const categoryValue = card[kniffelSelectedCategory];
      const categoryAvailable = !!kniffelSelectedCategory && (categoryValue === null || typeof categoryValue === "undefined");
      endBtn.disabled = !myTurn || state.throwCount === 0 || state.dice.includes(null) || !categoryAvailable || state.finished;
    }

    // Baut die Kniffel-Ansicht aus dem aktuellen Spielzustand.
    function renderKniffelGame() {
      if (!state) return;
      document.getElementById("schockenView").style.display = "none";
      document.getElementById("kniffelView").style.display = "block";
      document.getElementById("kwyxView").style.display = "none";
      document.getElementById("schwimmenView").style.display = "none";
      document.getElementById("skatView").style.display = "none";
      document.getElementById("historyTable").style.display = "none";
      document.getElementById("historyTable").innerHTML = "";

      const currentName = state.players[state.currentPlayer] || "-";
      document.getElementById("playerDisplay").textContent = `Am Zug: ${currentName}`;

      const colorIdx = state.currentPlayer % playerTextColors.length;
      document.getElementById("playerDisplay").style.color = playerTextColors[colorIdx];
      setBodyBackgroundColor(playerBgColors[colorIdx]);

      const myTurn = isMyTurn();
      if (!myTurn || state.currentPlayer !== lastKniffelPlayer) {
        kniffelSelectedCategory = "";
      }
      lastKniffelPlayer = state.currentPlayer;
      const myCard = state.scorecard?.[mySeat] || {};
      if (kniffelSelectedCategory && (myCard[kniffelSelectedCategory] !== null && typeof myCard[kniffelSelectedCategory] !== "undefined")) {
        kniffelSelectedCategory = "";
      }
      const remaining = state.maxThrowsThisRound - state.throwCount;
      renderDiceGroup({
        idPrefix: "kniffelDie",
        count: 5,
        values: state.dice,
        held: state.held,
        myTurn,
        holdingEnabled: state.throwCount > 0 && remaining > 0,
        onToggle: (index) => socket.emit("action_toggle", { code: room.code, index })
      });
      const allHeld = state.held.every(h => h);
      const rollBtn = document.getElementById("kniffelRollBtn");
      rollBtn.textContent = allHeld ? "Alle Würfel gehalten" : `Würfeln (${remaining})`;
      rollBtn.disabled = !myTurn || allHeld || remaining <= 0 || state.finished;

      updateKniffelEndButton();

      document.getElementById("turnHint").textContent = "";
      document.getElementById("backToLobbyWrap").style.display = canShowBackToLobby() ? "block" : "none";
      updateDeckelToggleState();
      updateLobbyVisibility();

      const myTurnNow = myTurn;
      if (myTurnNow && !wasMyTurn) {
        notifyMyTurn(currentName);
      }
      wasMyTurn = myTurnNow;

      const msg = state.message || "";
      document.getElementById("kniffelResult").textContent = msg;

      renderKniffelScoreTable(myTurn);
    }
