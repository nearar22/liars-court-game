/**
 * LIAR'S COURT — REAL-TIME ONLINE ENGINE
 * Firebase = Lobby + Real-time sync
 * GenLayer = AI Judge (Intelligent Contract)
 */

const RPC_URL = "https://rpc-bradbury.genlayer.com";
const CONTRACT_ADDRESS = "0xc1adF4C73A05FE720746DA8d15803B0DEC588439";

// ── STATE ──
let state = {
    connected: false,
    currentPhase: "LOBBY",
    currentRoomId: null,
    roomData: null,
    playerName: "",
    playerAddr: "",
    selectedTheme: "Geography",
    myVotes: {},
    myClaim: null,
};

// ── HELPERS ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
function shortAddr(a) { return a ? a.substring(0,6)+"..."+a.substring(38) : "???"; }

function addLog(msg) {
    const log = $("#activityLog");
    const t = new Date();
    const time = t.getHours().toString().padStart(2,"0")+":"+t.getMinutes().toString().padStart(2,"0");
    log.innerHTML = `<div class="log-entry"><span class="log-time">${time}</span><span class="log-msg">${msg}</span></div>` + log.innerHTML;
    if (log.children.length > 20) log.lastChild.remove();
}

// ══════════════════════════════════
//  FIREBASE SETUP
// ══════════════════════════════════
const firebaseConfig = {
    apiKey: "AIzaSyAZALzXYxbE6pvUS-2NrVEmo04iH8AFQAA",
    authDomain: "liars-court.firebaseapp.com",
    databaseURL: "https://liars-court-default-rtdb.firebaseio.com",
    projectId: "liars-court",
    storageBucket: "liars-court.firebasestorage.app",
    messagingSenderId: "737991898395",
    appId: "1:737991898395:web:ae46b1bbedd0f85c190fbe"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ══════════════════════════════════
//  WALLET
// ══════════════════════════════════
async function connectWallet() {
    if (!window.ethereum) return alert("Install MetaMask or Rabby!");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.playerAddr = accounts[0];
    state.playerName = shortAddr(state.playerAddr);
    state.connected = true;
    $("#connectWalletBtn").textContent = `⚡ ${state.playerName}`;
    $("#connectWalletBtn").classList.add("connected");
    addLog(`Wallet connected: <span class="highlight">${state.playerName}</span>`);
}

// ══════════════════════════════════
//  ROOM LISTING (Active Courts)
// ══════════════════════════════════
function loadRoomList() {
    db.ref('rooms').on('value', (snap) => {
        const rooms = snap.val() || {};
        const list = $("#roomList");
        list.innerHTML = "";

        Object.entries(rooms).forEach(([id, room]) => {
            if (room.phase === "LOBBY" || room.phase === "CLAIMING" || room.phase === "VOTING") {
                const playerCount = room.players ? Object.keys(room.players).length : 0;
                const li = document.createElement("li");
                li.className = "room-item";
                li.innerHTML = `
                    <div class="room-item-info">
                        <strong>${room.name || "Court"}</strong>
                        <span class="room-item-meta">${room.theme} · ${playerCount}/4</span>
                    </div>
                    <button class="room-join-btn" data-id="${id}">JOIN</button>
                `;
                li.querySelector(".room-join-btn").onclick = () => joinRoom(id);
                list.appendChild(li);
            }
        });

        if (!list.children.length) {
            list.innerHTML = '<li style="color:var(--text-dim);text-align:center;padding:1rem;font-size:0.8rem;">No active courts. Create one!</li>';
        }
    });
}

// ══════════════════════════════════
//  CREATE ROOM (Firebase only - instant)
// ══════════════════════════════════
function closeModal() {
    const m = $("#createRoomModal");
    m.classList.remove("visible");
    m.style.display = "none";
}

async function createRoom() {
    if (!state.connected) return alert("Connect wallet first!");

    const name = $("#newRoomName").value.trim() || "Court " + Math.floor(Math.random()*999);
    const theme = state.selectedTheme;
    const maxP = parseInt($("#maxPlayersSelect").value) || 4;

    closeModal();

    // Generate a short numeric code
    const code = String(Date.now()).slice(-6);

    const roomData = {
        name, theme, maxPlayers: maxP,
        phase: "LOBBY",
        host: state.playerAddr,
        createdAt: Date.now(),
        players: {}
    };
    roomData.players[state.playerAddr] = { name: state.playerName, address: state.playerAddr };

    await db.ref('rooms/' + code).set(roomData);

    state.currentRoomId = code;
    showPhase("LOBBY");
    listenToRoom(code);

    addLog(`Court <span class="highlight">${name}</span> created! Code: <span class="highlight">${code}</span>`);
}

// ══════════════════════════════════
//  JOIN ROOM
// ══════════════════════════════════
async function joinRoom(code) {
    if (!state.connected) return alert("Connect wallet first!");

    const snap = await db.ref('rooms/' + code).once('value');
    const room = snap.val();
    if (!room) return alert("Room not found!");

    const players = room.players ? Object.keys(room.players) : [];
    if (players.length >= (room.maxPlayers || 4)) return alert("Room is full!");
    if (players.includes(state.playerAddr)) {
        // Already in room, just listen
        state.currentRoomId = code;
        showPhase("LOBBY");
        listenToRoom(code);
        return;
    }

    await db.ref(`rooms/${code}/players/${state.playerAddr}`).set({
        name: state.playerName,
        address: state.playerAddr
    });

    state.currentRoomId = code;
    showPhase("LOBBY");
    listenToRoom(code);

    addLog(`Joined Court <span class="highlight">${room.name}</span>!`);
}

async function joinByCode() {
    const code = $("#joinCodeInput").value.trim();
    if (!code) return alert("Enter a court code!");
    if (!state.connected) return alert("Connect wallet first!");
    await joinRoom(code);
}

// ══════════════════════════════════
//  REAL-TIME LISTENER (Firebase)
// ══════════════════════════════════
function listenToRoom(code) {
    db.ref('rooms/' + code).on('value', (snap) => {
        const room = snap.val();
        if (!room) return;

        state.roomData = room;
        const oldPhase = state.currentPhase;

        // Update header
        $("#lobbyRoomName").textContent = room.name || "Liar's Court";
        $("#lobbyRoomCode").textContent = code;
        $("#themeName").textContent = room.theme;
        const themeEmojis = {Geography:"🌍",History:"📜",Science:"🔬",Sports:"⚽",Technology:"💻",Random:"🎲"};
        $(".theme-icon").textContent = themeEmojis[room.theme] || "🌍";

        // Players grid
        const players = room.players ? Object.values(room.players) : [];
        renderPlayers(players, room.maxPlayers || 4, room.host);

        // Start button
        const startBtn = $("#startGameBtn");
        const isHost = room.host === state.playerAddr;
        if (room.phase === "LOBBY") {
            if (isHost) {
                startBtn.disabled = players.length < 2;
                startBtn.textContent = players.length < 2 ? `NEED 2+ PLAYERS (${players.length})` : "▶ START GAME";
            } else {
                startBtn.disabled = true;
                startBtn.textContent = "WAITING FOR HOST...";
            }
        }

        // Phase change
        if (room.phase !== oldPhase) {
            state.currentPhase = room.phase;
            showPhase(room.phase);
            addLog(`Phase: <span class="highlight">${room.phase}</span>`);

            // Build voting UI when entering VOTING
            if (room.phase === "VOTING" && room.claims) {
                buildVotingUI(room.claims);
            }

            // Show results
            if (room.phase === "RESULTS" && room.results) {
                showResults(room.results, room.winner);
            }
        }
    });
}

// ══════════════════════════════════
//  RENDER PLAYERS
// ══════════════════════════════════
function renderPlayers(players, max, host) {
    const grid = $("#playersGrid");
    const avatars = ["🦊","🐺","🦅","🐲"];
    let html = "";
    for (let i = 0; i < max; i++) {
        const p = players[i];
        if (p) {
            const isYou = p.address?.toLowerCase() === state.playerAddr.toLowerCase();
            const isHost = p.address === host;
            html += `<div class="player-slot occupied ${isYou?'you':''} animate-in">
                ${isHost ? '<div class="player-badge-you">HOST</div>' : ''}
                <div class="player-avatar">${avatars[i%4]}</div>
                <div class="player-name">${isYou ? "YOU" : (p.name||shortAddr(p.address))}</div>
                <div class="player-status"><span class="status-dot"></span> Online</div>
            </div>`;
        } else {
            html += `<div class="player-slot empty">
                <div class="player-avatar">❓</div>
                <div class="player-name" style="color:var(--text-dim)">Empty</div>
                <div class="player-status" style="color:var(--text-dim)">Waiting...</div>
            </div>`;
        }
    }
    grid.innerHTML = html;
}

// ══════════════════════════════════
//  GAME ACTIONS
// ══════════════════════════════════
async function startGame() {
    if (!state.currentRoomId) return;
    await db.ref('rooms/' + state.currentRoomId).update({ phase: "CLAIMING" });
    addLog("Court session started!");
}

async function submitClaim() {
    const text = $("#claimInput").value.trim();
    if (!text) return alert("Write your claim!");
    const isLie = $("#isLieToggle").checked;

    // Save claim to Firebase
    await db.ref(`rooms/${state.currentRoomId}/claims/${state.playerAddr}`).set({
        text, isLie, username: state.playerName
    });

    state.myClaim = { text, isLie };
    addLog("Claim submitted!");

    // Check if all players submitted
    const snap = await db.ref('rooms/' + state.currentRoomId).once('value');
    const room = snap.val();
    const playerCount = Object.keys(room.players).length;
    const claimCount = room.claims ? Object.keys(room.claims).length : 0;

    if (claimCount >= playerCount) {
        await db.ref('rooms/' + state.currentRoomId).update({ phase: "VOTING" });
    } else {
        showPhase("WAITING");
    }
}

// ══════════════════════════════════
//  VOTING UI
// ══════════════════════════════════
function buildVotingUI(claims) {
    const grid = $("#claimsGrid");
    let html = "<h3 style='grid-column:1/-1;color:var(--gold);'>Vote on each claim: Truth or Lie?</h3>";

    for (const [addr, claim] of Object.entries(claims)) {
        if (addr === state.playerAddr) continue; // Don't vote on own claim
        const name = claim.username || shortAddr(addr);
        html += `
            <div class="card claim-card" style="padding:1.5rem;">
                <p style="color:var(--text-dim);font-size:0.75rem;margin-bottom:0.5rem;">Claimed by ${name}</p>
                <p style="font-size:1rem;color:var(--text-light);margin-bottom:1rem;">"${claim.text}"</p>
                <div style="display:flex;gap:0.5rem;">
                    <button class="vote-btn vote-truth" data-addr="${addr}" data-vote="TRUTH" 
                        style="flex:1;padding:0.7rem;border:2px solid var(--emerald);background:transparent;color:var(--emerald);border-radius:8px;cursor:pointer;font-weight:700;">
                        ✓ TRUTH
                    </button>
                    <button class="vote-btn vote-lie" data-addr="${addr}" data-vote="LIE"
                        style="flex:1;padding:0.7rem;border:2px solid var(--crimson);background:transparent;color:var(--crimson);border-radius:8px;cursor:pointer;font-weight:700;">
                        🤥 LIE
                    </button>
                </div>
            </div>
        `;
    }
    grid.innerHTML = html;

    // Attach vote button handlers
    state.myVotes = {};
    grid.querySelectorAll(".vote-btn").forEach(btn => {
        btn.onclick = () => {
            const addr = btn.dataset.addr;
            const vote = btn.dataset.vote;
            state.myVotes[addr] = vote;

            // Highlight selected
            grid.querySelectorAll(`[data-addr="${addr}"]`).forEach(b => {
                b.style.background = "transparent";
                b.style.color = b.dataset.vote === "TRUTH" ? "var(--emerald)" : "var(--crimson)";
            });
            btn.style.background = vote === "TRUTH" ? "var(--emerald)" : "var(--crimson)";
            btn.style.color = "#000";
        };
    });
}

async function submitVotes() {
    if (Object.keys(state.myVotes).length === 0) return alert("Vote on at least one claim!");

    await db.ref(`rooms/${state.currentRoomId}/votes/${state.playerAddr}`).set(state.myVotes);
    addLog("Votes submitted!");

    // Check if all voted
    const snap = await db.ref('rooms/' + state.currentRoomId).once('value');
    const room = snap.val();
    const playerCount = Object.keys(room.players).length;
    const voteCount = room.votes ? Object.keys(room.votes).length : 0;

    if (voteCount >= playerCount) {
        await db.ref('rooms/' + state.currentRoomId).update({ phase: "JUDGING" });
        addLog("AI Judge is analyzing claims...");

        // Calculate results locally
        setTimeout(() => calculateResults(room), 3000);
    } else {
        showPhase("WAITING");
        $("#waitingText").textContent = "Waiting for other players to vote...";
    }
}

// ══════════════════════════════════
//  AI JUDGE (LOCAL CALCULATION)
// ══════════════════════════════════
async function calculateResults(room) {
    const results = {};
    const claims = room.claims || {};
    const votes = room.votes || {};
    const players = room.players || {};

    for (const [addr, claim] of Object.entries(claims)) {
        let lieVotes = 0;
        let totalVoters = 0;

        for (const [voter, voterVotes] of Object.entries(votes)) {
            if (voter !== addr && voterVotes[addr]) {
                totalVoters++;
                if (voterVotes[addr] === "LIE") lieVotes++;
            }
        }

        const wasCaught = totalVoters > 0 && lieVotes > totalVoters / 2;
        let points = 0;

        if (claim.isLie && !wasCaught) points = 3;
        else if (claim.isLie && wasCaught) points = -1;
        else if (!claim.isLie) points = 1;

        // Voter bonus
        for (const [voter, voterVotes] of Object.entries(votes)) {
            if (voter !== addr && voterVotes[addr]) {
                const correct = (voterVotes[addr] === "LIE" && claim.isLie) ||
                               (voterVotes[addr] === "TRUTH" && !claim.isLie);
                if (correct && !results[voter]) results[voter] = { points: 0, was_lie: false, was_caught: false };
                if (correct && results[voter]) results[voter].points += 1;
            }
        }

        results[addr] = {
            ...results[addr],
            text: claim.text,
            was_lie: claim.isLie,
            was_caught: wasCaught,
            lie_votes: lieVotes,
            points: (results[addr]?.points || 0) + points,
            username: claim.username
        };
    }

    // Find winner
    let winner = "";
    let best = -999;
    for (const [addr, r] of Object.entries(results)) {
        if (r.points > best) { best = r.points; winner = addr; }
    }

    await db.ref('rooms/' + state.currentRoomId).update({
        phase: "RESULTS",
        results,
        winner
    });
}

// ══════════════════════════════════
//  RESULTS
// ══════════════════════════════════
function showResults(results, winner) {
    $("#resultsOverlay").classList.add("visible");
    const winnerData = results[winner];
    $("#winnerName").textContent = `🏆 Winner: ${winnerData?.username || shortAddr(winner)}`;

    let html = "";
    for (const [addr, res] of Object.entries(results)) {
        const declared = res.was_lie ? "🤥 Declared Lie" : "✓ Declared True";
        html += `<tr>
            <td><strong>${res.username || shortAddr(addr)}</strong></td>
            <td>
                <div style="font-size:0.8rem;margin-bottom:6px;line-height:1.4;">"${res.text}"</div>
                <div style="font-size:0.65rem;color:var(--text-muted);font-weight:600;">${declared}</div>
            </td>
            <td><span class="verdict ${res.was_caught?'verdict-caught':'verdict-true'}">${res.was_caught?'CAUGHT':'CLEAN'}</span></td>
            <td class="${res.points>=0?'points-positive':'points-negative'}">${res.points>0?'+':''}${res.points}</td>
        </tr>`;
    }
    $("#resultsBody").innerHTML = html;
}

// ══════════════════════════════════
//  PHASE MANAGEMENT
// ══════════════════════════════════
function showPhase(phase) {
    state.currentPhase = phase;
    const map = {
        "LOBBY": "roomLobby",
        "CLAIMING": "claimSection",
        "VOTING": "votingSection",
        "JUDGING": "judgingSection",
        "WAITING": "waitingSection"
    };
    const active = map[phase] || "waitingSection";
    ["roomLobby","claimSection","votingSection","judgingSection","waitingSection"]
        .forEach(s => $(`#${s}`).style.display = s === active ? "block" : "none");

    $$(".phase-step").forEach(s => {
        s.classList.remove("active","completed");
        if (s.dataset.phase === phase) s.classList.add("active");
    });
}

// ══════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════
function setupEventListeners() {
    $("#connectWalletBtn").onclick = connectWallet;

    const createModal = $("#createRoomModal");
    $("#createRoomBtn").addEventListener("click", () => {
        createModal.classList.add("visible");
        createModal.style.display = "flex";
        createModal.style.opacity = "1";
    });
    $("#cancelCreateBtn").addEventListener("click", closeModal);
    $("#confirmCreateBtn").onclick = createRoom;

    $("#startGameBtn").onclick = startGame;
    $("#submitClaimBtn").onclick = submitClaim;
    $("#submitVotesBtn").onclick = submitVotes;
    $("#joinByCodeBtn").onclick = joinByCode;

    $("#copyCodeBtn") && ($("#copyCodeBtn").onclick = () => {
        navigator.clipboard.writeText(state.currentRoomId || "");
        $("#copyCodeBtn").textContent = "✅ Copied!";
        setTimeout(() => $("#copyCodeBtn").textContent = "📋 Copy", 2000);
    });

    $("#playAgainBtn") && ($("#playAgainBtn").onclick = () => {
        $("#resultsOverlay").classList.remove("visible");
        state.currentRoomId = null;
        showPhase("LOBBY");
    });

    $$("#themeOptions .theme-option").forEach(opt => {
        opt.onclick = () => {
            $$("#themeOptions .theme-option").forEach(o => o.classList.remove("selected"));
            opt.classList.add("selected");
            state.selectedTheme = opt.dataset.theme;
        };
    });

    $("#isLieToggle").onchange = () => {
        const isLie = $("#isLieToggle").checked;
        $("#toggleLabel").textContent = isLie ? "This is a LIE 🤥" : "This is TRUE ✓";
        $("#toggleLabel").style.color = isLie ? "var(--crimson)" : "var(--emerald)";
    };
}

// ══════════════════════════════════
//  INIT
// ══════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
    setupEventListeners();
    loadRoomList();
    addLog("Bradbury Testnet <span class=\"highlight\">Real-Time</span> Engine Ready.");
    showPhase("LOBBY");
});
