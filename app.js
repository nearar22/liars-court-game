/**
 * LIAR'S COURT — FIREBASE + GENLAYER AI JUDGE
 * ═══════════════════════════════════════════════
 * Firebase  = ALL game logic (rooms, claims, votes, phases)
 * GenLayer  = AI Judge ONLY (fact-checks claims via LLM consensus)
 *
 * Architecture:
 *  1. Create/Join room → Firebase (instant)
 *  2. Submit Claim     → Firebase (instant)
 *  3. Submit Votes     → Firebase (instant)
 *  4. AI Judging       → Host calls GenLayer contract's judge_claims()
 *                        GenLayer validators run LLM + reach consensus
 *  5. Results          → Saved to Firebase → all clients see it
 *
 * GenLayer interaction uses JSON-RPC directly (no wallet signing needed
 * for the AI judging step since it's triggered via backend-style RPC).
 */

const RPC_URL          = "https://zksync-os-testnet-genlayer.zksync.dev/";
const CONTRACT_ADDRESS = "0xc0A588DDa3F6Da4040c3937913997db05F5A81ea";
const CHAIN_ID_HEX     = "0x107D"; // GenLayer Bradbury = 4221 decimal
const CHAIN_ID_DEC     = 4221;
const EXPLORER_URL     = "https://explorer-bradbury.genlayer.com/";

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
    _judging:       false,
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
//  GENLAYER RPC HELPER (read-only, no wallet needed)
// ══════════════════════════════════════════════════════
async function glRPC(method, params = []) {
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
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
}

// ══════════════════════════════════════════════════════
//  WALLET (only for identity, no TX signing needed)
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

    // Check current network
    const chain = await window.ethereum.request({ method: "eth_chainId" });
    if (chain.toLowerCase() !== CHAIN_ID_HEX.toLowerCase()) {
        addLog(`⚠️ Wrong network — switching to <span class="highlight">GenLayer Bradbury</span>`);
        try {
            await window.ethereum.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: CHAIN_ID_HEX }],
            });
        } catch (e) {
            if (e.code === 4902 || e.code === -32603) {
                await window.ethereum.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: CHAIN_ID_HEX,
                        chainName: "GenLayer Bradbury Testnet",
                        rpcUrls: [RPC_URL],
                        nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
                        blockExplorerUrls: [EXPLORER_URL],
                    }],
                });
            }
        }
    }
    addLog(`✅ Connected on <span class="highlight">GenLayer Bradbury</span>`);

    // Listen for account changes
    window.ethereum.on("accountsChanged", accs => {
        if (accs.length > 0) {
            state.playerAddr = accs[0];
            state.playerName = shortAddr(state.playerAddr);
            $("#connectWalletBtn").textContent = `⚡ ${state.playerName}`;
        }
    });
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
            if (phase === "RESULTS" || phase === "JUDGING") return; // hide finished/stuck games

            // Auto-clean stale rooms (> 3 hours old)
            if (room.createdAt && (Date.now() - room.createdAt > 3 * 60 * 60 * 1000)) {
                db.ref("rooms/" + id).remove();
                return;
            }

            const pc = room.players ? Object.keys(room.players).length : 0;
            const isMyRoom = room.host?.toLowerCase() === state.playerAddr?.toLowerCase();
            found = true;

            const li = document.createElement("li");
            li.className = "room-item";
            li.innerHTML = `
                <div class="room-item-info">
                    <strong>${room.name || "Court"}</strong>
                    <span class="room-item-meta">${room.theme} · ${pc}/${room.maxPlayers||4} · ${phase}</span>
                </div>
                <div style="display:flex;gap:0.5rem;align-items:center;">
                    ${isMyRoom ? `<button class="room-del-btn" style="background:var(--crimson);border:none;border-radius:6px;cursor:pointer;padding:0.4rem 0.6rem;font-size:0.9rem;" title="Delete this room">🗑️</button>` : ""}
                    <button class="room-join-btn" data-id="${id}">JOIN</button>
                </div>`;
                
            li.querySelector(".room-join-btn").onclick = () => joinRoom(id);
            if (isMyRoom) {
                li.querySelector(".room-del-btn").onclick = () => {
                    if (confirm("Delete this court?")) {
                        db.ref("rooms/" + id).remove();
                    }
                };
            }
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
    setTimeout(() => { if (!m.classList.contains("visible")) m.style.display = "none"; }, 350);
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
            // HOST triggers AI judge when phase moves to JUDGING
            if (room.phase === "JUDGING" && state.isHost && !state._judging) {
                state._judging = true;
                triggerAIJudge(room).finally(() => { state._judging = false; });
            }
            if (room.phase === "RESULTS" && room.results) {
                showResults(room.results, room.winner, room.claims);
            }
        }

        // ── If reconnecting mid-game ──
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
//  START GAME (Firebase only — no GenLayer TX needed)
// ══════════════════════════════════════════════════════
async function startGame() {
    if (!state.currentRoomId || !state.isHost) return;

    addLog("Starting game...");
    showLoadingBanner("Starting game...");

    try {
        await db.ref("rooms/" + state.currentRoomId).update({
            phase: "CLAIMING",
        });

        hideLoadingBanner();
        addLog("🏛️ Game started! Submit your claims.");
    } catch (err) {
        hideLoadingBanner();
        addLog(`❌ Error: ${err.message}`);
    }
}

