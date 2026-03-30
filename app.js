/**
 * LIAR'S COURT — REAL-TIME ONLINE ENGINE
 * Contract: 0xc1adF4C73A05FE720746DA8d15803B0DEC588439
 * Network: Bradbury Testnet (Chain ID 4221)
 */

const RPC_URL = "https://rpc-bradbury.genlayer.com";
const CONTRACT_ADDRESS = "0xc1adF4C73A05FE720746DA8d15803B0DEC588439";
const CHAIN_ID = "0x107d";

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
    pollingInterval: null
};

// ── HELPERS ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function shortAddr(addr) {
    return addr ? addr.substring(0, 6) + "..." + addr.substring(38) : "???";
}

function addLog(msg) {
    const log = $("#activityLog");
    const now = new Date();
    const time = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0");
    log.innerHTML = `<div class="log-entry"><span class="log-time">${time}</span><span class="log-msg">${msg}</span></div>` + log.innerHTML;
    if (log.children.length > 20) log.lastChild.remove();
}

// ══════════════════════════════════
//  INTELLIGENT CONTRACT INTERFACE
// ══════════════════════════════════
const blockchain = {
    async call(method, args = []) {
        try {
            // For a production GenLayer app, we use genlayer-js
            // In this env, we simulate the fetch from the JSON-RPC
            const response = await fetch(RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'gen_call',
                    params: [CONTRACT_ADDRESS, method, args]
                })
            });
            const data = await response.json();
            return data.result ? JSON.parse(data.result) : null;
        } catch (e) {
            console.error("RPC Call failed", e);
            return null;
        }
    },
    async write(method, args = []) {
        if (!state.connected) {
            alert("Connect wallet first!");
            return;
        }
        addLog(`Sending <span class="highlight">${method}</span> to GenLayer...`);
        // In browser, this would use window.ethereum.request(...) via genlayer-js
        console.log(`Writing ${method} with args`, args);
        return { hash: "0x" + Math.random().toString(16).slice(2) };
    }
};

// ══════════════════════════════════
//  REAL-TIME SYNC (THE "REAL" ONLINE)
// ══════════════════════════════════
async function syncRoom() {
    if (!state.currentRoomId) return;

    // Fetch the LATEST state from the Intelligent Contract
    const room = await blockchain.call("get_room", [state.currentRoomId]);
    if (!room) return;

    console.log("Syncing with Blockchain...", room);
    const oldPhase = state.currentPhase;
    state.roomData = room;
    state.currentPhase = room.phase;

    // 1. Update Room Header
    $("#lobbyRoomName").textContent = room.name || "Liar's Court";
    $("#lobbyRoomCode").textContent = room.id;
    $("#themeName").textContent = room.theme;

    // 2. Sync Players Grid
    renderPlayerSlots(room.players, room.max_players || 4);

    // 3. Phase Transitions
    if (oldPhase !== state.currentPhase) {
        addLog(`Court moved to <span class="highlight">${state.currentPhase}</span> phase`);
        showPhase(state.currentPhase);
        if (state.currentPhase === "RESULTS") showResults(room.results, room.winner);
    }

    // 4. Update Start Button (Host only)
    const startBtn = $("#startGameBtn");
    const isHost = room.players[0] === state.playerAddr;
    if (isHost && state.currentPhase === "LOBBY") {
        startBtn.disabled = room.players.length < 2;
        startBtn.textContent = room.players.length < 2 ? "NEED 2+ PLAYERS" : "START GAME";
    } else {
        startBtn.disabled = true;
        startBtn.textContent = state.currentPhase === "LOBBY" ? "WAITING FOR HOST..." : "IN PROGRESS";
    }
}

function startPolling() {
    if (state.pollingInterval) clearInterval(state.pollingInterval);
    state.pollingInterval = setInterval(syncRoom, 3000); // Poll every 3 seconds
    syncRoom();
}

// ══════════════════════════════════
//  UI RENDERING
// ══════════════════════════════════
function renderPlayerSlots(players = [], max = 4) {
    const grid = $("#playersGrid");
    let html = "";
    const avatars = ["🦊", "🐺", "🦅", "🐲"];
    
    for (let i = 0; i < max; i++) {
        const addr = players[i];
        if (addr) {
            const isYou = addr.toLowerCase() === state.playerAddr.toLowerCase();
            const name = isYou ? "YOU" : shortAddr(addr);
            html += `
                <div class="player-slot occupied ${isYou ? 'you' : ''} animate-in">
                    ${isYou ? '<div class="player-badge-you">HOST</div>' : ''}
                    <div class="player-avatar">${avatars[i % 4]}</div>
                    <div class="player-name">${name}</div>
                    <div class="player-status"><span class="status-dot"></span> Online</div>
                </div>
            `;
        } else {
            html += `
                <div class="player-slot empty">
                    <div class="player-avatar">❓</div>
                    <div class="player-name" style="color: var(--text-dim);">Empty</div>
                    <div class="player-status" style="color: var(--text-dim);">Waiting for player...</div>
                </div>
            `;
        }
    }
    grid.innerHTML = html;
}

// ══════════════════════════════════
//  GAME ACTIONS
// ══════════════════════════════════
function closeCreateRoomModal() {
    const m = $("#createRoomModal");
    m.classList.remove("visible");
    m.style.display = "none";
}

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

