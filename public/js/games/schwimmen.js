function formatSchwimmenCard(card) {
      if (!card) return "🂠";
      return `${card.rank}${card.suit}`;
    }

function isSchwimmenRedSuit(card) {
      return card && (card.suit === "♥" || card.suit === "♦");
    }

function renderSchwimmenRow(container, cards, { selectable, selectedIndex, onSelect, hideCards }) {
      if (!container) return;
      container.innerHTML = "";
      cards.forEach((card, index) => {
        const el = document.createElement("div");
        el.className = "card";
        if (hideCards) {
          el.textContent = "🂠";
          el.classList.add("inactive");
        } else {
          el.textContent = formatSchwimmenCard(card);
          if (isSchwimmenRedSuit(card)) el.classList.add("red");
        }
        if (selectedIndex === index) el.classList.add("selected");
        if (!selectable) el.classList.add("inactive");
        if (selectable && !hideCards) {
          el.onclick = () => onSelect(index);
        }
        container.appendChild(el);
      });
    }

function renderSchwimmenScores() {
      const container = document.getElementById("schwimmenScores");
      if (!container) return;
      if (!state || !state.scores || state.scores.length === 0) {
        container.innerHTML = "";
        return;
      }
      let html = "<table class='score-table'><thead><tr><th>Spieler</th><th>Punkte</th></tr></thead><tbody>";
      state.players.forEach((name, index) => {
        const score = state.scores[index];
        html += `<tr><td>${escapeHtml(name)}</td><td>${score ?? "-"}</td></tr>`;
      });
      html += "</tbody></table>";
      container.innerHTML = html;
    }

function renderSchwimmenHistoryTable() {
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
      let html = "<h3>Spielverlauf</h3><table>";
      html += "<tr><th rowspan='2'>Runde</th>";
      players.forEach((name, i) => {
        const isOut = state.eliminated?.[i];
        const displayName = isOut ? `${escapeHtml(name)} (aus)` : escapeHtml(name);
        html += `<th colspan="2" style="color:${playerTextColors[i % playerTextColors.length]};">${displayName}</th>`;
      });
      html += "</tr>";

      html += "<tr>";
      players.forEach(() => {
        html += "<th>🂠</th><th>❤️</th>";
      });
      html += "</tr>";

      for (let i = history.length - 1; i >= 0; i--) {
        const r = history[i];
        html += `<tr><td>${i + 1}</td>`;
        players.forEach((_, p) => {
          const entry = r[p];
          if (!entry) {
            html += "<td>-</td><td>-</td>";
            return;
          }
          const scoreLabel = entry.score === null || typeof entry.score === "undefined" ? "-" : entry.score;
          let livesLabel = entry.lives ?? "-";
          if (entry.eliminated) {
            livesLabel = "aus";
          } else if (entry.swimming) {
            livesLabel = "🏊";
          }
          html += `<td>${scoreLabel}</td><td>${livesLabel}</td>`;
        });
        html += "</tr>";
      }

      html += "</table>";
      historyContainer.innerHTML = html;
    }

function renderSchwimmenGame() {
      if (!state) return;
      document.getElementById("kniffelView").style.display = "none";
      document.getElementById("kwyxView").style.display = "none";
      document.getElementById("schockenView").style.display = "none";
      document.getElementById("schwimmenView").style.display = "block";
      document.getElementById("skatView").style.display = "none";

      const currentName = state.players[state.currentPlayer] || "-";
      document.getElementById("playerDisplay").textContent = `Am Zug: ${currentName}`;

      const colorIdx = state.currentPlayer % playerTextColors.length;
      document.getElementById("playerDisplay").style.color = playerTextColors[colorIdx];
      setBodyBackgroundColor(playerBgColors[colorIdx]);

      const myTurn = isMyTurn();
      if (!myTurn || state.finished || state.roundPending) {
        selectedHandIndex = null;
        selectedTableIndex = null;
      }
      const myHand = mySeat >= 0 ? (state.hands?.[mySeat] || []) : [null, null, null];
      const tableCards = state.tableCards || [];

      renderSchwimmenRow(
        document.getElementById("schwimmenTable"),
        tableCards,
        {
          selectable: myTurn && !state.finished,
          selectedIndex: selectedTableIndex,
          onSelect: (index) => {
            if (!myTurn) return;
            selectedTableIndex = selectedTableIndex === index ? null : index;
            renderSchwimmenGame();
          },
          hideCards: false
        }
      );
      renderSchwimmenRow(
        document.getElementById("schwimmenHand"),
        myHand,
        {
          selectable: myTurn && !state.finished,
          selectedIndex: selectedHandIndex,
          onSelect: (index) => {
            if (!myTurn) return;
            selectedHandIndex = selectedHandIndex === index ? null : index;
            renderSchwimmenGame();
          },
          hideCards: mySeat < 0 && !state.finished
        }
      );

      const swapBtn = document.getElementById("schwimmenSwapBtn");
      const swapAllBtn = document.getElementById("schwimmenSwapAllBtn");
      const passBtn = document.getElementById("schwimmenPassBtn");
      const knockBtn = document.getElementById("schwimmenKnockBtn");
      const nextRoundBtn = document.getElementById("schwimmenNextRoundBtn");

      const canActNow = myTurn && !state.finished && !state.roundPending;
      if (swapBtn) swapBtn.disabled = !canActNow || selectedHandIndex === null || selectedTableIndex === null;
      if (swapAllBtn) swapAllBtn.disabled = !canActNow;
      if (passBtn) passBtn.disabled = !canActNow;
      if (knockBtn) knockBtn.disabled = !canActNow || state.knockedBy !== null;
      if (nextRoundBtn) {
        const showNextRound = !!state.roundPending && !state.finished;
        const canStartNext = showNextRound && (mySeat === state.nextStartingSeat || isHost);
        nextRoundBtn.style.display = showNextRound ? "inline-block" : "none";
        nextRoundBtn.disabled = !canStartNext;
      }

      document.getElementById("turnHint").textContent = "";
      document.getElementById("backToLobbyWrap").style.display = isHost ? "block" : "none";
      updateDeckelToggleState();
      updateLobbyVisibility();

      const myTurnNow = myTurn;
      if (myTurnNow && !wasMyTurn) {
        notifyMyTurn(currentName);
      }
      wasMyTurn = myTurnNow;

      const knockInfo = state.knockedBy !== null && !state.finished
        ? `Geklopft von ${state.players[state.knockedBy]} · noch ${state.lastTurnsRemaining} Züge`
        : "";
      const nextRoundInfo = state.roundPending && !state.finished
        ? `Neue Runde wartet auf ${state.players[state.nextStartingSeat] ?? "?"}`
        : "";
      const roundMessage = state.roundPending ? "" : state.message;
      const info = [roundMessage, knockInfo, nextRoundInfo].filter(Boolean).join(" · ");
      document.getElementById("schwimmenResult").textContent = info;

      renderSchwimmenScores();
      renderSchwimmenHistoryTable();
    }