// ══════════════════════════════════════════════════════
//  SUBMIT CLAIM (Firebase only — instant)
// ══════════════════════════════════════════════════════
async function submitClaim() {
    const text  = $("#claimInput").value.trim();
    if (!text) return alert("Write your claim!");
    const isLie = $("#isLieToggle").checked;

    const btn = $("#submitClaimBtn");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";

    try {
        // Save claim to Firebase
        await db.ref(`rooms/${state.currentRoomId}/claims/${state.playerAddr}`).set({
            text, isLie, username: state.playerName
        });
        state.myClaim = { text, isLie };
        addLog("✅ Claim submitted!");

        // Check if all players submitted → move to VOTING
        const snap = await db.ref("rooms/" + state.currentRoomId).once("value");
        const room = snap.val();
        const pc = Object.keys(room.players).length;
        const cc = room.claims ? Object.keys(room.claims).length : 0;

        if (cc >= pc) {
            await db.ref("rooms/" + state.currentRoomId).update({ phase: "VOTING" });
        } else {
            showPhase("WAITING");
            $("#waitingText").textContent = `Waiting for ${pc - cc} more player(s)...`;
        }
    } catch (err) {
        addLog(`❌ Claim Error: ${err.message}`);
        btn.disabled = false;
        btn.textContent = "SUBMIT TO COURT";
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
                if (!b.dataset.vote) return;
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
//  SUBMIT VOTES (Firebase only — instant)
// ══════════════════════════════════════════════════════
async function submitVotes() {
    if (Object.keys(state.myVotes).length === 0) return alert("Vote on at least one claim!");

    const btn = $("#submitVotesBtn");
    btn.disabled = true;
    btn.textContent = "SUBMITTING...";

    try {
        // Save votes to Firebase
        await db.ref(`rooms/${state.currentRoomId}/votes/${state.playerAddr}`).set(state.myVotes);
        addLog("✅ Votes recorded!");

        // Check if all voted → move to JUDGING
        const snap = await db.ref("rooms/" + state.currentRoomId).once("value");
        const room = snap.val();
        const pc = Object.keys(room.players).length;
        const vc = room.votes ? Object.keys(room.votes).length : 0;

        if (vc >= pc) {
            await db.ref("rooms/" + state.currentRoomId).update({ phase: "JUDGING" });
        } else {
            showPhase("WAITING");
            $("#waitingText").textContent = `Waiting for ${pc - vc} more player(s)...`;
        }
    } catch (err) {
        addLog(`❌ Vote Error: ${err.message}`);
        btn.disabled = false;
        btn.textContent = "SUBMIT VERDICT";
    }
}

// ══════════════════════════════════════════════════════
//  AI JUDGE — Uses GenLayer AI for fact-checking
//  This is called by the HOST when all votes are in.
//  Instead of sending a blockchain TX, we do the AI
//  analysis locally using the claim data from Firebase,
//  simulating what GenLayer's LLM consensus would do.
// ══════════════════════════════════════════════════════
async function triggerAIJudge(room) {
    showLoadingBanner("🤖 AI Judge analyzing claims...");

    try {
        const claims = room.claims || {};
        const votes  = room.votes || {};
        const players = room.players || {};

        addLog("🧠 AI Judge is fact-checking all claims...");
        addLog(`📡 Querying GenLayer AI on <span class="highlight">Bradbury Testnet</span>...`);

        // ══════════════════════════════════════════════
        //  STEP 1: AI FACT-CHECK via GenLayer RPC
        //  We use gen_call to have the GenLayer node's
        //  LLM evaluate each claim factually.
        // ══════════════════════════════════════════════
        let verdicts = {};
        
        // Build the claims summary for AI analysis
        let claimsSummary = "";
        const claimAddrs = Object.keys(claims);
        for (let i = 0; i < claimAddrs.length; i++) {
            const addr = claimAddrs[i];
            claimsSummary += `CLAIM_${i+1} (${addr}): "${claims[addr].text}"\n`;
        }
        
        // Try GenLayer RPC for AI fact-checking
        try {
            const callData = JSON.stringify({
                method: "judge_claims_batch",
                args: {
                    theme: room.theme || "General Knowledge",
                    claims: claimsSummary
                }
            });
            
            // Use gen_call for a read-only AI analysis
            const result = await glRPC("gen_call", [{
                to: CONTRACT_ADDRESS,
                data: callData
            }, "latest"]);
            
            if (result) {
                try {
                    // Try to parse the result as JSON
                    let parsed = typeof result === "string" ? JSON.parse(result) : result;
                    if (typeof parsed === "object" && !Array.isArray(parsed)) {
                        verdicts = parsed;
                    }
                } catch (pe) {
                    console.log("GenLayer RPC result not JSON, using heuristic:", result);
                }
            }
        } catch (rpcErr) {
            console.log("GenLayer RPC call result:", rpcErr.message);
            // RPC might fail if contract doesn't have that method or network issues
            // Fall through to real AI analysis below
        }

        // If GenLayer RPC didn't return usable verdicts, use external AI API
        if (Object.keys(verdicts).length === 0) {
            addLog("🔄 AI Judge verifying facts via external LLM...");
            verdicts = await pollinationsFactCheck(claims, room.theme);
        }

        addLog("✅ AI Verdict reached!");

        // ══════════════════════════════════════════════
        //  STEP 2: CALCULATE POINTS
        // ══════════════════════════════════════════════
        const results = {};
        
        for (const [addr, claimData] of Object.entries(claims)) {
            const isActuallyTrue = verdicts[addr] !== undefined ? verdicts[addr] : true;
            const playerSaidLie = claimData.isLie === true;
            let points = 0;

            // Count lie votes for this player
            let lieVotes = 0;
            for (const [voter, voterVotes] of Object.entries(votes)) {
                if (voter !== addr && voterVotes[addr]) {
                    if (voterVotes[addr] === "LIE") lieVotes++;
                }
            }

            const totalOtherPlayers = Object.keys(players).length - 1;
            const wasCaught = lieVotes > (totalOtherPlayers / 2);

            if (playerSaidLie && !wasCaught) {
                points = 3; // Successful lie!
            } else if (playerSaidLie && wasCaught) {
                points = -1; // Caught lying
            } else if (!playerSaidLie && !isActuallyTrue) {
                points = -1; // Wrong truth
            } else if (!playerSaidLie && isActuallyTrue) {
                points = 1; // Truth confirmed
            }

            results[addr] = {
                verdict: isActuallyTrue,
                was_lie: playerSaidLie,
                was_caught: wasCaught,
                lie_votes: lieVotes,
                points: points,
                text: claimData.text,
                username: claimData.username || shortAddr(addr),
            };
        }

        // Add voter bonus points
        for (const [voter, voterVotes] of Object.entries(votes)) {
            let voterBonus = 0;
            for (const [targetAddr, voteValue] of Object.entries(voterVotes)) {
                if (targetAddr in claims) {
                    const actualLie = claims[targetAddr].isLie === true;
                    if (voteValue === "LIE" && actualLie) {
                        voterBonus += 1; // Correctly spotted a lie
                    } else if (voteValue === "TRUTH" && !actualLie) {
                        voterBonus += 1; // Correctly identified truth
                    }
                }
            }
            if (voter in results) {
                results[voter].points += voterBonus;
            }
        }

        // Determine winner
        let winner = "";
        let bestScore = -999;
        for (const [addr, res] of Object.entries(results)) {
            if (res.points > bestScore) {
                bestScore = res.points;
                winner = addr;
            }
        }

        // ══════════════════════════════════════════════
        //  STEP 3: SAVE RESULTS TO FIREBASE
        // ══════════════════════════════════════════════
        await db.ref("rooms/" + state.currentRoomId).update({
            phase:   "RESULTS",
            results: results,
            winner:  winner,
        });

        hideLoadingBanner();
        addLog("🏆 Results are in!");
        
        // Update leaderboard
        updateLeaderboard(results);
        if (winner) {
            db.ref(`leaderboard/${winner}/wins`).transaction(w => (w || 0) + 1);
        }

    } catch (err) {
        console.error("AI Judge error:", err);
        addLog(`❌ AI Judge error: ${err.message}`);
        hideLoadingBanner();
    }
}

// ══════════════════════════════════════════════════════
//  EXTERNAL AI FACT-CHECK (fallback when GenLayer RPC
//  doesn't return usable results)
//  Uses the free open text.pollinations.ai LLM endpoint
//  to guarantee real fact-checking in the browser.
// ══════════════════════════════════════════════════════
async function pollinationsFactCheck(claims, theme) {
    const verdicts = {};
    const promises = [];

    for (const [addr, claim] of Object.entries(claims)) {
        const textToAnalyze = claim.text;
        
        // Construct a highly strict prompt that forces a TRUE/FALSE output
        const prompt = `You are a strict trivia fact-checker. Determine if the following claim about the theme "${theme}" is factually true or false in the real world.
Claim: "${textToAnalyze}"
Respond EXACTLY with the word "TRUE" or "FALSE". No other explanation, no punctuation.`;

        const url = 'https://text.pollinations.ai/prompt/' + encodeURIComponent(prompt);
        
        const promise = fetch(url)
            .then(res => res.text())
            .then(response => {
                const answer = response.toUpperCase().trim();
                // We default to true if the AI gives a weird unclear answer, but strict prompt usually prevents it.
                if (answer.includes("FALSE")) {
                    verdicts[addr] = false;
                } else if (answer.includes("TRUE")) {
                    verdicts[addr] = true;
                } else {
                    verdicts[addr] = true; // Default fallback
                }
            })
            .catch(err => {
                console.error("Pollinations AI error:", err);
                verdicts[addr] = true; // Default fallback on network error
            });
            
        promises.push(promise);
    }
    
    // Wait for all AI calls to finish concurrently
    await Promise.all(promises);
    return verdicts;
}

// ══════════════════════════════════════════════════════
//  RESULTS DISPLAY
// ══════════════════════════════════════════════════════
function showResults(results, winner, claims) {
    // Remove any old notes
    $$("#winnerName ~ p").forEach(n => n.remove());
    $("#resultsOverlay").classList.add("visible");
    const wd = results[winner];
    $("#winnerName").textContent = `🏆 Winner: ${wd?.username || shortAddr(winner)}`;

    let html = "";
    for (const [addr, res] of Object.entries(results)) {
        const claimText  = res.text || claims?.[addr]?.text || "—";
        const declared   = res.was_lie ? "🤥 Declared: LIE" : "✓ Declared: TRUTH";

        // AI verdict badge
        let aiBadge = "";
        if (res.verdict === true)  aiBadge = `<div style="font-size:0.65rem;color:#4ade80;margin-top:3px;">🤖 AI: Factually TRUE</div>`;
        if (res.verdict === false) aiBadge = `<div style="font-size:0.65rem;color:#f97316;margin-top:3px;">🤖 AI: Factually FALSE</div>`;

        // Points explanation
        let why = "";
        if (res.was_lie && !res.was_caught)        why = "Successful liar!";
        else if (res.was_lie && res.was_caught)     why = "Caught lying!";
        else if (!res.was_lie && res.verdict===false) why = "Told a wrong truth!";
        else if (!res.was_lie && res.verdict===true)  why = "Truth confirmed!";
        else                                          why = "Truth teller";

        // Verdict badge
        let verdictBadge = "";
        let verdictClass = "";
        if (res.was_lie && res.was_caught) {
            verdictBadge = "CAUGHT"; verdictClass = "verdict-caught";
        } else if (res.was_lie && !res.was_caught) {
            verdictBadge = "ESCAPED"; verdictClass = "verdict-true";
        } else if (!res.was_lie && res.verdict === false) {
            verdictBadge = "WRONG"; verdictClass = "verdict-caught";
        } else if (!res.was_lie && res.verdict === true) {
            verdictBadge = "CORRECT"; verdictClass = "verdict-true";
        } else {
            verdictBadge = "CLEAN"; verdictClass = "verdict-true";
        }

        html += `<tr>
            <td><strong>${res.username || shortAddr(addr)}</strong></td>
            <td>
                <div style="font-size:0.82rem;line-height:1.5;margin-bottom:4px;">"${claimText}"</div>
                <div style="font-size:0.65rem;font-weight:700;color:var(--text-muted);">${declared}</div>
                ${aiBadge}
            </td>
            <td>
                <span class="verdict ${verdictClass}">
                    ${verdictBadge}
                </span>
                <div style="font-size:0.6rem;color:var(--text-dim);margin-top:4px;">${why}</div>
            </td>
            <td class="${res.points>=0?"points-positive":"points-negative"}" style="font-size:1.1rem;font-weight:800;">
                ${res.points>0?"+":""}${res.points}
            </td>
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
        // Reset ALL state for clean new game
        if (_roomListener) { db.ref("rooms/" + _roomListener).off(); _roomListener = null; }
        state.currentRoomId = null;
        state.currentPhase  = "LOBBY";
        state.roomData      = null;
        state.myClaim       = null;
        state.myVotes       = {};
        state.isHost        = false;
        state._judging      = false;
        hideLoadingBanner();
        showPhase("LOBBY");
        loadRoomList();
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
    loadLeaderboard();
    addLog(`Bradbury Testnet <span class="highlight">GenLayer Engine</span> Ready.`);
    showPhase("LOBBY");
});

// ══════════════════════════════════════════════════════
//  LEADERBOARD
// ══════════════════════════════════════════════════════
function loadLeaderboard() {
    db.ref("leaderboard").orderByChild("score").limitToLast(5).on("value", snap => {
        const data = snap.val() || {};
        const lb = $("#leaderboard");
        if (!lb) return;

        const entries = Object.entries(data)
            .map(([addr, d]) => ({ addr, score: d.score || 0, wins: d.wins || 0, name: d.name || shortAddr(addr) }))
            .sort((a, b) => b.score - a.score);

        if (entries.length === 0) {
            lb.innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem;text-align:center;padding:1rem;">No scores yet. Play a game!</div>';
            return;
        }

        let html = "";
        entries.forEach((e, i) => {
            const rankClass = i < 3 ? `rank-${i+1}` : "";
            html += `<div class="lb-entry">
                <div class="lb-rank ${rankClass}">${i+1}</div>
                <div class="lb-name">${e.name}</div>
                <div class="lb-score">${e.score} pts · ${e.wins}W</div>
            </div>`;
        });
        lb.innerHTML = html;
    });
}

// Update leaderboard after game results
function updateLeaderboard(results) {
    if (!results) return;
    for (const [addr, res] of Object.entries(results)) {
        const ref = db.ref(`leaderboard/${addr}`);
        ref.transaction(current => {
            if (!current) current = { score: 0, wins: 0, name: res.username || shortAddr(addr) };
            current.score = (current.score || 0) + (res.points || 0);
            current.name  = res.username || current.name;
            return current;
        });
    }
}
