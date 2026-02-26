
    // Einstieg: Socket.IO-Verbindung zum Server.
    const socket = io();

    const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const DEFAULT_GAME_TYPE = "schocken";

    // Darstellungen und Farbschemata für Würfel und Spieler.
    const diceSymbols = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const playerTextColors = ['#e6194b','#4363d8','#f58231','#911eb4','#008080','#f032e6','#bcf60c','#0082c8'];
    const playerBgColors   = ['#ffe5e5','#e5e5ff','#fff5e5','#f5e5ff','#e5f5ff','#ffe5f5','#f5ffe5','#e5ffff'];
    const lobbyBgColor = "#f0f0f0";
    let currentBaseBg = "";
    // Reihenfolge der Reizwerte im Skat.
    const SKAT_BID_VALUES = [
      18, 20, 22, 23, 24, 27, 30, 33, 35, 36, 40, 44, 45, 46, 48, 50, 54, 55, 59, 60,
      63, 66, 70, 72, 77, 80, 81, 84, 88, 90, 96, 99, 100, 108, 110, 120, 121, 126, 132,
      135, 144, 150, 153, 160, 162, 168, 176, 180, 187, 192, 198, 204, 216, 220, 240, 264
    ];

    function isDarkModeEnabled() {
      return document.body.classList.contains("dark-mode");
    }

    function normalizeHexColor(hex) {
      const clean = String(hex || "").trim();
      if (!clean.startsWith("#")) return null;
      if (clean.length === 7) return clean;
      if (clean.length === 4) {
        return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
      }
      return null;
    }

    function mixHexColors(base, mix, weight = 0.5) {
      const baseHex = normalizeHexColor(base);
      const mixHex = normalizeHexColor(mix);
      if (!baseHex || !mixHex) return base;
      const toRgb = (hex) => ({
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
      });
      const a = toRgb(baseHex);
      const b = toRgb(mixHex);
      const clamp = (value) => Math.min(255, Math.max(0, Math.round(value)));
      const r = clamp(a.r * (1 - weight) + b.r * weight);
      const g = clamp(a.g * (1 - weight) + b.g * weight);
      const bVal = clamp(a.b * (1 - weight) + b.b * weight);
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bVal.toString(16).padStart(2, "0")}`;
    }

    function applyThemeToBackground() {
      if (!currentBaseBg) {
        document.body.style.removeProperty("--page-bg");
        return;
      }
      const themedColor = isDarkModeEnabled()
        ? mixHexColors(currentBaseBg, "#121212", 0.6)
        : currentBaseBg;
      document.body.style.setProperty("--page-bg", themedColor);
    }

    function setBodyBackgroundColor(color) {
      currentBaseBg = color || "";
      applyThemeToBackground();
    }

    function setTheme(mode) {
      const useDark = mode === "dark";
      document.body.classList.toggle("dark-mode", useDark);
      const toggle = document.getElementById("themeToggle");
      if (toggle) toggle.checked = useDark;
      localStorage.setItem("theme", useDark ? "dark" : "light");
      applyThemeToBackground();
    }

    function initThemeToggle() {
      const toggle = document.getElementById("themeToggle");
      const storedTheme = localStorage.getItem("theme") || "light";
      setTheme(storedTheme);
      if (!toggle) return;
      toggle.addEventListener("change", () => {
        setTheme(toggle.checked ? "dark" : "light");
      });
    }

    function getKwyxHighlightColor() {
      if (!state || typeof state.currentPlayer !== "number") return null;
      return kwyxRows[state.currentPlayer % kwyxRows.length];
    }
    // Name für jede Spielart (UI-Text).
    const gameTypeLabels = {
      [DEFAULT_GAME_TYPE]: "Schocken",
      kniffel: "Yahtzee",
      kwyx: "Kwyx",
      schwimmen: "Schwimmen",
      skat: "Skat",
      schiffeversenken: "Schiffe versenken"
    };
    const gameTypeRequirements = {
      schocken: { min: 2 },
      kniffel: { min: 2 },
      kwyx: { min: 2 },
      schwimmen: { min: 2 },
      skat: { exact: 3 },
      schiffeversenken: { exact: 2 }
    };

    // Persistenter Spieler-Kontext (für Rejoin und Komfort).
    let myToken    = localStorage.getItem("schocken_token") || null;
    let myRoomCode = localStorage.getItem("schocken_code") || null;
    let mySeat     = Number(localStorage.getItem("schocken_seat") || "-1");
    let myName     = localStorage.getItem("schocken_name") || "";
    let isHost     = false;
    let wasMyTurn  = false;
    let joinPending = null;

    let room = null;
    let state = null;
    let selectedHandIndex = null;
    let selectedTableIndex = null;
    let selectedSkatDiscards = [];
    let kniffelSelectedCategory = "";
    let lastKniffelPlayer = null;
    let lastSkatPhase = null;
    let kwyxSelections = { whiteRow: "", colorRow: "", colorSum: "", penalty: false };
    let lastKwyxThrowCount = null;
    let lastKwyxPlayer = null;
    let kwyxCountdownTimer = null;

    // Headergrafiken je Ansicht.
    const headerImages = {
      lobby: "/header_Lobby.png",
      schocken: "/header_schocken.png",
      schwimmen: "/header_schwimmen.png",
      kniffel: "/header_yahtzee.png",
      kwyx: "/header_kwyx.png",
      skat: "/header_Skat.png",
      schiffeversenken: "/header_Lobby.png"
    };

    // Wechselt Logo und Titel je nach Spielansicht.
    function updateHeader(view) {
      const logo = document.getElementById("pageTitleLogo");
      const titleText = document.getElementById("pageTitleText");
      if (!logo || !titleText) return;
      const typeKey = view === "lobby" ? getSelectedGameType() : (room?.settings?.gameType || DEFAULT_GAME_TYPE);
      const gameTitle = gameTypeLabels[typeKey] || gameTypeLabels[DEFAULT_GAME_TYPE];
      const headerSrc = view === "lobby" ? headerImages.lobby : (headerImages[typeKey] || headerImages[DEFAULT_GAME_TYPE]);
      logo.src = headerSrc;
      logo.alt = view === "lobby" ? "Spieleflur Lobby" : `${gameTitle} Header`;
      titleText.textContent = (view === "game" && room && room.code) ? `${gameTitle} (${room.code})` : `${gameTitle} (Lobby)`;
    }

    // Schaltet zwischen Lobby- und Spielansicht.
    function setView(view) {
      document.getElementById("lobby").style.display = (view === "lobby") ? "block" : "none";
      document.getElementById("game").style.display  = (view === "game") ? "block" : "none";
      if (view === "lobby") {
        setBodyBackgroundColor(lobbyBgColor);
      }
      updateHeader(view);
    }
    // Zeigt Fehler in der Lobby an.
    function showLobbyError(msg) {
      document.getElementById("lobbyError").textContent = msg || "";
    }
    // Hinweis für auslaufende Lobby (Inaktivität).
    function showLobbyExpiryNotice(msg) {
      const notice = document.getElementById("lobbyExpiryNotice");
      const text = document.getElementById("lobbyExpiryText");
      if (!notice || !text) return;
      if (!msg) {
        notice.style.display = "none";
        text.textContent = "";
        return;
      }
      text.textContent = msg;
      notice.style.display = "block";
    }
    function showJoinStatus(msg) {
      document.getElementById("joinStatus").textContent = msg || "";
    }

    function canShowBackToLobby() {
      if (!room) return false;
      if (isHost) return true;
      return typeof mySeat === "number" && mySeat >= 0 && room.hostSeat === mySeat;
    }

    // Verhindert, dass man versehentlich in eine zweite Lobby springt.
    function canEnterRoom(requestedCode) {
      if (myRoomCode && myToken) {
        const normalized = String(requestedCode || "").trim().toUpperCase();
        if (!normalized || normalized !== myRoomCode) {
          showLobbyError("Du bist bereits in einer Lobby. Bitte wieder beitreten.");
          return false;
        }
      }
      return true;
    }
    // Gemeinsame Statusausgabe im Spielbereich.
    function showGameMessage(msg, isError=false) {
      const el = getGameResultElement();
      if (!el) return;
      el.textContent = msg || "";
      el.style.color = isError ? "red" : "";
    }
    function makeCode(len = 5) {
      let s = "";
      for (let i = 0; i < len; i++) s += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
      return s;
    }
    function setSuggestedCode() {
      document.getElementById("roomCode").value = makeCode();
    }
    // Name aus dem Eingabefeld lesen.
    function getPlayerName() {
      return document.getElementById("playerName").value.trim();
    }
    // Namen lokal speichern, damit er beim nächsten Besuch vorausgefüllt ist.
    function storePlayerName(name) {
      myName = name;
      localStorage.setItem("schocken_name", name);
    }
    // Einfacher HTML-Escaper, damit Benutzereingaben sicher angezeigt werden.
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, m => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
      }[m]));
    }
    // Spieltyp-Label und Anforderungen abfragen.
    function getGameTypeLabel(value) {
      return gameTypeLabels[value] || gameTypeLabels[DEFAULT_GAME_TYPE];
    }
    function getSelectedGameType() {
      const select = document.getElementById("gameTypeSelect");
      return select ? select.value : DEFAULT_GAME_TYPE;
    }
    function getGameTypeRequirement(value) {
      return gameTypeRequirements[value] || { min: 2 };
    }

    // Prüft, ob der aktuelle Spieler am Zug ist.
    function isMyTurn() {
      return state && mySeat >= 0 && state.currentPlayer === mySeat;
    }

    function isCurrentGameType(type) {
      return room?.settings?.gameType === type;
    }

    function isKniffelGame() {
      return isCurrentGameType("kniffel");
    }

    function isKwyxGame() {
      return isCurrentGameType("kwyx");
    }

    function isSchwimmenGame() {
      return isCurrentGameType("schwimmen");
    }

    function isSkatGame() {
      return isCurrentGameType("skat");
    }

    function isSchiffeversenkenGame() {
      return isCurrentGameType("schiffeversenken");
    }

    // Liefert das passende Ergebnis-Element je Spieltyp.
    function getGameResultElement() {
      if (isKniffelGame()) return document.getElementById("kniffelResult");
      if (isKwyxGame()) return document.getElementById("kwyxResult");
      if (isSchwimmenGame()) return document.getElementById("schwimmenResult");
      if (isSkatGame()) return document.getElementById("skatResult");
      if (isSchiffeversenkenGame()) return document.getElementById("svResult");
      return document.getElementById("result");
    }

    // Einheitliches Rendern von Würfelreihen (Schocken/Yahtzee).
    function renderDiceGroup({ idPrefix, count, values, held, myTurn, onToggle }) {
      for (let i = 0; i < count; i++) {
        const el = document.getElementById(`${idPrefix}${i}`);
        if (!el) continue;
        const val = values?.[i];
        el.textContent = val ? diceSymbols[val - 1] : "□";
        el.className = "die" + (held?.[i] ? " held" : "") + (!myTurn ? " inactive" : "");
        if (typeof onToggle === "function") {
          el.onclick = () => {
            if (!myTurn) return;
            onToggle(i);
          };
        } else {
          el.onclick = null;
        }
      }
    }

    async function notifyMyTurn(playerName) {
      if (!("Notification" in window)) return;
      if (Notification.permission === "denied") return;

      if (Notification.permission === "default") {
        try {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") return;
        } catch (err) {
          return;
        }
      }

      const title = "Spieleflur";
      const body = playerName ? `Am Zug: ${playerName}` : "Jetzt bist du dran!";

      if ("serviceWorker" in navigator) {
        try {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(title, {
            body,
            icon: "/icon.png",
            badge: "/icon.png"
          });
          return;
        } catch (err) {
          // fall back to window notification
        }
      }

      try {
        new Notification(title, { body });
      } catch (err) {
        // ignore
      }
    }

    async function notifyJoinRequest(playerName, code, requestId) {
      if (!("Notification" in window)) return;
      if (Notification.permission === "denied") return;

      if (Notification.permission === "default") {
        try {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") return;
        } catch (err) {
          return;
        }
      }

      const title = "Beitrittsanfrage";
      const body = `${playerName} möchte Lobby ${code} beitreten.`;

      if ("serviceWorker" in navigator) {
        try {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(title, {
            body,
            icon: "/icon.png",
            badge: "/icon.png",
            data: { code, requestId },
            actions: [
              { action: "approve", title: "Annehmen" },
              { action: "deny", title: "Ablehnen" }
            ]
          });
          return;
        } catch (err) {
          // fall back to window notification
        }
      }

      try {
        new Notification(title, { body });
      } catch (err) {
        // ignore
      }
    }

    function renderRoomView() {
      if (!room) return;
      document.getElementById("roomView").style.display = "block";
      document.getElementById("roomCodeBig").textContent = room.code;

      const list = room.players || [];
      let html = "<h4>Spieler</h4><ul>";
      list.forEach((p, index) => {
        const connected = p.connected ? `<span class="pill ok">online</span>` : `<span class="pill bad">offline</span>`;
        const hostBadge = index === room.hostSeat ? `<span class="pill neutral">Host</span>` : "";
        html += `<li>${escapeHtml(p.name)} ${connected} ${hostBadge}</li>`;
      });
      html += "</ul>";
      document.getElementById("playerList").innerHTML = html;

      document.getElementById("hostControls").style.display =
        isHost && room.status === "lobby" ? "block" : "none";
      document.getElementById("leaveLobbyWrap").style.display =
        room.status === "lobby" ? "block" : "none";
      const hint = document.getElementById("hostStartHint");
      if (hint) {
        hint.textContent = isHost ? "Nur du kannst das Spiel starten." : "Nur der Host kann das Spiel starten.";
      }
      renderPendingList([]);
      updateLobbyOptionToggles();
      updateGameTypeSelectState();
      updateLobbyVisibility();
      updateStartButtonState();
      const settingsSummary = document.getElementById("roomSettingsSummary");
      if (settingsSummary && room?.settings) {
        const typeLabel = getGameTypeLabel(room.settings.gameType);
        if (room.settings.gameType === "schocken") {
          const deckelLabel = room.settings.useDeckel ? "mit Deckeln" : "ohne Deckel";
          settingsSummary.textContent = `Einstellungen: ${typeLabel} · ${deckelLabel}`;
        } else if (room.settings.gameType === "kniffel") {
          const handBonusLabel = room.settings.kniffelHandBonus !== false ? "mit Hand: +5" : "ohne Hand: +5";
          settingsSummary.textContent = `Einstellungen: ${typeLabel} · ${handBonusLabel}`;
        } else {
          settingsSummary.textContent = `Einstellungen: ${typeLabel}`;
        }
      }
      if (!room || room.status !== "lobby") {
        showLobbyExpiryNotice("");
      }
    }

    function renderPendingList(requests) {
      const container = document.getElementById("pendingList");
      if (!isHost) {
        container.innerHTML = "";
        container.style.display = "none";
        return;
      }
      if (!requests || requests.length === 0) {
        container.innerHTML = "";
        container.style.display = "none";
        return;
      }
      container.style.display = "block";
      let html = "<h4>Beitrittsanfragen</h4><ul>";
      requests.forEach(req => {
        const safeName = escapeHtml(req.name);
        html += `<li>${safeName}
          <button class="icon-btn" data-approve="${req.id}" title="Annehmen">✅</button>
          <button class="icon-btn" data-deny="${req.id}" title="Ablehnen">❌</button>
        </li>`;
      });
      html += "</ul>";
      container.innerHTML = html;

      container.querySelectorAll("button[data-approve]").forEach(btn => {
        btn.onclick = () => {
          if (!room || !myToken) return;
          socket.emit("approve_join", { code: room.code, token: myToken, requestId: btn.dataset.approve, accept: true });
        };
      });
      container.querySelectorAll("button[data-deny]").forEach(btn => {
        btn.onclick = () => {
          if (!room || !myToken) return;
          socket.emit("approve_join", { code: room.code, token: myToken, requestId: btn.dataset.deny, accept: false });
        };
      });
    }

    function renderLobbyList(lobbies) {
      const container = document.getElementById("activeLobbies");
      if (room && room.status === "lobby") {
        container.style.display = "none";
        container.innerHTML = "";
        return;
      }
      container.style.display = "block";
      if (!lobbies || lobbies.length === 0) {
        container.innerHTML = "<div class='small muted'>Keine aktiven Lobbys gefunden.</div>";
        return;
      }
      let html = "<h4>Aktive Lobbys</h4>";
      lobbies.forEach(lobby => {
        const host = escapeHtml(lobby.hostName || "Host");
        const gameLabel = gameTypeLabels[lobby.gameType] || "Schocken";
        html += `<div class="lobby-item">
          <div>
            <div><strong>${lobby.code}</strong> · ${host}</div>
            <div class="small muted">${lobby.playerCount} Spieler · ${gameLabel}${lobby.gameType === "schocken" ? (lobby.useDeckel ? " · mit Deckeln" : " · ohne Deckel") : ""}${lobby.gameType === "kniffel" ? ((lobby.kniffelHandBonus !== false) ? " · mit Hand: +5" : " · ohne Hand: +5") : ""}</div>
          </div>
          <button data-join="${lobby.code}">Beitreten</button>
        </div>`;
      });
      container.innerHTML = html;
      container.querySelectorAll("button[data-join]").forEach(btn => {
        btn.onclick = () => {
          const name = getPlayerName();
          const code = btn.dataset.join;
          if (!name) return showLobbyError("Bitte Name eingeben.");
          if (!canEnterRoom(code)) return;
          showLobbyError("");
          showJoinStatus(`Beitritt für ${code} angefragt…`);
          joinPending = { code };
          document.getElementById("roomCode").value = code;
          socket.emit("enter_room", {
            name,
            requestedCode: code,
            useDeckel: document.getElementById("deckelToggle").checked,
            kniffelHandBonus: document.getElementById("kniffelHandBonusToggle").checked,
            gameType: getSelectedGameType()
          });
        };
      });
    }



    // Zentraler Einstieg für die Spiel-UI (delegiert je Spieltyp).
    function renderGame() {
      if (!state) return;
      if (isKniffelGame()) {
        renderKniffelGame();
      } else if (isKwyxGame()) {
        renderKwyxGame();
      } else if (isSchwimmenGame()) {
        renderSchwimmenGame();
      } else if (isSkatGame()) {
        renderSkatGame();
      } else if (isSchiffeversenkenGame()) {
        renderSchiffeversenkenGame();
      } else {
        renderSchockenGame();
      }
      if (!isKwyxGame()) {
        stopKwyxCountdownTimer();
      }
    }

    // Keepalive: solange die Seite geöffnet ist (bis zu 72h)
    let pingTimer = null;
    let pingStopTimer = null;
    const KEEPALIVE_DURATION_MS = 72 * 60 * 60 * 1000;
    function startKeepalive() {
      if (pingTimer) return;
      pingTimer = setInterval(() => {
        fetch("/ping", { cache: "no-store" }).catch(() => {});
      }, 5 * 60 * 1000);
      if (!pingStopTimer) {
        pingStopTimer = setTimeout(() => {
          stopKeepalive();
        }, KEEPALIVE_DURATION_MS);
      }
    }
    function stopKeepalive() {
      if (!pingTimer) return;
      clearInterval(pingTimer);
      pingTimer = null;
      if (pingStopTimer) {
        clearTimeout(pingStopTimer);
        pingStopTimer = null;
      }
    }

    // ---- Socket events ----
    socket.on("room_joined", (payload) => {
      showLobbyError("");
      showJoinStatus("");
      joinPending = null;

      myRoomCode = payload.code;
      myToken = payload.token;
      mySeat = payload.seatIndex;
      myName = payload.name;
      isHost = payload.isHost;
      document.getElementById("playerName").value = myName;

      localStorage.setItem("schocken_code", myRoomCode);
      localStorage.setItem("schocken_token", myToken);
      localStorage.setItem("schocken_seat", String(mySeat));
      localStorage.setItem("schocken_name", myName);

      room = payload.room;
      state = payload.state || null;

      renderRoomView();

      if (state) {
        setView("game");
        startKeepalive();
        renderGame();
      } else {
        setView("lobby");
        updateLobbyVisibility();
      }
    });

    socket.on("room_update", (payloadRoom) => {
      room = payloadRoom;
      if (room && typeof room.hostSeat === "number" && myName) {
        const idx = room.players.findIndex(p => p.name.toLowerCase() === myName.toLowerCase());
        if (idx >= 0) {
          mySeat = idx;
          localStorage.setItem("schocken_seat", String(mySeat));
        }
        if (mySeat >= 0) {
          isHost = room.hostSeat === mySeat;
        }
      }
      renderRoomView();
    });

    socket.on("lobby_list", (payload) => {
      renderLobbyList(payload.lobbies || []);
    });

    socket.on("join_pending", ({ code }) => {
      joinPending = { code };
      showJoinStatus(`Warte auf Bestätigung durch den Host (${code}).`);
    });

    socket.on("join_denied", ({ message }) => {
      joinPending = null;
      showJoinStatus("");
      showLobbyError(message || "Beitritt abgelehnt.");
    });

    socket.on("join_requests_update", ({ requests }) => {
      renderPendingList(requests);
    });

    socket.on("join_request_notice", ({ name, code, requestId }) => {
      notifyJoinRequest(name, code, requestId);
    });

    socket.on("state_update", (payloadState) => {
      state = payloadState;
      if (state?.gameType === "skat") {
        if (state.phase !== lastSkatPhase) {
          selectedSkatDiscards = [];
          lastSkatPhase = state.phase;
        }
      } else {
        lastSkatPhase = null;
      }
      setView("game");
      startKeepalive();
      renderGame();
    });

    socket.on("error_msg", ({ message }) => {
      const hadJoinPending = !!joinPending;
      showJoinStatus("");
      joinPending = null;
      if (message === "Room-Code nicht gefunden.") {
        socket.emit("get_lobby_list");
      }
      if (message === "Room-Code nicht gefunden." && myRoomCode && myToken) {
        localStorage.removeItem("schocken_code");
        localStorage.removeItem("schocken_token");
        localStorage.removeItem("schocken_seat");
        myRoomCode = null; myToken = null; mySeat = -1;
        room = null;
        state = null;
        isHost = false;
        showLobbyExpiryNotice("");
        document.getElementById("rejoinBox").style.display = "none";
        setView("lobby");
        updateLobbyOptionToggles();
        updateLobbyVisibility();
        showLobbyError("");
        return;
      }
      if (document.getElementById("lobby").style.display !== "none") {
        if (message === "Room-Code nicht gefunden." && hadJoinPending) {
          showLobbyError("Lobby existiert nicht mehr.");
        } else {
          showLobbyError(message);
        }
      }
      else showGameMessage(message, true);
    });

    socket.on("lobby_returned", ({ message } = {}) => {
      setView("lobby");
      setBodyBackgroundColor(lobbyBgColor);
      wasMyTurn = false;
      showLobbyError(isHost ? "" : (message || ""));
      updateLobbyVisibility();
    });

    socket.on("lobby_expiring", ({ code, secondsLeft }) => {
      if (!room || room.code !== code || room.status !== "lobby") return;
      const seconds = Number.isFinite(secondsLeft) ? secondsLeft : 30;
      showLobbyExpiryNotice(`Diese Lobby wird in ${seconds} Sekunden gelöscht. Klick auf „Lobby behalten“, um sie zu behalten.`);
    });

    socket.on("lobby_keep_confirmed", ({ code, message }) => {
      if (!room || room.code !== code) return;
      showLobbyExpiryNotice(message || "Lobby bleibt bestehen.");
      setTimeout(() => {
        showLobbyExpiryNotice("");
      }, 2000);
    });

    socket.on("lobby_deleted", ({ code, message } = {}) => {
      if (!room || room.code !== code) return;
      room = null;
      state = null;
      myRoomCode = null;
      myToken = null;
      mySeat = -1;
      isHost = false;
      localStorage.removeItem("schocken_code");
      localStorage.removeItem("schocken_token");
      localStorage.removeItem("schocken_seat");
      setView("lobby");
      showLobbyError(message || "Lobby wurde gelöscht.");
      updateLobbyOptionToggles();
      updateLobbyVisibility();
      socket.emit("get_lobby_list");
    });

    socket.on("room_left", ({ message } = {}) => {
      room = null;
      state = null;
      myRoomCode = null;
      myToken = null;
      mySeat = -1;
      isHost = false;
      localStorage.removeItem("schocken_code");
      localStorage.removeItem("schocken_token");
      localStorage.removeItem("schocken_seat");
      setView("lobby");
      showLobbyError(message || "");
      updateLobbyOptionToggles();
      updateLobbyVisibility();
      socket.emit("get_lobby_list");
    });

    // ---- Buttons ----
    document.getElementById("btnEnter").onclick = () => {
      const name = getPlayerName();
      const code = document.getElementById("roomCode").value.trim().toUpperCase();
      const useDeckel = document.getElementById("deckelToggle").checked;
      const gameType = getSelectedGameType();
      const kniffelHandBonus = document.getElementById("kniffelHandBonusToggle").checked;
      if (!name) return showLobbyError("Bitte Name eingeben.");
      if (!canEnterRoom(code)) return;
      storePlayerName(name);
      showLobbyError("");
      if (code) {
        showJoinStatus(`Beitritt für ${code} angefragt…`);
        joinPending = { code };
      } else {
        showJoinStatus("Erstelle neue Lobby…");
      }
      socket.emit("enter_room", { name, requestedCode: code, useDeckel, kniffelHandBonus, gameType });
    };

    document.getElementById("btnStartGame").onclick = () => {
      if (!room || !myToken) return;
      socket.emit("start_game", { code: room.code, token: myToken });
    };

    document.getElementById("btnLeaveLobby").onclick = () => {
      if (!room || !myToken) return;
      if (room.status !== "lobby") return;
      const confirmText = isHost
        ? "Lobby verlassen? Du gibst den Host-Status ab."
        : "Lobby verlassen?";
      if (!window.confirm(confirmText)) return;
      socket.emit("leave_room", { code: room.code, token: myToken });
    };

    document.getElementById("btnKeepLobby").onclick = () => {
      if (!room || !myToken || room.status !== "lobby") return;
      socket.emit("keep_lobby", { code: room.code, token: myToken });
    };

    document.getElementById("rollBtn").onclick = () => {
      if (!room) return;
      if (isKniffelGame()) return;
      socket.emit("action_roll", { code: room.code });
    };

    document.getElementById("endTurnBtn").onclick = () => {
      if (!room) return;
      if (isKniffelGame()) return;
      socket.emit("action_end_turn", { code: room.code });
    };

    document.getElementById("kniffelRollBtn").onclick = () => {
      if (!room) return;
      if (!isKniffelGame()) return;
      socket.emit("action_roll", { code: room.code });
    };

    document.getElementById("kniffelEndTurnBtn").onclick = () => {
      if (!room) return;
      if (!isKniffelGame()) return;
      const category = kniffelSelectedCategory;
      socket.emit("action_end_turn", { code: room.code, category });
    };

    document.getElementById("kwyxRollBtn").onclick = () => {
      if (!room) return;
      if (!isKwyxGame()) return;
      socket.emit("action_roll", { code: room.code });
    };

    document.getElementById("kwyxEndTurnBtn").onclick = () => {
      if (!room) return;
      if (!isKwyxGame()) return;
      socket.emit("action_end_turn", {
        code: room.code,
        category: {
          whiteRow: kwyxSelections.whiteRow,
          colorRow: kwyxSelections.colorRow,
          colorSum: kwyxSelections.colorSum ? Number(kwyxSelections.colorSum) : null,
          penalty: kwyxSelections.penalty
        }
      });
      resetKwyxSelections();
    };

    document.getElementById("schwimmenSwapBtn").onclick = () => {
      if (!room || !isSchwimmenGame()) return;
      if (selectedHandIndex === null || selectedTableIndex === null) return;
      socket.emit("schwimmen_swap", {
        code: room.code,
        handIndex: selectedHandIndex,
        tableIndex: selectedTableIndex
      });
    };

    document.getElementById("schwimmenSwapAllBtn").onclick = () => {
      if (!room || !isSchwimmenGame()) return;
      socket.emit("schwimmen_swap_all", { code: room.code });
    };

    document.getElementById("schwimmenPassBtn").onclick = () => {
      if (!room || !isSchwimmenGame()) return;
      socket.emit("schwimmen_pass", { code: room.code });
    };

    document.getElementById("schwimmenKnockBtn").onclick = () => {
      if (!room || !isSchwimmenGame()) return;
      socket.emit("schwimmen_knock", { code: room.code });
    };

    document.getElementById("schwimmenNextRoundBtn").onclick = () => {
      if (!room || !isSchwimmenGame()) return;
      selectedHandIndex = null;
      selectedTableIndex = null;
      socket.emit("schwimmen_start_round", { code: room.code });
    };

    document.getElementById("btnBackToLobby").onclick = () => {
      if (isHost && room && myToken) {
        const ok = window.confirm("Zurück zur Lobby? Das beendet das Spiel und löscht den Fortschritt.");
        if (ok) {
          socket.emit("return_lobby", { code: room.code, token: myToken });
        }
        return;
      }
      showLobbyError("Nur der Host kann alle zurück in die Lobby schicken.");
    };

    document.getElementById("btnRejoin").onclick = () => {
      if (!myRoomCode || !myToken) return;
      socket.emit("rejoin_room", { code: myRoomCode, token: myToken });
    };

    document.getElementById("btnForget").onclick = () => {
      localStorage.removeItem("schocken_code");
      localStorage.removeItem("schocken_token");
      localStorage.removeItem("schocken_seat");
      myRoomCode = null; myToken = null; mySeat = -1;
      room = null;
      state = null;
      isHost = false;
      joinPending = null;
      showLobbyExpiryNotice("");
      document.getElementById("rejoinBox").style.display = "none";
      showLobbyError("Vergessen. Du kannst neu erstellen oder beitreten.");
      updateLobbyOptionToggles();
      updateLobbyVisibility();
      socket.emit("get_lobby_list");
    };

    document.getElementById("btnNewCode").onclick = () => {
      setSuggestedCode();
    };

    document.getElementById("playerName").addEventListener("input", (event) => {
      storePlayerName(event.target.value.trim());
    });

    document.getElementById("deckelToggle").onchange = (event) => {
      if (!room || !myToken) return;
      if (!isHost || room.status !== "lobby") {
        event.target.checked = !!room?.settings?.useDeckel;
        return;
      }
      socket.emit("update_room_settings", {
        code: room.code,
        token: myToken,
        useDeckel: event.target.checked,
        kniffelHandBonus: room.settings?.kniffelHandBonus !== false,
        gameType: room.settings?.gameType || "schocken"
      });
    };

    document.getElementById("kniffelHandBonusToggle").onchange = (event) => {
      if (!room || !myToken) return;
      if (!isHost || room.status !== "lobby") {
        event.target.checked = room?.settings?.kniffelHandBonus !== false;
        return;
      }
      socket.emit("update_room_settings", {
        code: room.code,
        token: myToken,
        useDeckel: !!room.settings?.useDeckel,
        kniffelHandBonus: event.target.checked,
        gameType: room.settings?.gameType || "kniffel"
      });
    };

    document.getElementById("gameTypeSelect").onchange = (event) => {
      updateLobbyOptionToggles();
      updateHeader("lobby");
      updateStartButtonState();
      if (!room || !myToken) return;
      if (!isHost || room.status !== "lobby") {
        event.target.value = room?.settings?.gameType || "schocken";
        return;
      }
      socket.emit("update_room_settings", {
        code: room.code,
        token: myToken,
        useDeckel: room.settings?.useDeckel,
        kniffelHandBonus: room.settings?.kniffelHandBonus !== false,
        gameType: event.target.value
      });
    };

    window.onload = () => {
      initThemeToggle();
      setSuggestedCode();
      document.getElementById("gameTypeSelect").value = "schocken";
      updateHeader("lobby");
      updateLobbyOptionToggles();
      if (myName) {
        document.getElementById("playerName").value = myName;
      }
      if (myRoomCode && myToken) {
        document.getElementById("rejoinBox").style.display = "block";
      }
      showJoinStatus("");
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }
      startKeepalive();
    };

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", event => {
        const data = event.data || {};
        if (data.type !== "join_request_action") return;
        if (!room || !myToken || !isHost || room.status !== "lobby") return;
        if (data.code !== room.code) return;
        const accept = data.action === "approve";
        if (!data.requestId) return;
        socket.emit("approve_join", {
          code: data.code,
          token: myToken,
          requestId: data.requestId,
          accept
        });
      });
    }

    document.getElementById("btnReload").onclick = () => {
      window.location.reload();
    };

    socket.on("connect", () => {
      if (myRoomCode && myToken) {
        socket.emit("rejoin_room", { code: myRoomCode, token: myToken });
      }
      socket.emit("get_lobby_list");
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (myRoomCode && myToken) {
          socket.emit("rejoin_room", { code: myRoomCode, token: myToken });
        }
        socket.emit("get_lobby_list");
      }
    });

    function updateLobbyOptionToggles() {
      const deckelToggle = document.getElementById("deckelToggle");
      const handToggle = document.getElementById("kniffelHandBonusToggle");
      if (!deckelToggle || !handToggle) return;
      const selectedType = room?.settings?.gameType
        || document.getElementById("gameTypeSelect")?.value
        || "schocken";
      const isSchocken = selectedType === "schocken";
      const isKniffel = selectedType === "kniffel";

      if (room && room.status === "lobby") {
        deckelToggle.checked = !!room.settings?.useDeckel && isSchocken;
        handToggle.checked = room.settings?.kniffelHandBonus !== false && isKniffel;
      }

      deckelToggle.disabled = !!room
        ? (!isHost || room.status !== "lobby" || !isSchocken)
        : !isSchocken;
      handToggle.disabled = !!room
        ? (!isHost || room.status !== "lobby" || !isKniffel)
        : !isKniffel;

      if (deckelToggle.parentElement) deckelToggle.parentElement.style.display = isSchocken ? "flex" : "none";
      if (handToggle.parentElement) handToggle.parentElement.style.display = isKniffel ? "flex" : "none";
    }

    function getGameStartStatus() {
      const selectedType = room?.settings?.gameType
        || document.getElementById("gameTypeSelect")?.value
        || "schocken";
      const requirement = getGameTypeRequirement(selectedType);
      const playerCount = room?.players?.length || 0;
      if (requirement.exact && playerCount !== requirement.exact) {
        return {
          ok: false,
          reason: `${getGameTypeLabel(selectedType)} benötigt genau ${requirement.exact} Spieler (aktuell ${playerCount}).`
        };
      }
      if (requirement.min && playerCount < requirement.min) {
        return {
          ok: false,
          reason: `${getGameTypeLabel(selectedType)} benötigt mindestens ${requirement.min} Spieler (aktuell ${playerCount}).`
        };
      }
      if (requirement.max && playerCount > requirement.max) {
        return {
          ok: false,
          reason: `${getGameTypeLabel(selectedType)} erlaubt höchstens ${requirement.max} Spieler (aktuell ${playerCount}).`
        };
      }
      return { ok: true, reason: "" };
    }

    function updateStartButtonState() {
      const startButton = document.getElementById("btnStartGame");
      const hint = document.getElementById("hostStartHint");
      if (!startButton || !hint) return;
      if (!room || room.status !== "lobby") {
        startButton.disabled = true;
        hint.textContent = isHost ? "Nur du kannst das Spiel starten." : "Nur der Host kann das Spiel starten.";
        return;
      }
      const status = getGameStartStatus();
      startButton.disabled = !isHost || !status.ok;
      if (!status.ok) {
        hint.textContent = status.reason;
      } else {
        hint.textContent = isHost ? "Nur du kannst das Spiel starten." : "Nur der Host kann das Spiel starten.";
      }
    }

    function updateGameTypeSelectState() {
      const select = document.getElementById("gameTypeSelect");
      if (!select) return;
      const current = room?.settings?.gameType || "schocken";
      select.value = current;
      select.disabled = !!room && (!isHost || room.status !== "lobby");
    }
    function updateGameTypeState() {
      const select = document.getElementById("gameTypeSelect");
      if (!select) return;
      if (room && room.status === "lobby") {
        select.value = room.settings?.gameType || "schocken";
      }
      select.disabled = !!room && (!isHost || room.status !== "lobby");
    }

    function updateLobbyVisibility() {
      const inLobby = !!room && room.status === "lobby";
      const list = document.getElementById("activeLobbies");
      const roomView = document.getElementById("roomView");
      if (roomView) {
        roomView.style.display = inLobby ? "block" : "none";
      }
      if (!inLobby) {
        showLobbyExpiryNotice("");
      }
      if (list) {
        list.style.display = inLobby ? "none" : "block";
      }
      if (!inLobby && list && list.innerHTML.trim() === "") {
        list.innerHTML = "<div class='small muted'>Aktive Lobbys werden geladen…</div>";
      }
    }
