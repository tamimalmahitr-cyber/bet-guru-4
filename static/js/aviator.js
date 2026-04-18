(function () {
    const config = window.AVIATOR_CONFIG || {};
    const root = document.querySelector("[data-aviator-page]");
    if (!root) return;

    const socket = io();
    const state = {
        phase: (config.initialState || {}).phase || "starting",
        countdown: (config.initialState || {}).countdown || 10,
        multiplier: Number((config.initialState || {}).multiplier || 1),
        targetMultiplier: Number((config.initialState || {}).multiplier || 1),
        crashPoint: (config.initialState || {}).crash_point || null,
        history: (config.initialState || {}).history || [],
        players: (config.initialState || {}).players || [],
        myBet: (config.initialState || {}).my_bet || null,
        balance: Number((config.initialState || {}).balance || 0),
        seedHash: (config.initialState || {}).seed_hash || "",
        playerCount: Number((config.initialState || {}).player_count || 0),
        autoBet: false,
    };

    const els = {
        historyStrip: document.getElementById("history-strip"),
        seedHash: document.getElementById("seed-hash"),
        phaseChip: document.getElementById("phase-chip"),
        multiplierMain: document.getElementById("multiplier-main"),
        multiplierSub: document.getElementById("multiplier-sub"),
        countdownPill: document.getElementById("countdown-pill"),
        playerCountLabel: document.getElementById("player-count-label"),
        playersBody: document.getElementById("players-body"),
        walletBalance: document.getElementById("wallet-balance"),
        betAmount: document.getElementById("bet-amount"),
        autoCashout: document.getElementById("auto-cashout"),
        autoBetToggle: document.getElementById("auto-bet-toggle"),
        placeBetBtn: document.getElementById("place-bet-btn"),
        cashoutBtn: document.getElementById("cashout-btn"),
        betNote: document.getElementById("bet-note"),
        activeStatus: document.getElementById("active-status"),
        activeAmount: document.getElementById("active-amount"),
        activeAuto: document.getElementById("active-auto"),
        activeMultiplier: document.getElementById("active-multiplier"),
        activePayout: document.getElementById("active-payout"),
        planeSprite: document.getElementById("plane-sprite"),
        aviatorStage: document.getElementById("aviator-stage"),
        crashBurst: document.getElementById("crash-burst"),
    };

    function showNote(message, isError) {
        els.betNote.textContent = message;
        els.betNote.style.color = isError ? "#fca5a5" : "#cbd5e1";
    }

    function formatNumber(value) {
        if (value === null || typeof value === "undefined" || value === "") return "--";
        return Number(value).toFixed(2);
    }

    function renderHistory() {
        if (!els.historyStrip) return;
        if (!state.history.length) {
            els.historyStrip.innerHTML = '<div class="history-pill mid">No rounds yet</div>';
            return;
        }
        els.historyStrip.innerHTML = state.history.map((item) => `
            <div class="history-pill ${item.color || "mid"}">${formatNumber(item.multiplier)}x</div>
        `).join("");
    }

    function renderPlayers() {
        els.playerCountLabel.textContent = `${state.playerCount} players`;
        if (!state.players.length) {
            els.playersBody.innerHTML = '<div class="players-row pending"><span>Waiting</span><span>--</span><span>--</span><span>--</span></div>';
            return;
        }
        els.playersBody.innerHTML = state.players.map((player) => `
            <div class="players-row ${player.status}">
                <span>${player.username}</span>
                <span>${formatNumber(player.amount)}</span>
                <span>${player.cashout_multiplier ? `${formatNumber(player.cashout_multiplier)}x` : (player.auto_cashout ? `${formatNumber(player.auto_cashout)}x` : "--")}</span>
                <span>${player.payout ? formatNumber(player.payout) : "--"}</span>
            </div>
        `).join("");
    }

    function renderBetState() {
        const myBet = state.myBet;
        els.walletBalance.textContent = formatNumber(state.balance);
        els.activeStatus.textContent = myBet ? myBet.status : "idle";
        els.activeAmount.textContent = myBet ? formatNumber(myBet.amount) : "--";
        els.activeAuto.textContent = myBet && myBet.auto_cashout ? `${formatNumber(myBet.auto_cashout)}x` : "--";
        els.activeMultiplier.textContent = myBet && myBet.cashout_multiplier ? `${formatNumber(myBet.cashout_multiplier)}x` : "--";
        els.activePayout.textContent = myBet ? formatNumber(myBet.payout) : "--";

        const hasPendingBet = myBet && myBet.status === "pending";
        els.placeBetBtn.disabled = !(state.phase === "starting" && !hasPendingBet);
        els.cashoutBtn.disabled = !(state.phase === "running" && hasPendingBet);
    }

    function renderPhaseText() {
        els.phaseChip.textContent = state.phase.toUpperCase();
        els.seedHash.textContent = state.seedHash ? `${state.seedHash.slice(0, 16)}...` : "--";
        if (state.phase === "starting") {
            els.countdownPill.textContent = `Next round in ${state.countdown}s`;
            els.multiplierSub.textContent = "Place your bet before takeoff.";
        } else if (state.phase === "running") {
            els.countdownPill.textContent = "Live";
            els.multiplierSub.textContent = "Cash out before the plane disappears.";
        } else if (state.phase === "crashed") {
            els.countdownPill.textContent = "Crashed";
            els.multiplierSub.textContent = `Flight ended at ${formatNumber(state.crashPoint || state.targetMultiplier)}x`;
        }
    }

    function updatePlane(crashed) {
        const lift = Math.min(250, (Math.max(state.multiplier, 1) - 1) * 28);
        const drift = Math.min(430, (Math.max(state.multiplier, 1) - 1) * 52);
        els.planeSprite.style.transform = `translate(${drift}px, -${lift}px) rotate(-8deg)`;
        if (crashed) {
            const planeRect = els.planeSprite.getBoundingClientRect();
            const stageRect = els.aviatorStage.getBoundingClientRect();
            els.crashBurst.style.left = `${planeRect.left - stageRect.left - 24}px`;
            els.crashBurst.style.top = `${planeRect.top - stageRect.top - 28}px`;
            els.crashBurst.classList.remove("active");
            void els.crashBurst.offsetWidth;
            els.crashBurst.classList.add("active");
        }
    }

    function renderAll() {
        els.multiplierMain.textContent = `${formatNumber(state.multiplier)}x`;
        renderPhaseText();
        renderPlayers();
        renderBetState();
        renderHistory();
    }

    function animationLoop() {
        const diff = state.targetMultiplier - state.multiplier;
        if (Math.abs(diff) > 0.001) {
            state.multiplier += diff * 0.18;
        } else {
            state.multiplier = state.targetMultiplier;
        }
        els.multiplierMain.textContent = `${formatNumber(state.multiplier)}x`;
        updatePlane(false);
        requestAnimationFrame(animationLoop);
    }

    document.querySelectorAll("[data-step]").forEach((button) => {
        button.addEventListener("click", () => {
            const step = Number(button.dataset.step || 0);
            const nextValue = Math.max(10, Number(els.betAmount.value || 0) + step);
            els.betAmount.value = nextValue;
        });
    });

    els.autoBetToggle.addEventListener("change", () => {
        state.autoBet = els.autoBetToggle.checked;
        showNote(state.autoBet ? "Auto bet enabled for next countdown." : "Manual betting enabled.");
    });

    els.placeBetBtn.addEventListener("click", () => {
        socket.emit("aviator_place_bet", {
            amount: els.betAmount.value,
            auto_cashout: els.autoCashout.value,
        });
    });

    els.cashoutBtn.addEventListener("click", () => {
        socket.emit("aviator_cash_out");
    });

    socket.on("connect", () => {
        socket.emit("join_aviator");
    });

    socket.on("aviator_state", (payload) => {
        state.phase = payload.phase || state.phase;
        state.countdown = payload.countdown ?? state.countdown;
        state.targetMultiplier = Number(payload.multiplier || 1);
        state.multiplier = state.phase === "starting" ? 1 : state.multiplier;
        state.crashPoint = payload.crash_point ?? state.crashPoint;
        state.history = payload.history || state.history;
        state.players = payload.players || state.players;
        state.myBet = payload.my_bet || null;
        state.balance = Number(payload.balance ?? state.balance);
        state.seedHash = payload.seed_hash || state.seedHash;
        state.playerCount = Number(payload.player_count ?? state.playerCount);
        renderAll();
    });

    socket.on("aviator_countdown", (payload) => {
        state.phase = "starting";
        state.countdown = payload.countdown;
        state.seedHash = payload.seed_hash || state.seedHash;
        state.targetMultiplier = 1;
        state.multiplier = 1;
        renderAll();
        if (state.autoBet && !state.myBet) {
            socket.emit("aviator_place_bet", {
                amount: els.betAmount.value,
                auto_cashout: els.autoCashout.value,
            });
        }
    });

    socket.on("aviator_round_start", () => {
        state.phase = "running";
        state.targetMultiplier = 1;
        showNote("Flight live. Cash out before the crash.");
        renderAll();
    });

    socket.on("aviator_multiplier", (payload) => {
        state.phase = "running";
        state.targetMultiplier = Number(payload.multiplier || 1);
        renderBetState();
    });

    socket.on("aviator_crash", (payload) => {
        state.phase = "crashed";
        state.crashPoint = Number(payload.crash_point || 1);
        state.targetMultiplier = state.crashPoint;
        state.seedHash = payload.seed_hash || state.seedHash;
        renderAll();
        updatePlane(true);
    });

    socket.on("aviator_players", (payload) => {
        state.players = payload.players || [];
        state.playerCount = Number(payload.player_count || 0);
        renderPlayers();
    });

    socket.on("aviator_bet_placed", (payload) => {
        showNote(payload.message || "Bet placed.");
    });

    socket.on("aviator_result", (payload) => {
        showNote(payload.message || "Round settled.", payload.status === "loss");
    });

    socket.on("aviator_error", (payload) => {
        showNote(payload.message || "Aviator error.", true);
    });

    renderAll();
    requestAnimationFrame(animationLoop);
})();
