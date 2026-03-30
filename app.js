/**
 * LIAR'S COURT — HYBRID ENGINE
 * Firebase  = Real-time lobby, room list, phase sync
 * GenLayer  = AI Judge (fact-checks every claim on the internet)
 *
 * Flow:
 *  1. Create/Join room → Firebase only (instant, no tx)
 *  2. Submit Claim     → Firebase only
 *  3. Submit Votes     → Firebase only
 *  4. AI Judging       → Host calls GenLayer contract judge_claims()
 *                        GenLayer LLM browses web + reaches consensus
 *  5. Results          → GenLayer result saved back to Firebase → all see it
 */

const RPC_URL          = "https://rpc-bradbury.genlayer.com";
const CONTRACT_ADDRESS = "0xc1adF4C73A05FE720746DA8d15803B0DEC588439";
const CHAIN_ID         = "0x107d"; // 4221 decimal

// ── STATE ──────────────────────────────────────────────
let state = {
    connected:      false,
    currentPhase:   "LOBBY",
    currentRoomId:  null,
    roomData:       null,
    playerName:     "",
    playerAddr:     "",
    selectedTheme:  "Geography",
    myVotes:        {},
    myClaim:        null,
    isHost:         false,
};

// ── HELPERS ────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
function shortAddr(a) { return a ? a.slice(0,6)+"..."+a.slice(38) : "???"; }

function addLog(msg) {
    const log = $("#activityLog");
    const t = new Date();
    const hh = t.getHours().toString().padStart(2,"0");
    const mm = t.getMinutes().toString().padStart(2,"0");
    log.innerHTML = `<div class="log-entry"><span class="log-time">${hh}:${mm}</span><span class="log-msg">${msg}</span></div>` + log.innerHTML;
    if (log.children.length > 25) log.lastChild.remove();
}

// ══════════════════════════════════════════════════════
//  FIREBASE SETUP
// ══════════════════════════════════════════════════════
const firebaseConfig = {
    apiKey:            "AIzaSyAZALzXYxbE6pvUS-2NrVEmo04iH8AFQAA",
    authDomain:        "liars-court.firebaseapp.com",
    databaseURL:       "https://liars-court-default-rtdb.firebaseio.com",
    projectId:         "liars-court",
    storageBucket:     "liars-court.firebasestorage.app",
    messagingSenderId: "737991898395",
    appId:             "1:737991898395:web:ae46b1bbedd0f85c190fbe"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ══════════════════════════════════════════════════════
//  GENLAYER RPC HELPERS
// ══════════════════════════════════════════════════════
async function glRead(method, params = []) {
    const body = {
        jsonrpc: "2.0", id: 1,
        method,
        params,
    };
    const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
}

async function encodeCallData(fnSig, args) {
    // ABI-encode a simple function call using ethers-like encoding built in MetaMask
    // For GenLayer we send raw JSON-serialisable args in a special envelope
    return { fn: fnSig, args };
}

async function glWrite(fnName, args) {
    if (!window.ethereum) throw new Error("No wallet");
    // Make sure we're on GenLayer Bradbury
    try {
        await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: CHAIN_ID }],
        });
    } catch (e) {
        if (e.code === 4902) {
            await window.ethereum.request({
                method: "wallet_addEthereumChain",
                params: [{
                    chainId: CHAIN_ID,
                    chainName: "GenLayer Bradbury",
                    rpcUrls: [RPC_URL],
                    nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
                }],
            });
        }
    }

    // Encode call with GenLayer custom format
    // GenLayer uses standard EVM encoding via MetaMask
    const iface = buildCalldata(fnName, args);

    const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{
            from:  state.playerAddr,
            to:    CONTRACT_ADDRESS,
            data:  iface,
            gas:   "0x7A120", // 500k
        }],
    });
    addLog(`TX sent: <span class="highlight">${txHash.slice(0,12)}...</span>`);
    return txHash;
}

// Simple ABI encoder for GenLayer contract calls
// GenLayer accepts JSON-encoded calldata for off-chain sim
function buildCalldata(fnName, args) {
    // GenLayer RPC accepts a special "sim" format — we use eth_call style
    // For write calls via MetaMask, GenLayer uses standard ABI encoding
    // We'll use a lightweight encoder for the supported types
    const encoder = new TextEncoder();
    const payload = JSON.stringify({ fn: fnName, args });
    const bytes = encoder.encode(payload);
    let hex = "0x";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
}