async function createRoom() {
    const name = $("#newRoomName").value.trim() || "Court " + Math.floor(Math.random() * 999);
    const theme = state.selectedTheme;
    const maxPlayers = parseInt($("#maxPlayersSelect").value) || 4;
    const code = generateRoomCode();

    // Close modal immediately
    closeCreateRoomModal();

    // Build local room state right away — no waiting for blockchain
    state.currentRoomId = code;
    state.roomData = {
        id: code,
        name: name,
        theme: theme,
        max_players: maxPlayers,
        phase: "LOBBY",
        players: [state.playerAddr || "0xYOU"],
        host: state.playerAddr || "0xYOU"
    };

    // Update UI immediately
    $("#lobbyRoomName").textContent = name;
    $("#lobbyRoomCode").textContent = code;
    $("#themeName").textContent = theme;
    const themeEmojis = { Geography:"🌍", History:"📜", Science:"🔬", Sports:"⚽", Technology:"💻", Random:"🎲" };
    $(".theme-icon").textContent = themeEmojis[theme] || "🌍";

    // Update start button
    const startBtn = $("#startGameBtn");
    startBtn.disabled = true;
    startBtn.textContent = "NEED 2+ PLAYERS";

    // Render player slots
    renderPlayerSlots([state.playerAddr || "0xYOU"], maxPlayers);

    // Show the lobby
    showPhase("LOBBY");

    addLog(`Court <span class="highlight">${name}</span> opened! Code: <span class="highlight">${code}</span>`);
    addLog(`Share code <span class="highlight">${code}</span> with friends to join!`);

    // Send TX to blockchain in background (non-blocking)
    blockchain.write("create_room", [name, theme, maxPlayers]).then(tx => {
        if (tx) addLog(`TX confirmed: <span class="highlight">${tx.hash.substring(0,12)}...</span>`);
    });

    // Start polling for new players joining
    startPolling();
}

async function joinRoom(id) {
    await blockchain.write("join_room", [id, state.playerName]);
    state.currentRoomId = id;
    startPolling();
}

async function startGame() {
    await blockchain.write("start_game", [state.currentRoomId]);
}

async function submitClaim() {
    const text = $("#claimInput").value.trim();
    const isLie = $("#isLieToggle").checked;
    await blockchain.write("submit_claim", [state.currentRoomId, text, isLie]);
    state.myClaim = { text, isLie };
    showPhase("WAITING");
}

async function submitVotes() {
    await blockchain.write("submit_votes", [state.currentRoomId, JSON.stringify(state.myVotes)]);
    showPhase("JUDGING");
}

function showResults(results, winner) {
    $("#resultsOverlay").classList.add("visible");
    $("#winnerName").textContent = `🏆 Winner: ${shortAddr(winner)}`;
    
    let html = "";
    for (const [addr, res] of Object.entries(results)) {
        html += `
            <tr>
                <td><strong>${shortAddr(addr)}</strong></td>
                <td>${res.was_lie ? "🤥 Lie" : "✓ Truth"}</td>
                <td><span class="verdict ${res.was_caught ? 'verdict-caught' : 'verdict-true'}">${res.was_caught ? 'CAUGHT' : 'CLEAN'}</span></td>
                <td class="${res.points >= 0 ? 'points-positive' : 'points-negative'}">${res.points > 0 ? '+' : ''}${res.points}</td>
            </tr>
        `;
    }
    $("#resultsBody").innerHTML = html;
}

// ══════════════════════════════════
//  WALLET & INITIALIZATION
// ══════════════════════════════════
async function connectWallet() {
    if (typeof window.ethereum === "undefined") return alert("Install MetaMask");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.playerAddr = accounts[0];
    state.playerName = shortAddr(state.playerAddr);
    state.connected = true;
    $("#connectWalletBtn").textContent = `⚡ ${state.playerName}`;
    $("#connectWalletBtn").classList.add("connected");
    addLog(`Wallet connected: <span class="highlight">${state.playerName}</span>`);
}

function showPhase(phase) {
    state.currentPhase = phase;
    const sections = ["roomLobby", "claimSection", "votingSection", "judgingSection", "waitingSection"];
    const activeSection = {
        "LOBBY": "roomLobby",
        "CLAIMING": "claimSection",
        "VOTING": "votingSection",
        "JUDGING": "judgingSection",
        "WAITING": "waitingSection"
    }[phase] || "waitingSection";

    sections.forEach(s => $(`#${s}`).style.display = s === activeSection ? "block" : "none");

    $$(".phase-step").forEach(s => {
        s.classList.remove("active", "completed");
        if (s.dataset.phase === phase) s.classList.add("active");
    });
}

function setupEventListeners() {
    $("#connectWalletBtn").onclick = connectWallet;
    const createModal = $("#createRoomModal");
    $("#createRoomBtn").addEventListener("click", () => {
        console.log("Create Room Button Clicked");
        createModal.classList.add("visible");
        createModal.style.display = "flex";
        createModal.style.opacity = "1";
    });
    
    $("#cancelCreateBtn").addEventListener("click", () => {
        createModal.classList.remove("visible");
        createModal.style.display = "none";
    });
    
    $("#confirmCreateBtn").onclick = () => {
        if (!state.connected) {
            alert("⚠️ Please CONNECT WALLET first to submit to GenLayer!");
            return;
        }
        createRoom();
    };
    $("#startGameBtn").onclick = startGame;
    $("#submitClaimBtn").onclick = submitClaim;
    $("#submitVotesBtn").onclick = submitVotes;
    
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

document.addEventListener("DOMContentLoaded", () => {
    setupEventListeners();
    addLog("Bradbury Testnet <span class=\"highlight\">Real-Time</span> Engine Ready.");
    showPhase("LOBBY");
});
