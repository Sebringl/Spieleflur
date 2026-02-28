function formatSkatCard(card) {
      if (!card) return "🂠";
      return `${card.rank}${card.suit}`;
    }

function isSkatRedSuit(card) {
      return card && (card.suit === "♥" || card.suit === "♦");
    }

function renderSkatRow(container, cards, { selectable, onSelect, hideCards, selectedIndices = [] }) {
      if (!container) return;
      container.innerHTML = "";
      cards.forEach((card, index) => {
        const el = document.createElement("div");
        el.className = "card";
        if (hideCards) {
          el.textContent = "🂠";
          el.classList.add("inactive");
        } else {
          el.textContent = formatSkatCard(card);
          if (isSkatRedSuit(card)) el.classList.add("red");
        }
        if (selectedIndices.includes(index)) el.classList.add("selected");
        if (!selectable) el.classList.add("inactive");
        if (selectable && !hideCards) {
          el.onclick = () => onSelect(index);
        }
        container.appendChild(el);
      });
    }

function renderSkatGame() {
      if (!state) return;
      document.getElementById("kniffelView").style.display = "none";
      document.getElementById("kwyxView").style.display = "none";
      document.getElementById("schockenView").style.display = "none";
      document.getElementById("schwimmenView").style.display = "none";
      document.getElementById("skatView").style.display = "block";
      document.getElementById("schiffeversenkenView").style.display = "none";
      document.getElementById("historyTable").style.display = "none";
      document.getElementById("historyTable").innerHTML = "";

      const playerCount = state.players?.length || 0;
      const currentName = state.players?.[state.currentPlayer] || "-";
      document.getElementById("playerDisplay").textContent = `Am Zug: ${currentName}`;
      document.getElementById("playerDisplay").style.color = "";
      setBodyBackgroundColor("");

      document.getElementById("turnHint").textContent = "";
      document.getElementById("backToLobbyWrap").style.display = canShowBackToLobby() ? "block" : "none";
      updateDeckelToggleState();
      updateLobbyVisibility();

      const myTurnNow = isMyTurn();
      if (myTurnNow && !wasMyTurn) {
        notifyMyTurn(currentName);
      }
      wasMyTurn = myTurnNow;

      const players = state.players || [];
      const playerList = players.length
        ? `<h4>Spieler</h4><ul>${players.map(name => `<li>${escapeHtml(name)}</li>`).join("")}</ul>`
        : "";
      document.getElementById("skatPlayers").innerHTML = playerList;

      const trickCards = state.currentTrick?.map(play => play.card) || [];
      renderSkatRow(
        document.getElementById("skatTrick"),
        trickCards,
        {
          selectable: false,
          onSelect: () => {},
          hideCards: false
        }
      );

      const myHand = mySeat >= 0 ? (state.hands?.[mySeat] || []) : [];
      const skatContainer = document.getElementById("skatSkat");
      const biddingContainer = document.getElementById("skatBidding");
      const actionsContainer = document.getElementById("skatActions");

      if (biddingContainer) biddingContainer.innerHTML = "";
      if (actionsContainer) actionsContainer.innerHTML = "";

      if (state.phase === "bidding") {
        const bid = state.bidding || {};
        const currentBid = bid.currentBidIndex >= 0 ? bid.currentBidIndex : null;
        const highestBid = currentBid !== null ? SKAT_BID_VALUES[currentBid] : "-";
        const bidStatus = `Reizen: ${highestBid} · Reizender: ${state.players?.[bid.bidder] ?? "-"} · Hörer: ${state.players?.[bid.listener] ?? "-"}`;
        if (biddingContainer) {
          biddingContainer.innerHTML = `
            <div class="small muted">${bidStatus}</div>
            <div id="skatBidControls" style="margin-top: 6px;"></div>
          `;
          const controls = document.getElementById("skatBidControls");
          if (controls) {
            const isBidderTurn = isMyTurn() && bid.waitingFor === "bidder";
            const isListenerTurn = isMyTurn() && bid.waitingFor === "listener";
            if (isBidderTurn) {
              const nextOptions = SKAT_BID_VALUES.filter((_, index) => index > (bid.currentBidIndex ?? -1));
              const select = document.createElement("select");
              select.id = "skatBidSelect";
              nextOptions.forEach(value => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = value;
                select.appendChild(option);
              });
              const bidButton = document.createElement("button");
              bidButton.textContent = "Reizen";
              bidButton.onclick = () => {
                const value = Number(select.value);
                socket.emit("skat_bid", { code: room.code, value });
              };
              const passButton = document.createElement("button");
              passButton.textContent = "Passen";
              passButton.style.marginLeft = "6px";
              passButton.onclick = () => socket.emit("skat_pass", { code: room.code });
              controls.appendChild(select);
              controls.appendChild(bidButton);
              controls.appendChild(passButton);
            } else if (isListenerTurn) {
              const holdButton = document.createElement("button");
              holdButton.textContent = "Halten";
              holdButton.onclick = () => socket.emit("skat_hold", { code: room.code });
              const passButton = document.createElement("button");
              passButton.textContent = "Passen";
              passButton.style.marginLeft = "6px";
              passButton.onclick = () => socket.emit("skat_pass", { code: room.code });
              controls.appendChild(holdButton);
              controls.appendChild(passButton);
            } else {
              controls.textContent = "Warte auf die anderen Spieler.";
            }
          }
        }
      }

      if (state.phase === "skat") {
        const isDeclarer = mySeat === state.declarer;
        if (actionsContainer) {
          actionsContainer.innerHTML = `
            <div class="small muted">Skat-Phase: ${isDeclarer ? "Du bist Alleinspieler." : "Warte auf den Alleinspieler."}</div>
            <div id="skatActionButtons" style="margin-top: 6px;"></div>
          `;
          const actionButtons = document.getElementById("skatActionButtons");
          if (actionButtons && isDeclarer) {
            if (!state.skatTaken) {
              const takeBtn = document.createElement("button");
              takeBtn.textContent = "Skat aufnehmen";
              takeBtn.onclick = () => socket.emit("skat_take_skat", { code: room.code });
              actionButtons.appendChild(takeBtn);
            }
            if (state.skatTaken && !state.discarded) {
              const discardBtn = document.createElement("button");
              discardBtn.textContent = "2 Karten abwerfen";
              discardBtn.style.marginLeft = "6px";
              discardBtn.disabled = selectedSkatDiscards.length !== 2;
              discardBtn.onclick = () => {
                const discardCards = selectedSkatDiscards.map(index => myHand[index]).filter(Boolean);
                if (discardCards.length !== 2) return;
                socket.emit("skat_discard", { code: room.code, cards: discardCards });
                selectedSkatDiscards = [];
              };
              actionButtons.appendChild(discardBtn);
            }
            if ((!state.skatTaken || state.discarded) && !state.game) {
              const selectWrap = document.createElement("div");
              selectWrap.style.marginTop = "6px";
              selectWrap.innerHTML = `
                <label>Spielart:
                  <select id="skatGameType">
                    <option value="suit">Farbspiel</option>
                    <option value="grand">Grand</option>
                    <option value="null">Null</option>
                  </select>
                </label>
                <label style="margin-left: 6px;">Trumpf:
                  <select id="skatGameSuit">
                    <option value="♣">♣</option>
                    <option value="♠">♠</option>
                    <option value="♥">♥</option>
                    <option value="♦">♦</option>
                  </select>
                </label>
                <label style="margin-left: 6px;">
                  <input type="checkbox" id="skatGameHand" ${state.skatTaken ? "disabled" : ""}/>
                  Hand
                </label>
                <button id="skatChooseGame" style="margin-left: 6px;">Ansagen</button>
              `;
              actionButtons.appendChild(selectWrap);
              const chooseBtn = selectWrap.querySelector("#skatChooseGame");
              chooseBtn.onclick = () => {
                const type = selectWrap.querySelector("#skatGameType").value;
                const suit = selectWrap.querySelector("#skatGameSuit").value;
                const hand = selectWrap.querySelector("#skatGameHand").checked;
                socket.emit("skat_choose_game", { code: room.code, type, suit, hand });
              };
              const typeSelect = selectWrap.querySelector("#skatGameType");
              const suitSelect = selectWrap.querySelector("#skatGameSuit");
              typeSelect.onchange = () => {
                suitSelect.disabled = typeSelect.value !== "suit";
              };
              suitSelect.disabled = typeSelect.value !== "suit";
            }
          }
        }
      }

      if (skatContainer) {
        const showSkat = state.phase === "skat" && mySeat === state.declarer && state.skatTaken && state.discarded;
        const skatCards = showSkat ? (state.skatPile || []) : [null, null];
        renderSkatRow(
          skatContainer,
          skatCards,
          {
            selectable: false,
            onSelect: () => {},
            hideCards: !showSkat
          }
        );
      }

      renderSkatRow(
        document.getElementById("skatHand"),
        myHand,
        {
          selectable: (state.phase === "playing" && isMyTurn() && !state.finished)
            || (state.phase === "skat" && mySeat === state.declarer && state.skatTaken && !state.discarded),
          onSelect: (index) => {
            if (!room || state.finished) return;
            const card = myHand[index];
            if (!card) return;
            if (state.phase === "skat" && mySeat === state.declarer && state.skatTaken && !state.discarded) {
              if (selectedSkatDiscards.includes(index)) {
                selectedSkatDiscards = selectedSkatDiscards.filter(i => i !== index);
              } else if (selectedSkatDiscards.length < 2) {
                selectedSkatDiscards = [...selectedSkatDiscards, index];
              }
              renderSkatGame();
              return;
            }
            if (!isMyTurn()) return;
            socket.emit("skat_play_card", { code: room.code, card });
          },
          hideCards: false,
          selectedIndices: selectedSkatDiscards
        }
      );

      const status = state.finished
        ? "Skat beendet."
        : state.phase === "bidding"
          ? "Reizen läuft."
          : state.phase === "skat"
            ? "Skat wird aufgenommen."
            : `Stich ${state.trickNumber} · ${playerCount} Spieler`;
      const gameInfo = state.game
        ? `${state.game.type === "suit" ? `Farbspiel ${state.game.suit}` : state.game.type === "grand" ? "Grand" : "Null"} · Alleinspieler: ${state.players?.[state.declarer] ?? "-"}`
        : "";
      document.getElementById("skatResult").textContent = [state.message, gameInfo, status].filter(Boolean).join(" · ");
    }