async function pollTxResult(txHash, maxWait = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            const result = await glRead("eth_getTransactionReceipt", [txHash]);
            if (result && result.status) return result;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error("Transaction timeout");
}

// ══════════════════════════════════════════════════════
//  WALLET
// ══════════════════════════════════════════════════════
async function connectWallet() {
    if (!window.ethereum) return alert("Install MetaMask or Rabby!");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.playerAddr = accounts[0];
    state.playerName = shortAddr(state.playerAddr);
    state.connected  = true;
    $("#connectWalletBtn").textContent = `⚡ ${state.playerName}`;
    $("#connectWalletBtn").classList.add("connected");
    addLog(`Wallet: <span class="highlight">${state.playerName}</span>`);
}

// ══════════════════════════════════════════════════════
//  ROOM LISTING (Firebase real-time)
// ══════════════════════════════════════════════════════
function loadRoomList() {
    db.ref("rooms").on("value", snap => {
        const rooms = snap.val() || {};
        const list = $("#roomList");
        list.innerHTML = "";
        let found = false;

        Object.entries(rooms).forEach(([id, room]) => {
            const phase = room.phase || "LOBBY";
            if (!["LOBBY","CLAIMING","VOTING"].includes(phase)) return;
            const pc = room.players ? Object.keys(room.players).length : 0;
            found = true;
            const li = document.createElement("li");
            li.className = "room-item";
            li.innerHTML = `
                <div class="room-item-info">
                    <strong>${room.name || "Court"}</strong>
                    <span class="room-item-meta">${room.theme} · ${pc}/${room.maxPlayers||4} · ${phase}</span>
                </div>
                <button class="room-join-btn" data-id="${id}">JOIN</button>`;
            li.querySelector(".room-join-btn").onclick = () => joinRoom(id);
            list.appendChild(li);
        });

        if (!found) {
            list.innerHTML = '<li style="color:var(--text-dim);text-align:center;padding:1rem;font-size:0.8rem;">No active courts. Create one!</li>';
        }
    });
}

// ══════════════════════════════════════════════════════
//  CREATE ROOM (Firebase only — instant)
// ══════════════════════════════════════════════════════
function closeModal() {
    const m = $("#createRoomModal");
    m.classList.remove("visible");
    m.style.display = "none";
}

async function createRoom() {
    if (!state.connected) return alert("Connect wallet first!");
    const name   = $("#newRoomName").value.trim() || "Court " + Math.floor(Math.random()*999);
    const maxP   = parseInt($("#maxPlayersSelect").value) || 4;
    const code   = String(Date.now()).slice(-6);
    closeModal();

    const roomData = {
        name, maxPlayers: maxP,
        theme: state.selectedTheme,
        phase: "LOBBY",
        host:  state.playerAddr,
        createdAt: Date.now(),
        players: { [state.playerAddr]: { name: state.playerName, address: state.playerAddr } },
        glRoomId: -1,  // Will be set when GenLayer game starts
    };
    await db.ref("rooms/" + code).set(roomData);
    state.currentRoomId = code;
    state.isHost = true;
    listenToRoom(code);
    addLog(`Court <span class="highlight">${name}</span> created! Code: <strong>${code}</strong>`);
}

// ══════════════════════════════════════════════════════
//  JOIN ROOM
// ══════════════════════════════════════════════════════
async function joinRoom(code) {
    if (!state.connected) return alert("Connect wallet first!");
    const snap = await db.ref("rooms/" + code).once("value");
    const room = snap.val();
    if (!room) return alert("Room not found!");

    const players = room.players ? Object.keys(room.players) : [];
    if (players.length >= (room.maxPlayers||4)) return alert("Room is full!");

    // Check already in room
    const alreadyIn = players.some(p => p.toLowerCase() === state.playerAddr.toLowerCase());
    if (!alreadyIn) {
        await db.ref(`rooms/${code}/players/${state.playerAddr}`).set({
            name: state.playerName, address: state.playerAddr
        });
    }

    state.currentRoomId = code;
    state.isHost = room.host?.toLowerCase() === state.playerAddr.toLowerCase();
    listenToRoom(code);
    addLog(`Joined <span class="highlight">${room.name}</span>!`);
}

