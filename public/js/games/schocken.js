    function getSchockenRoundBestPlayerIndex(round) {
      const entries = round
        .map((entry, i) => ({ ...entry, index: i }))
        .filter(e => e && e.label && typeof e.tier !== "undefined");
      if (!entries.length) return null;
      entries.sort((a, b) => {
        if (a.tier !== b.tier) return b.tier - a.tier;
        if (a.subvalue !== b.subvalue) return b.subvalue - a.subvalue;
        if (a.throws !== b.throws) return a.throws - b.throws;
        return a.index - b.index;
      });
      return entries[0].index;
    }

    function renderSchockenHistoryTable() {
      const historyContainer = document.getElementById("historyTable");
      if (!historyContainer) return;
      if (!state || !state.history || !state.history.length) {
        historyContainer.innerHTML = "";
        historyContainer.style.display = "none";
        return;
      }

      historyContainer.style.display = "block";
      const players = state.players;
      const history = state.history;
      const useDeckel = !!state.useDeckel;
      const wins = state.wins || [];
      const deckelCount = state.deckelCount || [];

      let html = "<h3>Spielverlauf</h3><table>";
      html += "<tr><th rowspan='2'>Runde</th>";
      players.forEach((name, i) => {
        const displayName = useDeckel
          ? `${escapeHtml(name)} (${deckelCount[i] || 0})`
          : ((wins[i] > 0) ? `${escapeHtml(name)} (${wins[i]} 👑)` : escapeHtml(name));
        html += `<th colspan="2" style="color:${playerTextColors[i % playerTextColors.length]};">${displayName}</th>`;
      });
      html += "</tr>";

      html += "<tr>";
      players.forEach(() => {
        html += `<th>🎲</th><th>${useDeckel ? "Deckel" : "🔁"}</th>`;
      });
      html += "</tr>";

      for (let i = history.length - 1; i >= 0; i--) {
        const r = history[i];
        const winnerIndex = getSchockenRoundBestPlayerIndex(r);

        html += `<tr><td>${i + 1}</td>`;
        players.forEach((_, p) => {
          const entry = r[p];
          const isWinner = p === winnerIndex && entry;
          const cls = isWinner ? "winner" : "";
          if (entry) {
            html += `<td class="${cls}">${escapeHtml(entry.label)}</td>`;
            html += `<td class="${cls}">${useDeckel ? (deckelCount[p] || 0) : entry.throws}</td>`;
          } else {
            html += "<td>-</td><td>-</td>";
          }
        });
        html += "</tr>";
      }

      html += "</table>";
      historyContainer.innerHTML = html;
    }

    // Baut die Schocken-Ansicht aus dem aktuellen Spielzustand.
    function renderSchockenGame() {
      if (!state) return;
      document.getElementById("kniffelView").style.display = "none";
      document.getElementById("kwyxView").style.display = "none";
      document.getElementById("schockenView").style.display = "block";
      document.getElementById("schwimmenView").style.display = "none";
      document.getElementById("skatView").style.display = "none";

      const currentName = state.players[state.currentPlayer] || "-";
      document.getElementById("playerDisplay").textContent = `Am Zug: ${currentName}`;
      document.getElementById("roundDisplay").textContent = `Runde: ${state.roundNumber}`;

      const colorIdx = state.currentPlayer % playerTextColors.length;
      document.getElementById("playerDisplay").style.color = playerTextColors[colorIdx];
      setBodyBackgroundColor(playerBgColors[colorIdx]);

      const myTurn = isMyTurn();
      const remaining = state.maxThrowsThisRound - state.throwCount;
      renderDiceGroup({
        idPrefix: "die",
        count: 3,
        values: state.dice,
        held: state.held,
        myTurn,
        holdingEnabled: state.throwCount > 0 && remaining > 0,
        onToggle: (index) => socket.emit("action_toggle", { code: room.code, index })
      });
      const allHeld = state.held.every(h => h);

      const rollBtn = document.getElementById("rollBtn");
      rollBtn.textContent = allHeld ? "Alle Würfel gehalten" : `Würfeln (${remaining})`;
      rollBtn.disabled = !myTurn || allHeld || remaining <= 0;

      const endBtn = document.getElementById("endTurnBtn");
      endBtn.disabled = !myTurn || state.throwCount === 0 || state.dice.includes(null) || state.convertedThisTurn;

      document.getElementById("turnHint").textContent = "";
      document.getElementById("backToLobbyWrap").style.display = canShowBackToLobby() ? "block" : "none";
      updateDeckelToggleState();
      updateLobbyVisibility();

      const myTurnNow = myTurn;
      if (myTurnNow && !wasMyTurn) {
        notifyMyTurn(currentName);
      }
      wasMyTurn = myTurnNow;

      if (state.message) showGameMessage(state.message, false);

      renderSchockenHistoryTable();
    }