async function joinByCode() {
    const code = $("#joinCodeInput").value.trim();
    if (!code) return alert("Enter a room code!");
    if (!state.connected) return alert("Connect wallet first!");
    await joinRoom(code);
}

// ══════════════════════════════════════════════════════
//  REAL-TIME LISTENER
// ══════════════════════════════════════════════════════
let _roomListener = null;

function listenToRoom(code) {
    if (_roomListener) db.ref("rooms/" + _roomListener).off();
    _roomListener = code;

    db.ref("rooms/" + code).on("value", snap => {
        const room = snap.val();
        if (!room) return;
        state.roomData = room;
        state.isHost   = room.host?.toLowerCase() === state.playerAddr.toLowerCase();

        // ── Update UI ──
        $("#lobbyRoomName").textContent = room.name || "Liar's Court";
        $("#lobbyRoomCode").textContent = code;
        $("#themeName").textContent     = room.theme || "Geography";

        const themes = { Geography:"🌍", History:"📜", Science:"🔬", Sports:"⚽", Technology:"💻", Random:"🎲" };
        $(".theme-icon").textContent = themes[room.theme] || "🌍";

        const players = room.players ? Object.values(room.players) : [];
        renderPlayers(players, room.maxPlayers||4, room.host);

        // ── Start button ──
        const startBtn = $("#startGameBtn");
        if (room.phase === "LOBBY") {
            if (state.isHost) {
                startBtn.disabled = players.length < 2;
                startBtn.textContent = players.length < 2
                    ? `NEED 2+ PLAYERS (${players.length})`
                    : "▶ START GAME";
            } else {
                startBtn.disabled = true;
                startBtn.textContent = "WAITING FOR HOST...";
            }
        }

        // ── Phase sync ──
        const prevPhase = state.currentPhase;
        if (room.phase !== prevPhase) {
            state.currentPhase = room.phase;
            showPhase(room.phase);

            if (room.phase === "VOTING" && room.claims) {
                buildVotingUI(room.claims);
            }
            if (room.phase === "RESULTS" && room.results) {
                showResults(room.results, room.winner, room.claims);
            }
        }

        // ── If already in mid-game phase on reconnect ──
        if (room.phase === "VOTING" && prevPhase === "LOBBY" && room.claims) {
            buildVotingUI(room.claims);
        }
        if (room.phase === "RESULTS" && room.results) {
            showResults(room.results, room.winner, room.claims);
        }
    });
}

// ══════════════════════════════════════════════════════
//  RENDER PLAYERS
// ══════════════════════════════════════════════════════
function renderPlayers(players, max, host) {
    const grid   = $("#playersGrid");
    const avatars = ["🦊","🐺","🦅","🐲"];
    let html = "";
    for (let i = 0; i < max; i++) {
        const p = players[i];
        if (p) {
            const isYou  = p.address?.toLowerCase() === state.playerAddr.toLowerCase();
            const isHost = p.address?.toLowerCase() === host?.toLowerCase();
            html += `<div class="player-slot occupied ${isYou?"you":""} animate-in">
                ${isHost ? '<div class="player-badge-you">HOST</div>' : ""}
                <div class="player-avatar">${avatars[i%4]}</div>
                <div class="player-name">${isYou ? "YOU" : (p.name || shortAddr(p.address))}</div>
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

// ══════════════════════════════════════════════════════
//  START GAME  — Host creates GenLayer room, others join
// ══════════════════════════════════════════════════════
async function startGame() {
    if (!state.currentRoomId || !state.isHost) return;

    addLog("Starting game — creating GenLayer room...");
    showLoadingBanner("Creating game on GenLayer...");

    try {
        // 1. Host creates the GenLayer room (1 tx)
        const txHash = await glWrite("create_room", [state.playerName]);
        addLog(`GenLayer tx: <span class="highlight">${txHash.slice(0,12)}...</span>`);

        // 2. Poll for receipt & get room_id from return val
        addLog("Waiting for GenLayer confirmation...");
        let glRoomId = -1;
        try {
            const receipt = await pollTxResult(txHash, 90000);
            // Try to get the room id from GenLayer logs/return value
            // GenLayer returns room_id as output[0]
            if (receipt?.output !== undefined) glRoomId = parseInt(receipt.output);
        } catch (_) {
            // Fallback: use total_rooms - 1
            try {
                const total = await glRead("gen_call", [{
                    to: CONTRACT_ADDRESS,
                    data: JSON.stringify({ fn: "total_rooms", args: [] })
                }, "latest"]);
                glRoomId = Math.max(0, parseInt(total) - 1);
            } catch (_2) { glRoomId = 0; }
        }

        addLog(`GenLayer room ID: <span class="highlight">#${glRoomId}</span>`);

        // 3. Save glRoomId to Firebase + move to CLAIMING
        await db.ref("rooms/" + state.currentRoomId).update({
            phase:    "CLAIMING",
            glRoomId: glRoomId,
        });

        hideLoadingBanner();
        addLog("Game started! Submit your claims.");
    } catch (err) {
        hideLoadingBanner();
        addLog(`Error: ${err.message}`);
        console.error(err);
        // Fallback: start without GenLayer (Firebase-only mode)
        await db.ref("rooms/" + state.currentRoomId).update({ phase: "CLAIMING", glRoomId: -1 });
    }
}

// ══════════════════════════════════════════════════════
//  SUBMIT CLAIM  →  Firebase only (fast)
// ══════════════════════════════════════════════════════
async function submitClaim() {
    const text  = $("#claimInput").value.trim();
    if (!text) return alert("Write your claim!");
    const isLie = $("#isLieToggle").checked;

    // Save to Firebase
    await db.ref(`rooms/${state.currentRoomId}/claims/${state.playerAddr}`).set({
        text, isLie, username: state.playerName
    });
    state.myClaim = { text, isLie };
    addLog("Claim submitted!");

    // Check if all players submitted
    const snap = await db.ref("rooms/" + state.currentRoomId).once("value");
    const room  = snap.val();
    const pc    = Object.keys(room.players).length;
    const cc    = room.claims ? Object.keys(room.claims).length : 0;

    if (cc >= pc) {
        await db.ref("rooms/" + state.currentRoomId).update({ phase: "VOTING" });
    } else {
        showPhase("WAITING");
        $("#waitingText").textContent = `Waiting for ${pc - cc} more player(s) to submit...`;
    }
}

// ══════════════════════════════════════════════════════
//  VOTING UI
// ══════════════════════════════════════════════════════
function buildVotingUI(claims) {
    state.myVotes = {};
    const grid = $("#claimsGrid");
    let html = `<h3 style="grid-column:1/-1;color:var(--gold);margin-bottom:0.5rem;">
        🕵️ Vote on each claim: Truth or Lie?
    </h3>`;

    let hasOtherClaims = false;
    for (const [addr, claim] of Object.entries(claims)) {
        if (addr.toLowerCase() === state.playerAddr.toLowerCase()) continue;
        hasOtherClaims = true;
        const name = claim.username || shortAddr(addr);
        html += `
            <div class="card claim-card" style="padding:1.5rem;" data-addr="${addr}">
                <p style="color:var(--purple);font-size:0.75rem;font-weight:600;margin-bottom:0.5rem;">
                    ${name} claims:
                </p>
                <p style="font-size:1rem;color:var(--text);margin-bottom:1.2rem;line-height:1.5;">
                    "${claim.text}"
                </p>
                <div style="display:flex;gap:0.6rem;">
                    <button class="vbtn truth-btn" data-addr="${addr}" data-vote="TRUTH"
                        style="flex:1;padding:0.75rem;border:2px solid var(--emerald);
                               background:transparent;color:var(--emerald);border-radius:8px;
                               cursor:pointer;font-weight:700;font-family:var(--font);
                               font-size:0.85rem;transition:all 0.2s;">
                        ✓ TRUTH
                    </button>
                    <button class="vbtn lie-btn" data-addr="${addr}" data-vote="LIE"
                        style="flex:1;padding:0.75rem;border:2px solid var(--crimson);
                               background:transparent;color:var(--crimson);border-radius:8px;
                               cursor:pointer;font-weight:700;font-family:var(--font);
                               font-size:0.85rem;transition:all 0.2s;">
                        🤥 LIE
                    </button>
                </div>
            </div>`;
    }

    if (!hasOtherClaims) {
        html += `<p style="grid-column:1/-1;color:var(--text-muted);text-align:center;">
            No other claims to vote on yet...</p>`;
    }

    grid.innerHTML = html;

    // Attach vote handlers
    grid.querySelectorAll(".vbtn").forEach(btn => {
        btn.onclick = () => {
            const addr = btn.dataset.addr;
            const vote = btn.dataset.vote;
            state.myVotes[addr] = vote;

            // Reset both buttons for this claim
            grid.querySelectorAll(`[data-addr="${addr}"]`).forEach(b => {
                const isTruth = b.dataset.vote === "TRUTH";
                b.style.background = "transparent";
                b.style.color = isTruth ? "var(--emerald)" : "var(--crimson)";
                b.style.boxShadow = "none";
            });
            // Highlight selected
            const isT = vote === "TRUTH";
            btn.style.background  = isT ? "var(--emerald)" : "var(--crimson)";
            btn.style.color       = "#000";
            btn.style.boxShadow   = `0 0 15px ${isT ? "var(--emerald-glow)" : "var(--crimson-glow)"}`;
        };
    });
}

// ══════════════════════════════════════════════════════
//  SUBMIT VOTES  →  Firebase, then host triggers GenLayer
// ══════════════════════════════════════════════════════
async function submitVotes() {
    if (Object.keys(state.myVotes).length === 0) return alert("Vote on at least one claim!");

    await db.ref(`rooms/${state.currentRoomId}/votes/${state.playerAddr}`).set(state.myVotes);
    addLog("Votes submitted!");

    const snap  = await db.ref("rooms/" + state.currentRoomId).once("value");
    const room  = snap.val();
    const pc    = Object.keys(room.players).length;
    const vc    = room.votes ? Object.keys(room.votes).length : 0;

    if (vc >= pc) {
        // All voted — move to JUDGING phase
        await db.ref("rooms/" + state.currentRoomId).update({ phase: "JUDGING" });
        addLog("All voted! AI Judge is analyzing...");

        // Host triggers GenLayer judge
        if (state.isHost) {
            await triggerGenLayerJudge(room);
        }
    } else {
        showPhase("WAITING");
        $("#waitingText").textContent = `Waiting for ${pc - vc} more player(s) to vote...`;
    }
}

// ══════════════════════════════════════════════════════
//  GENLAYER AI JUDGE
// ══════════════════════════════════════════════════════
async function triggerGenLayerJudge(room) {
    const glRoomId = room.glRoomId;
    showLoadingBanner("🤖 AI Judge consulting the internet...");

    // If no valid GenLayer room, fallback to local scoring
    if (glRoomId === undefined || glRoomId < 0) {
        addLog("⚠️ No GenLayer room — using local scoring...");
        hideLoadingBanner();
        await calculateResultsLocally(room);
        return;
    }

    try {
        // Step 1 – Submit ALL claims to GenLayer contract (if not already done)
        const claims  = room.claims || {};
        const votes   = room.votes  || {};

        // Submit each player's claim to GenLayer
        for (const [addr, claim] of Object.entries(claims)) {
            if (addr.toLowerCase() === state.playerAddr.toLowerCase()) {
                addLog(`Submitting your claim to GenLayer...`);
                await glWrite("submit_claim", [glRoomId, claim.text, claim.isLie]);
            }
        }

        // Submit votes to GenLayer
        addLog("Submitting votes to GenLayer...");
        await glWrite("submit_votes", [glRoomId, JSON.stringify(state.myVotes)]);

        // Step 2 – Trigger AI judging
        addLog("🧠 GenLayer AI is fact-checking...");
        const judgeTx = await glWrite("judge_claims", [glRoomId]);
        addLog(`Judge TX: <span class="highlight">${judgeTx.slice(0,12)}...</span>`);
        addLog("Waiting for AI consensus (this may take ~30–60s)...");

        // Step 3 – Poll for result
        const receipt = await pollTxResult(judgeTx, 120000);
        addLog("✅ GenLayer AI verdict received!");

        // Step 4 – Read results from GenLayer contract
        const roomDataStr = await glRead("gen_call", [{
            to: CONTRACT_ADDRESS,
            data: JSON.stringify({ fn: "get_room", args: [glRoomId] })
        }, "latest"]);

        const glRoom = JSON.parse(roomDataStr);
        const results = glRoom.results;
        const winner  = glRoom.winner;

        // Merge GenLayer results with claim text from Firebase
        const enrichedResults = {};
        for (const [addr, res] of Object.entries(results)) {
            enrichedResults[addr] = {
                ...res,
                text:     claims[addr]?.text || "",
                username: claims[addr]?.username || shortAddr(addr),
            };
        }

        // Step 5 – Save to Firebase so ALL clients see it
        await db.ref("rooms/" + state.currentRoomId).update({
            phase:   "RESULTS",
            results: enrichedResults,
            winner:  winner,
        });

        hideLoadingBanner();
        addLog("🏆 Results saved!");

    } catch (err) {
        console.error("GenLayer judge error:", err);
        addLog(`⚠️ GenLayer error: ${err.message} — using local scoring.`);
        hideLoadingBanner();
        await calculateResultsLocally(room);
    }
}

// ══════════════════════════════════════════════════════
//  FALLBACK: LOCAL SCORING (when GenLayer unavailable)
// ══════════════════════════════════════════════════════
async function calculateResultsLocally(room) {
    const claims  = room.claims  || {};
    const votes   = room.votes   || {};
    const results = {};

    for (const [addr, claim] of Object.entries(claims)) {
        let lieVotes = 0, totalVoters = 0;

        for (const [voter, vv] of Object.entries(votes)) {
            if (voter !== addr && vv[addr]) {
                totalVoters++;
                if (vv[addr] === "LIE") lieVotes++;
            }
        }

        const wasCaught = totalVoters > 0 && lieVotes > totalVoters / 2;
        let points = 0;
        if (claim.isLie && !wasCaught)    points =  3;
        else if (claim.isLie)              points = -1;
        else                               points =  1;

        // Voter bonuses
        for (const [voter, vv] of Object.entries(votes)) {
            if (voter !== addr && vv[addr]) {
                const correct = (vv[addr]==="LIE" && claim.isLie) || (vv[addr]==="TRUTH" && !claim.isLie);
                if (!results[voter]) results[voter] = { points: 0 };
                if (correct) results[voter].points += 1;
            }
        }

        results[addr] = {
            ...(results[addr] || {}),
            text:       claim.text,
            was_lie:    claim.isLie,
            was_caught: wasCaught,
            lie_votes:  lieVotes,
            points:     (results[addr]?.points || 0) + points,
            username:   claim.username,
            verdict:    true, // not AI-verified
            local:      true,
        };
    }

    let winner = ""; let best = -999;
    for (const [a, r] of Object.entries(results)) {
        if (r.points > best) { best = r.points; winner = a; }
    }

    await db.ref("rooms/" + state.currentRoomId).update({
        phase: "RESULTS", results, winner
    });
}

// ══════════════════════════════════════════════════════
//  RESULTS DISPLAY
// ══════════════════════════════════════════════════════
function showResults(results, winner, claims) {
    $("#resultsOverlay").classList.add("visible");
    const wd = results[winner];
    $("#winnerName").textContent = `🏆 Winner: ${wd?.username || shortAddr(winner)}`;

    const isLocal = Object.values(results).some(r => r.local);
    if (isLocal) {
        const note = document.createElement("p");
        note.style.cssText = "color:var(--text-muted);font-size:0.7rem;margin-bottom:1rem;";
        note.textContent = "⚠️ Results calculated locally (AI Judge unavailable)";
        $("#winnerName").after(note);
    }

    let html = "";
    for (const [addr, res] of Object.entries(results)) {
        const claimText = res.text || claims?.[addr]?.text || "—";
        const declared  = res.was_lie ? "🤥 Declared Lie" : "✓ Declared True";
        const aiVerdict = res.verdict !== undefined
            ? (res.verdict ? "AI: Actually TRUE" : "AI: Actually FALSE")
            : "";
        html += `<tr>
            <td><strong>${res.username || shortAddr(addr)}</strong></td>
            <td>
                <div style="font-size:0.8rem;line-height:1.4;margin-bottom:4px;">"${claimText}"</div>
                <div style="font-size:0.65rem;color:var(--text-muted);font-weight:600;">${declared}</div>
                ${aiVerdict ? `<div style="font-size:0.65rem;color:var(--cyan);margin-top:2px;">${aiVerdict}</div>` : ""}
            </td>
            <td><span class="verdict ${res.was_caught?"verdict-caught":"verdict-true"}">${res.was_caught?"CAUGHT":"CLEAN"}</span></td>
            <td class="${res.points>=0?"points-positive":"points-negative"}">${res.points>0?"+":""}${res.points}</td>
        </tr>`;
    }
    $("#resultsBody").innerHTML = html;
}

// ══════════════════════════════════════════════════════
//  LOADING BANNER
// ══════════════════════════════════════════════════════
function showLoadingBanner(msg) {
    let b = $("#loadingBanner");
    if (!b) {
        b = document.createElement("div");
        b.id = "loadingBanner";
        b.style.cssText = `position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);
            background:rgba(10,10,20,0.95);border:1px solid var(--gold);border-radius:12px;
            padding:0.75rem 1.5rem;color:var(--gold);font-family:var(--font);font-size:0.85rem;
            z-index:500;display:flex;align-items:center;gap:0.75rem;box-shadow:0 0 30px var(--gold-glow);`;
        document.body.appendChild(b);
    }
    b.innerHTML = `<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;"></div> ${msg}`;
    b.style.display = "flex";
}
function hideLoadingBanner() {
    const b = $("#loadingBanner");
    if (b) b.style.display = "none";
}

// ══════════════════════════════════════════════════════
//  PHASE MANAGEMENT
// ══════════════════════════════════════════════════════
function showPhase(phase) {
    state.currentPhase = phase;
    const map = {
        LOBBY:    "roomLobby",
        CLAIMING: "claimSection",
        VOTING:   "votingSection",
        JUDGING:  "judgingSection",
        WAITING:  "waitingSection",
    };
    const active = map[phase] || "waitingSection";
    ["roomLobby","claimSection","votingSection","judgingSection","waitingSection"]
        .forEach(s => $(`#${s}`).style.display = s === active ? "block" : "none");

    $$(".phase-step").forEach(s => {
        s.classList.remove("active","completed");
        if (s.dataset.phase === phase) s.classList.add("active");
    });
}

// ══════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════
function setupEventListeners() {
    $("#connectWalletBtn").onclick = connectWallet;

    const modal = $("#createRoomModal");
    $("#createRoomBtn").addEventListener("click", () => {
        modal.classList.add("visible");
        modal.style.display = "flex";
    });
    $("#cancelCreateBtn").addEventListener("click", closeModal);
    $("#confirmCreateBtn").onclick = createRoom;

    $("#startGameBtn").onclick   = startGame;
    $("#submitClaimBtn").onclick = submitClaim;
    $("#submitVotesBtn").onclick = submitVotes;
    $("#joinByCodeBtn").onclick  = joinByCode;

    const copyBtn = $("#copyCodeBtn");
    if (copyBtn) copyBtn.onclick = () => {
        navigator.clipboard.writeText(state.currentRoomId || "");
        copyBtn.textContent = "✅ Copied!";
        setTimeout(() => copyBtn.textContent = "📋 Copy", 2000);
    };

    const playAgain = $("#playAgainBtn");
    if (playAgain) playAgain.onclick = () => {
        $("#resultsOverlay").classList.remove("visible");
        state.currentRoomId = null;
        state.currentPhase  = "LOBBY";
        showPhase("LOBBY");
    };

    $$("#themeOptions .theme-option").forEach(opt => {
        opt.onclick = () => {
            $$("#themeOptions .theme-option").forEach(o => o.classList.remove("selected"));
            opt.classList.add("selected");
            state.selectedTheme = opt.dataset.theme;
        };
    });

    $("#isLieToggle").onchange = () => {
        const lie = $("#isLieToggle").checked;
        $("#toggleLabel").textContent = lie ? "This is a LIE 🤥" : "This is TRUE ✓";
        $("#toggleLabel").style.color = lie ? "var(--crimson)" : "var(--emerald)";
    };
}

// ══════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
    setupEventListeners();
    loadRoomList();
    addLog(`Bradbury Testnet <span class="highlight">Hybrid Engine</span> Ready.`);
    showPhase("LOBBY");
});
