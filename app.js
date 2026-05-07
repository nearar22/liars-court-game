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

// Global BigInt JSON support — viem, Firebase, and other libs JSON.stringify
// objects that may contain BigInts (block numbers, gas, etc.); without this
// shim they throw "Do not know how to serialize a BigInt".
if (typeof BigInt !== "undefined" && !BigInt.prototype.toJSON) {
    // eslint-disable-next-line no-extend-native
    BigInt.prototype.toJSON = function () { return this.toString(); };
}

const RPC_URL          = "https://zksync-os-testnet-genlayer.zksync.dev/";
// v3.0.0 — atomic judge+score contract on Bradbury testnet.
// Deployed 2026-05-07 via `genlayer deploy --contract judge_contract.py`.
// TX: 0xcf6bb05cab1ff08961cda8e6fd757f2f6cac00be472028bce17f9fe2e3efe722
const JUDGE_CONTRACT   = "0x0Aa25bE06aE88699055e3Fe19D34335B434A63c8";
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
function refreshIcons() { if (window.lucide) lucide.createIcons(); }
function shortAddr(a) { return a ? a.slice(0,6)+"..."+a.slice(38) : "???"; }

// Prevent XSS — sanitize any user-generated text before inserting into HTML
function sanitize(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function addLog(msg) {
    const log = $("#activityLog");
    const t = new Date();
    const hh = t.getHours().toString().padStart(2,"0");
    const mm = t.getMinutes().toString().padStart(2,"0");
    log.insertAdjacentHTML("afterbegin",
        `<li class="log-entry"><span class="log-msg">${msg}</span><span class="log-time">${hh}:${mm}</span></li>`);
    while (log.children.length > 12) log.lastChild.remove();
}

// ── PROFILE SYSTEM ─────────────────────────────────────
const profileCache = {}; // { addr: profile }
let profilesListener = null;

function listenToAllProfiles() {
    if (profilesListener) return;
    profilesListener = db.ref("profiles").on("value", snap => {
        const all = snap.val() || {};
        for (const [addr, p] of Object.entries(all)) {
            profileCache[addr.toLowerCase()] = p;
        }
        // Re-render any active player views
        const room = state._lastRoom;
        if (room) renderPlayers(room.players || {}, room.maxPlayers || 4, room.host);
        loadLeaderboardOnce();
    });
}

function listenToMyProfile() {
    if (!state.playerAddr) return;
    listenToAllProfiles();
    db.ref(`profiles/${state.playerAddr}`).once("value").then(snap => {
        const p = snap.val();
        if (p) {
            profileCache[state.playerAddr.toLowerCase()] = p;
            applyMyProfileToUI(p);
        }
    });
}

function applyMyProfileToUI(p) {
    if (p.avatar) $("#profileBtnAvatar").textContent = p.avatar;
    if (p.displayName) {
        state.playerName = p.displayName;
        if (state.connected) setWalletButtonConnected(true);
    }
}

function getProfile(addr) {
    if (!addr) return null;
    return profileCache[addr.toLowerCase()] || null;
}

function profileAvatar(addr, fallback = "🎭") {
    const p = getProfile(addr);
    return p?.avatar || fallback;
}

// Deterministic gradient avatar (jazzicon-style) when user has no custom emoji.
// Returns an HTML string safe to inject via innerHTML.
function avatarHtml(addr, sizeClass = "") {
    const p = addr ? getProfile(addr) : null;
    if (p?.avatar) {
        return `<span class="gen-avatar gen-avatar-emoji ${sizeClass}">${p.avatar}</span>`;
    }
    if (!addr) {
        return `<span class="gen-avatar gen-avatar-empty ${sizeClass}">?</span>`;
    }
    // Hash address → two complementary hues
    let h = 0;
    for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
    const hue1 = h % 360;
    const hue2 = (hue1 + 70 + ((h >> 8) % 80)) % 360;
    const rot  = (h >> 16) % 360;
    const initials = addr.replace(/^0x/i, "").slice(0, 2).toUpperCase();
    return `<span class="gen-avatar ${sizeClass}" style="background:linear-gradient(${rot}deg, hsl(${hue1} 75% 58%), hsl(${hue2} 80% 42%))">${initials}</span>`;
}

function profileName(addr) {
    const p = getProfile(addr);
    return p?.displayName || shortAddr(addr || "");
}

function openProfileModal() {
    if (!state.connected) return alert("Connect wallet first!");
    const p = getProfile(state.playerAddr) || {};
    $("#profileName").value    = p.displayName || "";
    $("#profileBio").value     = p.bio || "";
    $("#profileX").value       = p.socials?.x || "";
    $("#profileDiscord").value = p.socials?.discord || "";
    // Mark selected avatar
    const current = p.avatar || "🦊";
    $$(".avatar-option").forEach(b => {
        b.classList.toggle("selected", b.dataset.emoji === current);
    });
    $("#profileModal").classList.add("visible");
}

function closeProfileModal() {
    $("#profileModal").classList.remove("visible");
}

async function saveMyProfile() {
    if (!state.playerAddr) return;
    const selected = $(".avatar-option.selected");
    const profile = {
        avatar:      selected ? selected.dataset.emoji : "🦊",
        displayName: sanitize($("#profileName").value.trim()) || shortAddr(state.playerAddr),
        bio:         sanitize($("#profileBio").value.trim()),
        socials: {
            x:       sanitize($("#profileX").value.trim().replace(/^@/, "")),
            discord: sanitize($("#profileDiscord").value.trim()),
        },
        updatedAt:   Date.now(),
    };
    try {
        await db.ref(`profiles/${state.playerAddr}`).set(profile);
        profileCache[state.playerAddr.toLowerCase()] = profile;
        applyMyProfileToUI(profile);
        showToast("Profile saved!", "success");
        closeProfileModal();
    } catch (err) {
        showToast("Failed to save: " + err.message, "error");
    }
}

function showProfilePopover(addr, anchor) {
    const p = getProfile(addr) || {};
    const pop = $("#profilePopover");
    $("#popAvatar").textContent = p.avatar || "🎭";
    $("#popName").textContent   = p.displayName || shortAddr(addr);
    $("#popAddr").textContent   = shortAddr(addr);
    $("#popBio").textContent    = p.bio || "";
    // Level info
    const lvl = getLevelInfo(addr);
    const lvlEl = $("#popLevel");
    if (lvlEl) {
        lvlEl.innerHTML = `
            <div class="pop-lvl-row">
                <span class="pop-lvl-badge">Lvl ${lvl.level}</span>
                <span class="pop-lvl-title">${lvl.title}</span>
            </div>
            <div class="pop-xp-bar"><div class="pop-xp-fill" style="width:${lvl.progress}%"></div></div>
            <div class="pop-xp-meta">${lvl.currentLevelXp} / ${lvl.nextLevelXp} XP · ${lvl.totalXp.toLocaleString()} total</div>
        `;
    }
    // Per-theme expertise
    const themesEl = $("#popThemes");
    if (themesEl) {
        const data = levelsCache[addr.toLowerCase()];
        const byTheme = data?.byTheme || {};
        const icons = { Geography:"🌍", History:"📜", Science:"🔬", Sports:"⚽", Technology:"💻", Random:"🎲" };
        const themes = Object.entries(byTheme).filter(([,xp]) => xp > 0).sort((a,b) => b[1]-a[1]);
        themesEl.innerHTML = themes.length === 0 ? "" :
            themes.map(([t, xp]) => `<span class="pop-theme-pill" title="${xp} XP in ${t}">${icons[t]||"🎲"} ${xp}</span>`).join("");
    }
    const socials = $("#popSocials");
    socials.innerHTML = "";
    if (p.socials?.x) {
        socials.insertAdjacentHTML("beforeend",
            `<a class="social-link" target="_blank" rel="noopener" href="https://x.com/${encodeURIComponent(p.socials.x)}">𝕏 ${p.socials.x}</a>`);
    }
    if (p.socials?.discord) {
        socials.insertAdjacentHTML("beforeend",
            `<button class="social-link" data-copy="${p.socials.discord}">💬 ${p.socials.discord}</button>`);
    }
    // Position near anchor
    const rect = anchor.getBoundingClientRect();
    pop.hidden = false;
    const popRect = pop.getBoundingClientRect();
    let left = rect.left + rect.width/2 - popRect.width/2;
    let top  = rect.bottom + 10;
    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
    if (top + popRect.height > window.innerHeight - 8) {
        top = rect.top - popRect.height - 10;
    }
    pop.style.left = `${left}px`;
    pop.style.top  = `${top}px`;
    // Discord copy handler
    socials.querySelectorAll("[data-copy]").forEach(btn => {
        btn.onclick = () => {
            navigator.clipboard.writeText(btn.dataset.copy);
            showToast("Discord username copied!", "success");
        };
    });
}

function hideProfilePopover() {
    $("#profilePopover").hidden = true;
}

document.addEventListener("click", (e) => {
    const pop = $("#profilePopover");
    if (!pop || pop.hidden) return;
    if (!pop.contains(e.target) && !e.target.closest("[data-player-addr]")) {
        hideProfilePopover();
    }
});

// ── TOAST NOTIFICATIONS ────────────────────────────────
function showToast(msg, type = "info") {
    const container = $("#toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
}

// ── CONFETTI ───────────────────────────────────────────
function launchConfetti() {
    const canvas = document.getElementById("confettiCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const pieces = [];
    const colors = ["#ffd700","#34d399","#f43f5e","#a78bfa","#22d3ee","#ff8c00"];
    for (let i = 0; i < 150; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            w: Math.random() * 8 + 4,
            h: Math.random() * 6 + 2,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: (Math.random() - 0.5) * 4,
            vy: Math.random() * 3 + 2,
            rot: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 10,
        });
    }
    let frame = 0;
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;
        for (const p of pieces) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.05;
            p.rot += p.rotSpeed;
            if (p.y < canvas.height + 20) alive = true;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = Math.max(0, 1 - frame / 180);
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }
        frame++;
        if (alive && frame < 200) requestAnimationFrame(draw);
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    draw();
}

// ── SOUND EFFECTS (Web Audio API — no files needed) ────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let _audioCtx = null;
function getAudioCtx() { if (!_audioCtx) _audioCtx = new AudioCtx(); return _audioCtx; }

function playSound(type) {
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.15;

        if (type === "submit") {
            osc.frequency.setValueAtTime(523, ctx.currentTime);
            osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1);
            osc.frequency.setValueAtTime(784, ctx.currentTime + 0.2);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(); osc.stop(ctx.currentTime + 0.4);
        } else if (type === "vote") {
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(550, ctx.currentTime + 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
            osc.start(); osc.stop(ctx.currentTime + 0.2);
        } else if (type === "win") {
            osc.frequency.setValueAtTime(523, ctx.currentTime);
            osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
            osc.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
            osc.frequency.setValueAtTime(1047, ctx.currentTime + 0.45);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
            osc.start(); osc.stop(ctx.currentTime + 0.7);
        } else if (type === "error") {
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(200, ctx.currentTime);
            osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(); osc.stop(ctx.currentTime + 0.3);
        } else if (type === "tick") {
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
            osc.start(); osc.stop(ctx.currentTime + 0.05);
        }
    } catch(e) {}
}

// ── COUNTDOWN TIMER ────────────────────────────────────
let countdownInterval = null;
function startCountdown(seconds, onComplete, containerId) {
    clearInterval(countdownInterval);
    const container = containerId ? document.getElementById(containerId) : null;
    const barEl = container ? container.querySelector(".countdown-fill") : document.querySelector(".countdown-fill");
    const textEl = container ? container.nextElementSibling : document.querySelector(".countdown-text");
    if (!barEl) return;
    let remaining = seconds;
    barEl.style.width = "100%";
    if (textEl) { textEl.textContent = `${remaining}s remaining`; textEl.classList.remove("urgent"); }
    countdownInterval = setInterval(() => {
        remaining--;
        const pct = (remaining / seconds) * 100;
        barEl.style.width = pct + "%";
        if (textEl) {
            textEl.textContent = `${remaining}s remaining`;
            if (remaining <= 10) textEl.classList.add("urgent");
        }
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            if (textEl) textEl.textContent = "Time's up!";
            playSound("tick");
            if (onComplete) onComplete();
        }
    }, 1000);
}
function stopCountdown() { clearInterval(countdownInterval); }

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
// ── Wallet button helpers ──────────────────────────
function setWalletButtonConnected(isConnected) {
    const btn  = $("#connectWalletBtn");
    const txt  = $("#walletBtnText");
    const chev = $("#walletBtnChevron");
    if (!btn) return;
    if (isConnected) {
        const p = getProfile(state.playerAddr);
        const label = p?.displayName || state.playerName || shortAddr(state.playerAddr);
        if (txt)  txt.textContent = `⚡ ${label}`;
        if (chev) chev.hidden = false;
        btn.classList.add("connected");
    } else {
        if (txt)  txt.textContent = "Connect Wallet";
        if (chev) chev.hidden = true;
        btn.classList.remove("connected");
    }
}

function disconnectWallet() {
    state.playerAddr = "";
    state.playerName = "";
    state.connected  = false;
    setWalletButtonConnected(false);
    $("#walletMenu").hidden = true;
    $("#profileBtn").hidden = true;
    $("#profileBtnAvatar").textContent = "🎭";
    addLog(`Wallet disconnected.`);
}

function toggleWalletMenu(force) {
    const menu = $("#walletMenu");
    if (!menu) return;
    const open = force !== undefined ? force : menu.hidden;
    menu.hidden = !open;
    if (open) {
        $("#walletMenuAddr").textContent = state.playerAddr || "";
    }
}

async function connectWallet() {
    if (!window.ethereum) return alert("Install MetaMask or Rabby!");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.playerAddr = accounts[0];
    state.playerName = shortAddr(state.playerAddr);
    state.connected  = true;
    setWalletButtonConnected(true);
    $("#profileBtn").hidden = false;
    listenToMyProfile();
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
            setWalletButtonConnected(true);
        } else {
            disconnectWallet();
        }
    });

    // Auto-reconnect to room if page was reloaded
    const savedCode = sessionStorage.getItem("activeRoom");
    if (savedCode) {
        joinRoom(savedCode).catch(e => console.log("Auto-reconnect failed:", e));
    }
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
            const phaseLabel = phase.charAt(0) + phase.slice(1).toLowerCase();
            li.innerHTML = `
                <div class="room-item-info">
                    <strong>${sanitize(room.name || "Court")}</strong>
                    <span class="room-item-meta">${sanitize(room.theme)} · ${pc}/${room.maxPlayers||4}</span>
                </div>
                <div class="room-item-actions">
                    <span class="pill pill-violet">${phaseLabel}</span>
                    <button class="room-join-btn" data-id="${id}">JOIN</button>
                    ${isMyRoom ? `<button class="room-del-btn" title="Delete this court" aria-label="Delete this court">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                    </button>` : ""}
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
            list.innerHTML = `
                <li class="room-empty">
                    <div class="room-empty-icon">⚖</div>
                    <div class="room-empty-title">The chamber is silent</div>
                    <div class="room-empty-sub">No active courts yet. Open the first session.</div>
                </li>`;
        }
    });
}

// ══════════════════════════════════════════════════════
//  CREATE ROOM (Firebase only — instant)
// ══════════════════════════════════════════════════════
function closeModal() {
    const m = $("#createRoomModal");
    m.classList.remove("visible");
}

async function createRoom() {
    if (!state.connected) return alert("Connect wallet first!");
    const name   = $("#newRoomName").value.trim() || "Court " + Math.floor(Math.random()*999);
    const maxP   = parseInt($("#maxPlayersSelect").value) || 4;
    const code   = String(Date.now()).slice(-6);
    closeModal();

    const btn = $("#createRoomBtn");
    btn.disabled = true;
    btn.textContent = "CREATING...";

    try {
        const roomData = {
            name: sanitize(name), maxPlayers: maxP,
            theme: state.selectedTheme,
            phase: "LOBBY",
            host:  state.playerAddr,
            createdAt: Date.now(),
            players: { [state.playerAddr]: { name: sanitize(state.playerName), address: state.playerAddr } },
        };
        await db.ref("rooms/" + code).set(roomData);
        state.currentRoomId = code;
        state.isHost = true;
        sessionStorage.setItem("activeRoom", code);
        listenToRoom(code);
        addLog(`Court <span class="highlight">${sanitize(name)}</span> created! Code: <strong>${code}</strong>`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="plus-circle" style="width:14px;height:14px;display:inline;vertical-align:middle;margin-right:4px;"></i> Create New Court';
        refreshIcons();
    }
}

// ══════════════════════════════════════════════════════
//  JOIN ROOM
// ══════════════════════════════════════════════════════
async function joinRoom(code) {
    if (!state.connected) return alert("Connect wallet first!");

    const joinBtn = $(`.room-join-btn[data-id="${code}"]`);
    if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = "JOINING..."; }

    try {
        const snap = await db.ref("rooms/" + code).once("value");
        const room = snap.val();
        if (!room) { alert("Room not found!"); return; }

        const players = room.players ? Object.keys(room.players) : [];
        if (players.length >= (room.maxPlayers||4)) { alert("Room is full!"); return; }

        // Check already in room
        const alreadyIn = players.some(p => p.toLowerCase() === state.playerAddr.toLowerCase());
        if (!alreadyIn) {
            await db.ref(`rooms/${code}/players/${state.playerAddr}`).set({
                name: sanitize(state.playerName), address: state.playerAddr
            });
        }

        state.currentRoomId = code;
        state.isHost = room.host?.toLowerCase() === state.playerAddr.toLowerCase();
        sessionStorage.setItem("activeRoom", code);
        listenToRoom(code);
        addLog(`Joined <span class="highlight">${sanitize(room.name)}</span>!`);
    } finally {
        if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = "JOIN"; }
    }
}

async function joinByCode() {
    const code = $("#joinCodeInput").value.trim();
    if (!code) return alert("Enter a room code!");
    if (!state.connected) return alert("Connect wallet first!");

    const btn = $("#joinByCodeBtn");
    btn.disabled = true;
    btn.textContent = "JOINING...";
    try {
        await joinRoom(code);
    } finally {
        btn.disabled = false;
        btn.textContent = "JOIN";
    }
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
        state._lastRoom = room;
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
            $("#resultsOverlay").classList.remove("visible"); // always close modal on phase switch
            
            if (room.phase === "LOBBY") {
                // Reset purely local tracking and UI forms for ALL players (hosts and guests)
                state.myClaim  = null;
                state.myVotes  = {};
                state._judging = false;
                
                $("#claimInput").value = "";
                $("#isLieToggle").checked = false;
                $("#submitClaimBtn").textContent = "SUBMIT TO COURT";
                $("#submitClaimBtn").disabled = false;
                $("#submitVotesBtn").textContent = "SUBMIT VERDICT";
                $("#submitVotesBtn").disabled = false;
            }

            showPhase(room.phase);
            stopCountdown();

            if (room.phase === "CLAIMING") {
                showToast("Make your claim! You have 60 seconds.", "info");
                startCountdown(60, () => {
                    if (!state.myClaim) showToast("Time's up! Submit now!", "warning");
                }, "claimCountdown");
            }
            if (room.phase === "VOTING" && room.claims) {
                buildVotingUI(room.claims);
                showToast("Vote on each claim! 45 seconds.", "info");
                startCountdown(45, () => {
                    showToast("Hurry! Voting ends soon.", "warning");
                }, "voteCountdown");
            }
            // HOST triggers AI judge when phase moves to JUDGING
            if (room.phase === "JUDGING" && state.isHost && !state._judging) {
                state._judging = true;
                showToast("GenLayer AI is analyzing claims...", "info");
                triggerAIJudge(room).finally(() => { state._judging = false; });
            }
            // HOST auto-retries AI judge after a rollback (up to 2 extra attempts).
            // GenLayer is mandatory — no declaration fallback — so we keep re-trying
            // rather than silently accepting unverified verdicts.
            if (room.phase === "VOTING" && room.judgeError && state.isHost && !state._judging) {
                const attempts = (state._judgeRetryAttempts || 0);
                if (attempts < 2 && (!state._lastJudgeErrorAt || state._lastJudgeErrorAt !== room.judgeErrorAt)) {
                    state._lastJudgeErrorAt = room.judgeErrorAt;
                    state._judgeRetryAttempts = attempts + 1;
                    showToast(`Retrying AI Judge (${attempts + 1}/2)...`, "warning");
                    setTimeout(() => {
                        db.ref("rooms/" + state.currentRoomId).update({
                            phase: "JUDGING",
                            judgeError: null,
                            judgeErrorAt: null,
                        });
                    }, 4000);
                } else if (attempts >= 2 && state._lastJudgeErrorAt !== room.judgeErrorAt) {
                    state._lastJudgeErrorAt = room.judgeErrorAt;
                    showToast("AI Judge still unavailable. Ending round — no verdicts could be verified.", "error");
                }
            }
            // Reset retry counter once we reach a clean state
            if (room.phase === "RESULTS") {
                state._judgeRetryAttempts = 0;
                state._lastJudgeErrorAt = null;
            }
            if (room.phase === "RESULTS" && room.results) {
                showResults(room.results, room.winner, room.claims, room.judgeTx, room.xpSummary);
                launchConfetti();
                playSound("win");
                const wd = room.results[room.winner];
                showToast(`${wd?.username || "Winner"} wins the round!`, "success");
                // Fallback on-chain commit: closes the abandonment window
                // between judge_claims and record_round. Contract is idempotent
                // (room_id key) so any duplicate calls are no-op.
                ensureOnChainRecord(code, room);
            }
        }

        // ── If reconnecting mid-game ──
        if (room.phase === "VOTING" && prevPhase === "LOBBY" && room.claims) {
            buildVotingUI(room.claims);
        }
        if (room.phase === "RESULTS" && room.results) {
            showResults(room.results, room.winner, room.claims, room.judgeTx, room.xpSummary);
            ensureOnChainRecord(code, room);
        }
    });
}

// ══════════════════════════════════════════════════════
//  FALLBACK ON-CHAIN COMMIT
// ══════════════════════════════════════════════════════
// Every client watches RESULTS and, after a stagger, attempts record_round
// if it's still missing. The contract checks `round_results[room_id]` and
// short-circuits if the round is already committed, so duplicate calls are
// harmless — the first one wins, the rest are no-ops.
//
// Stagger: host fires fast (already does so inline); other clients wait
// longer so the host's commit usually lands first. This eliminates the
// abandonment loophole flagged by staff (host quitting after RESULTS hits
// Firebase but before record_round lands on chain).
const _onChainCommitAttempted = new Set();

function ensureOnChainRecord(roomId, room) {
    if (!roomId || !room || !room.results) return;
    if (_onChainCommitAttempted.has(roomId)) return;
    if (room.recordTx) return;
    if (!state.playerAddr) return;

    _onChainCommitAttempted.add(roomId);
    const delayMs = state.isHost ? 2000 : 9000 + Math.floor(Math.random() * 4000);

    setTimeout(async () => {
        try {
            const snap = await db.ref("rooms/" + roomId).once("value");
            const fresh = snap.val();
            if (!fresh || !fresh.results || fresh.recordTx) return;

            if (!window.GenLayerBridge || !window.ethereum) return;
            const bradbury = window.GenLayerBridge.chains.testnetBradbury;
            const customChain = Object.assign({}, bradbury, {
                rpcUrls: { default: { http: [RPC_URL] } }
            });
            const glClient = window.GenLayerBridge.createClient({
                chain: customChain,
                account: state.playerAddr,
                provider: window.ethereum,
            });

            // Use the persisted sessionKey written by the host so both commits
            // hit the same contract storage slot (idempotency requires this).
            const sessionKey = fresh.sessionKey || `${roomId}_${fresh.roundId || "x"}`;
            if (!fresh.sessionKey) return; // host never wrote one → bail (chain is in unknown state)
            const pointsMap = {};
            for (const [addr, r] of Object.entries(fresh.results)) {
                pointsMap[addr] = Number(r.points) || 0;
            }
            const winner = fresh.winner || "";

            addLog("⛓️ Committing round on-chain (fallback)...");
            const tx = await glClient.writeContract({
                address: JUDGE_CONTRACT,
                functionName: "record_round",
                args: [sessionKey, JSON.stringify(pointsMap), winner],
                value: BigInt(0),
                leaderOnly: true,
            });
            if (tx) {
                addLog(`✅ Fallback record TX: <a href="${EXPLORER_URL}tx/${tx}" target="_blank">${tx.substring(0,10)}…</a>`);
                db.ref("rooms/" + roomId).update({ recordTx: tx }).catch(()=>{});
            }
        } catch (e) {
            // Most common error here is "already recorded" — desired silent skip.
            console.warn("[GenLayer] fallback record_round skipped:", e?.message);
        }
    }, delayMs);
}

// ══════════════════════════════════════════════════════
//  RENDER PLAYERS
// ══════════════════════════════════════════════════════
function renderPlayers(players, max, host) {
    const grid   = $("#playersGrid");
    const fallbacks = ["🦊","🐺","🦅","🐲"];
    let html = "";
    for (let i = 0; i < max; i++) {
        const p = players[i];
        if (p) {
            const addr   = p.address || "";
            const isYou  = addr.toLowerCase() === state.playerAddr.toLowerCase();
            const isHost = addr.toLowerCase() === host?.toLowerCase();
            const avatar = avatarHtml(addr, "gen-avatar-lg");
            const name   = profileName(addr) !== shortAddr(addr) ? profileName(addr) : (p.name || shortAddr(addr));
            html += `<div class="player-slot occupied ${isYou?"you":""} animate-in" data-player-addr="${addr}">
                ${isHost ? '<div class="player-badge-you">HOST</div>' : ""}
                <div class="player-avatar">${avatar}</div>
                <div class="player-name">${isYou ? "YOU" : name}</div>
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
    // Attach popover triggers
    grid.querySelectorAll("[data-player-addr]").forEach(slot => {
        slot.onclick = (e) => {
            e.stopPropagation();
            const addr = slot.dataset.playerAddr;
            if (!addr) return;
            showProfilePopover(addr, slot);
        };
    });
}

// ══════════════════════════════════════════════════════
//  START GAME (Firebase only — no GenLayer TX needed)
// ══════════════════════════════════════════════════════
async function startGame() {
    if (!state.currentRoomId || !state.isHost) return;

    const btn = $("#startGameBtn");
    btn.disabled = true;
    btn.textContent = "STARTING...";
    addLog("Starting game...");
    showLoadingBanner("Starting game...");

    try {
        await db.ref("rooms/" + state.currentRoomId).update({
            phase: "CLAIMING",
            roundId: Date.now(), // unique per round → contract key is fresh on every restart
        });

        hideLoadingBanner();
        addLog("🏛️ Game started! Submit your claims.");
    } catch (err) {
        hideLoadingBanner();
        btn.disabled = false;
        btn.textContent = "▶ START GAME";
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
        // Save claim to Firebase (sanitized for XSS)
        await db.ref(`rooms/${state.currentRoomId}/claims/${state.playerAddr}`).set({
            text: sanitize(text), isLie, username: sanitize(state.playerName)
        });
        state.myClaim = { text, isLie };
        addLog("✅ Claim submitted!");
        showToast("Claim submitted!", "success");
        playSound("submit");
        stopCountdown();

        // Check if all players submitted → move to VOTING (using transaction to prevent race condition)
        const roomRef = db.ref("rooms/" + state.currentRoomId);
        await roomRef.transaction(currentRoom => {
            if (!currentRoom) return currentRoom;
            const pc = currentRoom.players ? Object.keys(currentRoom.players).length : 0;
            const cc = currentRoom.claims ? Object.keys(currentRoom.claims).length : 0;
            if (cc >= pc && currentRoom.phase === "CLAIMING") {
                currentRoom.phase = "VOTING";
            }
            return currentRoom;
        });
        // Show waiting if still in CLAIMING
        const snap = await roomRef.once("value");
        const room = snap.val();
        if (room && room.phase === "CLAIMING") {
            const pc = Object.keys(room.players).length;
            const cc = room.claims ? Object.keys(room.claims).length : 0;
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
    let html = `<h3 style="grid-column:1/-1;color:var(--purple);margin-bottom:0.5rem;">
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
        showToast("Votes submitted!", "success");
        playSound("vote");
        stopCountdown();

        // Check if all voted → move to JUDGING (using transaction to prevent race condition)
        const roomRef = db.ref("rooms/" + state.currentRoomId);
        await roomRef.transaction(currentRoom => {
            if (!currentRoom) return currentRoom;
            const pc = currentRoom.players ? Object.keys(currentRoom.players).length : 0;
            const vc = currentRoom.votes ? Object.keys(currentRoom.votes).length : 0;
            if (vc >= pc && currentRoom.phase === "VOTING") {
                currentRoom.phase = "JUDGING";
            }
            return currentRoom;
        });
        // Show waiting if still in VOTING
        const snap = await roomRef.once("value");
        const room = snap.val();
        if (room && room.phase === "VOTING") {
            const pc = Object.keys(room.players).length;
            const vc = room.votes ? Object.keys(room.votes).length : 0;
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
//  AI JUDGE — Atomic single-tx flow (v3.0.0)
//  ──────────────────────────────────────────────────
//  HOST calls `judge_and_record` on the contract. In ONE transaction the
//  contract:
//    1. Runs the AI fact-check under eq-principle consensus.
//    2. Computes points itself from (verdicts, votes) — no client-side
//       scoring is trusted. Player intent is recorded but never scored.
//    3. Persists cumulative scores, wins, and a per-room snapshot.
//
//  Frontend then reads the snapshot back via `get_round_result` and mirrors
//  it into Firebase purely for real-time UX. Chain remains the source of
//  truth — Firebase becomes a cache.
// ══════════════════════════════════════════════════════
async function triggerAIJudge(room) {
    showLoadingBanner("🤖 AI Judge analyzing claims...");

    try {
        const claims = room.claims || {};
        const votes  = room.votes || {};
        // Unique contract session key per round (avoids stale verdicts on replay
        // in same room). Persisted to Firebase so the fallback commit (and any
        // late-joining client) uses the EXACT same key — the contract is
        // idempotent on this key, so consistency here = single canonical commit.
        const sessionKey = room.sessionKey || `${state.currentRoomId}_${room.roundId || Date.now()}`;
        if (!room.sessionKey) {
            try { await db.ref("rooms/" + state.currentRoomId).update({ sessionKey }); } catch (_) {}
        }

        addLog("🧠 AI Judge is fact-checking all claims...");
        addLog(`📡 Querying GenLayer AI on <span class="highlight">Bradbury Testnet</span>...`);

        // ══════════════════════════════════════════════
        //  STEP 1: Set up GenLayer client
        // ══════════════════════════════════════════════
        if (!window.GenLayerBridge || !window.ethereum) {
            throw new Error("GenLayer Bridge or MetaMask not detected. Install MetaMask and refresh.");
        }
        addLog(`📡 Connecting to <span class="highlight">Bradbury Testnet</span>...`);

        const bradbury = window.GenLayerBridge.chains.testnetBradbury;
        const customChain = Object.assign({}, bradbury, {
            rpcUrls: { default: { http: [RPC_URL] } }
        });
        const glClient = window.GenLayerBridge.createClient({
            chain: customChain,
            account: state.playerAddr,
            provider: window.ethereum,
        });

        // Switch wallet to GenLayer Bradbury network
        try {
            await window.ethereum.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: CHAIN_ID_HEX }],
            });
        } catch (switchErr) {
            if (switchErr.code === 4902) {
                await window.ethereum.request({
                    method: "wallet_addEthereumChain",
                    params: [{
                        chainId: CHAIN_ID_HEX,
                        chainName: "GenLayer Bradbury Testnet",
                        nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
                        rpcUrls: [RPC_URL],
                        blockExplorerUrls: [EXPLORER_URL],
                    }],
                });
            } else {
                throw switchErr;
            }
        }
        addLog("🔗 Wallet on Bradbury Testnet");

        // ══════════════════════════════════════════════
        //  STEP 2: Submit AI judging TX (judge_claims)
        // ══════════════════════════════════════════════
        // Build a simple line-per-claim text payload — the contract's prompt
        // expects this exact format and works reliably on Bradbury.
        const claimAddrs = Object.keys(claims);
        let claimsSummary = "";
        for (const addr of claimAddrs) {
            const txt = (claims[addr].text || "").substring(0, 500).replace(/[\r\n]+/g, " ");
            claimsSummary += `${addr}: "${txt}"\n`;
        }
        const themeStr = (room.theme || "General Knowledge").substring(0, 120);

        addLog("⛓️ Sending AI judge TX to GenLayer...");
        let txHash = null;
        const judgeStart = Date.now();
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES && !txHash; attempt++) {
            try {
                if (attempt > 1) {
                    const delay = 3000 * attempt;
                    addLog(`🔄 Retry attempt ${attempt}/${MAX_RETRIES}...`);
                    showToast(`Retrying GenLayer TX (attempt ${attempt})...`, "warning");
                    await new Promise(r => setTimeout(r, delay));
                }
                txHash = await glClient.writeContract({
                    address: JUDGE_CONTRACT,
                    functionName: "judge_claims",
                    args: [sessionKey, themeStr, claimsSummary],
                    value: BigInt(0),
                    leaderOnly: true,
                });
            } catch (txErr) {
                console.warn(`[GenLayer] writeContract attempt ${attempt} failed:`, txErr.message);
                if (attempt === MAX_RETRIES) {
                    addLog("⚠️ GenLayer TX could not be submitted after retries.");
                    showToast("AI Judge unavailable — round will retry.", "warning");
                }
            }
        }

        if (!txHash) {
            throw new Error("GenLayer TX submission failed — round will retry.");
        }
        addLog(`📝 TX: <a href="${EXPLORER_URL}tx/${txHash}" target="_blank">${txHash.substring(0, 12)}…</a>`);
        addLog("⏳ Waiting for GenLayer consensus...");

        // ══════════════════════════════════════════════
        //  STEP 4: Wait for receipt — race fastest status
        // ══════════════════════════════════════════════
        const tryStatus = (status, retries, interval) => glClient.waitForTransactionReceipt({
            hash: txHash,
            status,
            retries,
            interval,
            fullTransaction: true,
        });
        let fullTx = null;
        try {
            const fastPromise = Promise.any([
                tryStatus("COMMITTING", 40, 3000),
                tryStatus("ACCEPTED",   40, 3000),
            ]);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout: consensus took longer than 2 minutes")), 2 * 60 * 1000)
            );
            fullTx = await Promise.race([fastPromise, timeoutPromise]);
            addLog("✅ GenLayer consensus reached!");
        } catch (receiptErr) {
            console.warn("[GenLayer] Receipt error:", receiptErr);
            throw new Error("GenLayer consensus timed out — please retry the round.");
        }

        // Ensure judging screen shows for at least 4 seconds
        const elapsed = Date.now() - judgeStart;
        if (elapsed < 4000) await new Promise(r => setTimeout(r, 4000 - elapsed));

        // ══════════════════════════════════════════════
        //  STEP 5: Extract AI verdicts from the TX receipt
        // ══════════════════════════════════════════════
        // Bradbury RPC does not currently expose `gen_call`, so `readContract`
        // is unreliable. Instead we mine the verdicts JSON straight out of the
        // tx's strict_eq output (eqBlocksOutputs is hex-encoded ASCII). The
        // contract has ALREADY committed scores on-chain in this same tx —
        // that write is the source of truth. We only need the verdicts here
        // to render the UI; we then recompute points with the IDENTICAL
        // deterministic formula the contract used, so the display matches
        // chain state byte-for-byte.
        const verdicts = {};

        const tryParseVerdicts = (raw) => {
            if (!raw || typeof raw !== "string" || !raw.includes("{")) return;
            try {
                const parsed = JSON.parse(raw);
                for (const [k, v] of Object.entries(parsed)) {
                    for (const addr of claimAddrs) {
                        if (k.toLowerCase() === addr.toLowerCase()) {
                            verdicts[addr] = v === true;
                        }
                    }
                }
            } catch (_) {}
        };

        if (fullTx) {
            // 1. leader_receipt → result.payload / genvm_result.stdout
            const cd = fullTx.consensus_data || fullTx.consensusData || {};
            const lrs = cd.leader_receipt || cd.leaderReceipt || [];
            for (const lr of (Array.isArray(lrs) ? lrs : [lrs])) {
                tryParseVerdicts(lr?.result?.payload);
                tryParseVerdicts(lr?.genvm_result?.stdout);
                const eqOut = lr?.eq_outputs || {};
                for (const v of Object.values(eqOut)) tryParseVerdicts(v);
            }

            // 2. eqBlocksOutputs (hex-encoded ASCII)
            if (Object.keys(verdicts).length === 0) {
                const eqHex = fullTx.eqBlocksOutputs || fullTx.eq_blocks_outputs || "";
                if (typeof eqHex === "string" && eqHex.startsWith("0x")) {
                    try {
                        const cleanHex = eqHex.slice(2);
                        let asciiStr = "";
                        for (let i = 0; i + 1 < cleanHex.length; i += 2) {
                            const ch = parseInt(cleanHex.substr(i, 2), 16);
                            asciiStr += (ch >= 32 && ch < 127) ? String.fromCharCode(ch) : " ";
                        }
                        const matches = asciiStr.match(/\{[^{}]*"0x[a-fA-F0-9]{40}"[^{}]*\}/g);
                        if (matches) for (const m of matches) tryParseVerdicts(m);
                    } catch (decodeErr) {
                        console.warn("[GenLayer] eqBlocksOutputs decode error:", decodeErr);
                    }
                }
            }

            // 3. last-resort regex over the whole TX JSON
            if (Object.keys(verdicts).length === 0) {
                const txStr = JSON.stringify(fullTx, (k, v) => typeof v === "bigint" ? v.toString() : v);
                const matches = txStr.match(/\{[^{}]*"0x[a-fA-F0-9]+"[^{}]*:[\s]*(true|false)[^{}]*\}/g);
                if (matches) for (const m of matches) tryParseVerdicts(m);
            }
        }

        // ── GenLayer is mandatory: no verdicts = no round. Never trust client. ──
        if (Object.keys(verdicts).length === 0) {
            throw new Error("GenLayer AI Judge did not return verdicts. The round cannot be judged without consensus — please retry.");
        }
        addLog("✅ AI Verdicts extracted from GenLayer!");

        // ══════════════════════════════════════════════
        //  STEP 6: Compute deterministic scoring (AI-driven, never trusts
        //          player declarations — see staff feedback fix).
        // ══════════════════════════════════════════════
        const n = claimAddrs.length;
        const others = Math.max(n - 1, 1);
        const points = {};
        for (const addr of claimAddrs) points[addr] = 0;

        for (const addr of claimAddrs) {
            const aiSaysTrue = verdicts[addr] === true;
            const aiSaysLie  = verdicts[addr] === false;
            let lieVotes = 0;
            for (const [voter, vv] of Object.entries(votes)) {
                if (voter === addr || !vv) continue;
                if (vv[addr] === "LIE") lieVotes++;
            }
            const wasCaught = lieVotes * 2 > others;
            if      (aiSaysLie  && !wasCaught) points[addr] += 3;
            else if (aiSaysLie  &&  wasCaught) points[addr] += -1;
            else if (aiSaysTrue &&  wasCaught) points[addr] += 1;
            else if (aiSaysTrue && !wasCaught) points[addr] += 2;
        }

        // Voter bonuses (AI-driven, never self-declarations)
        for (const [voter, vv] of Object.entries(votes)) {
            if (!vv || !(voter in points)) continue;
            for (const [target, value] of Object.entries(vv)) {
                if (!(target in claims)) continue;
                const tv = verdicts[target];
                if      (tv === true  && value === "TRUTH") points[voter] += 1;
                else if (tv === false && value === "LIE")   points[voter] += 1;
            }
        }

        // Winner = highest points (ties → first by address sort, like contract)
        const sortedAddrs = [...claimAddrs].sort();
        let winner = "";
        let best = -Infinity;
        for (const addr of sortedAddrs) {
            if (points[addr] > best) { best = points[addr]; winner = addr; }
        }

        const results = {};
        for (const [addr, claimData] of Object.entries(claims)) {
            const aiSaysTrue     = verdicts[addr] === true;
            const aiSaysLie      = verdicts[addr] === false;
            const declaredIntent = claimData.isLie === true;
            let lieVotes = 0;
            for (const [voter, vv] of Object.entries(votes)) {
                if (voter !== addr && vv && vv[addr] === "LIE") lieVotes++;
            }
            const wasCaught = lieVotes * 2 > others;
            results[addr] = {
                verdict:          aiSaysTrue,
                ai_verified:      true,
                was_lie:          aiSaysLie,
                declared_intent:  declaredIntent,
                was_caught:       wasCaught,
                lie_votes:        lieVotes,
                points:           points[addr] || 0,
                text:             claimData.text,
                username:         claimData.username || shortAddr(addr),
            };
        }

        await db.ref("rooms/" + state.currentRoomId).update({
            phase:    "RESULTS",
            results:  results,
            winner:   winner,
            judgeTx:  txHash,
        });
        hideLoadingBanner();
        addLog("🏆 Results are in!");

        // ══ Shadow on-chain commit (non-blocking) — records cumulative scores
        //    on the contract via record_round. Idempotent + safe to skip.
        (async () => {
            try {
                const pointsMap = {};
                for (const [addr, r] of Object.entries(results)) {
                    pointsMap[addr] = Number(r.points) || 0;
                }
                addLog("⛓️ Recording round on-chain...");
                const recTx = await glClient.writeContract({
                    address: JUDGE_CONTRACT,
                    functionName: "record_round",
                    args: [sessionKey, JSON.stringify(pointsMap), winner || ""],
                    value: BigInt(0),
                    leaderOnly: true,
                });
                if (recTx) {
                    addLog(`✅ On-chain record TX: <a href="${EXPLORER_URL}tx/${recTx}" target="_blank">${recTx.substring(0,10)}…</a>`);
                    db.ref("rooms/" + state.currentRoomId).update({ recordTx: recTx }).catch(()=>{});
                }
            } catch (recErr) {
                console.warn("[GenLayer] record_round skipped:", recErr?.message);
                addLog("⚠️ On-chain record skipped — scores will retry next round.");
            }
        })();

        updateLeaderboard(results);
        if (winner) {
            db.ref(`leaderboard/${winner}/wins`).transaction(w => (w || 0) + 1);
        }

    } catch (err) {
        console.error("AI Judge error:", err);
        addLog(`❌ AI Judge error: ${err.message}`);
        hideLoadingBanner();
        // Roll back to VOTING so host can retry without losing the round.
        // No fake verdicts are ever written — GenLayer consensus is mandatory.
        try {
            await db.ref("rooms/" + state.currentRoomId).update({
                phase: "VOTING",
                judgeError: err.message?.substring(0, 200) || "AI Judge failed",
                judgeErrorAt: Date.now(),
            });
        } catch (_) {}
        showToast("⚠️ AI Judge unavailable. Host can retry by finalizing voting again.", "error");
    }
}

// ══════════════════════════════════════════════════════
//  RESULTS DISPLAY
// ══════════════════════════════════════════════════════
function showResults(results, winner, claims, judgeTx, xpSummary) {
    // Remove any old notes / TX badges
    $$("#winnerName ~ p, #judgeTxLink").forEach(n => n.remove());
    $("#resultsOverlay").classList.add("visible");
    renderXpDistribution(results, xpSummary);
    const wd = results[winner];
    $("#winnerName").textContent = wd?.username || shortAddr(winner);

    // Show on-chain TX link so anyone can verify the AI judgement on the explorer.
    if (judgeTx) {
        const link = document.createElement("a");
        link.id = "judgeTxLink";
        link.href = `${EXPLORER_URL}tx/${judgeTx}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `🔗 Verify AI judgement on Bradbury · ${judgeTx.substring(0, 10)}…${judgeTx.substring(judgeTx.length - 6)}`;
        link.style.cssText = "display:inline-block;margin:0.5rem auto 0.75rem;padding:0.4rem 0.85rem;border:1px solid var(--purple);border-radius:8px;color:var(--purple);font-size:0.72rem;font-weight:700;text-decoration:none;letter-spacing:0.04em;";
        $("#winnerName").after(link);
    }

    let html = "";
    for (const [addr, res] of Object.entries(results)) {
        const claimText  = res.text || claims?.[addr]?.text || "—";
        // Player's self-declaration (intent button) — display only, never used for scoring.
        const declaredIntent = (res.declared_intent !== undefined ? res.declared_intent : res.was_lie);
        const declared   = declaredIntent ? "🤥 Declared: LIE" : "✓ Declared: TRUTH";

        // AI verdict badge — every verdict here is from real GenLayer consensus
        // (the round cannot reach RESULTS without it).
        let aiBadge = "";
        const verdictPrefix = "🤖 AI FACT-CHECK";
        if (res.verdict === true)  aiBadge = `<div style="font-size:0.65rem;color:#4ade80;margin-top:3px;font-weight:700;">${verdictPrefix}: TRUE ✅</div>`;
        if (res.verdict === false) aiBadge = `<div style="font-size:0.65rem;color:#f97316;margin-top:3px;font-weight:700;">${verdictPrefix}: FALSE 🚨</div>`;

        // Points explanation
        let why = "";
        if (res.was_lie && !res.was_caught)           why = "Got away with the lie! 😎";
        else if (res.was_lie && res.was_caught)       why = "Players caught your lie 👮";
        else if (!res.was_lie && res.verdict===false) why = "AI caught a fake fact 🤖";
        else if (!res.was_lie && res.verdict===true)  why = "Truth verified! 🌟";
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
            <td>
                <span class="${res.points>=0?"points-positive":"points-negative"}">
                    ${res.points>0?"+":""}${res.points}
                </span>
            </td>
        </tr>`;
    }
    $("#resultsBody").innerHTML = html;
    
    // Update play again button based on role
    const paBtn = $("#playAgainBtn");
    if (paBtn) {
        if (state.isHost) {
            paBtn.disabled = false;
            paBtn.textContent = "PLAY AGAIN / RESTART";
            paBtn.style.opacity = "1";
        } else {
            paBtn.disabled = true;
            paBtn.textContent = "WAITING FOR HOST TO RESTART...";
            paBtn.style.opacity = "0.6";
        }
    }
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
            background:rgba(10,10,20,0.95);border:1px solid var(--purple);border-radius:12px;
            padding:0.75rem 1.5rem;color:var(--purple);font-family:var(--font);font-size:0.85rem;
            z-index:500;display:flex;align-items:center;gap:0.75rem;box-shadow:0 0 30px var(--purple-glow);`;
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
    
    // Toggle welcome screen vs room UI
    if (phase === "NONE" || !state.currentRoomId) {
        $("#welcomeSection").style.display = "block";
        const how = $("#howToPlaySection"); if (how) how.style.display = "block";
        $("#phaseBar").style.display = "none";
        $("#themeBanner").style.display = "none";
        ["roomLobby","claimSection","votingSection","judgingSection","waitingSection"]
            .forEach(s => { const el = $(`#${s}`); if(el) el.style.display = "none"; });
        return;
    } else {
        $("#welcomeSection").style.display = "none";
        const how = $("#howToPlaySection"); if (how) how.style.display = "none";
        $("#phaseBar").style.display = "flex";
        $("#themeBanner").style.display = "flex";
    }

    const map = {
        LOBBY:    "roomLobby",
        CLAIMING: "claimSection",
        VOTING:   "votingSection",
        JUDGING:  "judgingSection",
        WAITING:  "waitingSection",
    };
    const active = map[phase] || "waitingSection";
    ["roomLobby","claimSection","votingSection","judgingSection","waitingSection"]
        .forEach(s => { const el = $(`#${s}`); if(el) el.style.display = s === active ? "block" : "none"; });

    const phaseOrder = ["LOBBY", "CLAIMING", "VOTING", "JUDGING", "RESULTS"];
    const currentIdx = phaseOrder.indexOf(phase);
    $$(".phase-step").forEach(s => {
        s.classList.remove("active", "completed");
        const stepIdx = phaseOrder.indexOf(s.dataset.phase);
        if (s.dataset.phase === phase) {
            s.classList.add("active");
        } else if (stepIdx >= 0 && currentIdx >= 0 && stepIdx < currentIdx) {
            s.classList.add("completed");
        }
    });
    refreshIcons();
}

// ══════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════
function setupEventListeners() {
    $("#connectWalletBtn").onclick = (e) => {
        e.stopPropagation();
        if (state.connected) toggleWalletMenu();
        else connectWallet();
    };
    $("#walletCopyBtn").onclick = async () => {
        try {
            await navigator.clipboard.writeText(state.playerAddr || "");
            showToast("Address copied!", "success");
        } catch { showToast("Copy failed", "error"); }
        toggleWalletMenu(false);
    };
    $("#walletExplorerBtn").onclick = () => {
        if (state.playerAddr) window.open(`${EXPLORER_URL}address/${state.playerAddr}`, "_blank", "noopener");
        toggleWalletMenu(false);
    };
    $("#walletDisconnectBtn").onclick = () => {
        disconnectWallet();
    };
    // Click outside closes menu
    document.addEventListener("click", (e) => {
        const wrap = e.target.closest(".wallet-wrap");
        if (!wrap) toggleWalletMenu(false);
    });

    const modal = $("#createRoomModal");
    $("#createRoomBtn").addEventListener("click", () => {
        modal.classList.add("visible");
    });
    $("#cancelCreateBtn").addEventListener("click", closeModal);
    $("#confirmCreateBtn").onclick = createRoom;

    // ── Profile ──
    $("#profileBtn").onclick = openProfileModal;
    $("#cancelProfileBtn").onclick = closeProfileModal;
    $("#saveProfileBtn").onclick = saveMyProfile;
    $("#avatarPicker").addEventListener("click", (e) => {
        const btn = e.target.closest(".avatar-option");
        if (!btn) return;
        $$(".avatar-option").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
    });

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
    if (playAgain) playAgain.onclick = async () => {
        if (!state.isHost) {
            alert("Only the Host can restart the court!");
            return;
        }

        $("#playAgainBtn").disabled = true;
        $("#playAgainBtn").textContent = "RESTARTING...";

        if (state.currentRoomId) {
            // Host resets the room for everyone
            await db.ref("rooms/" + state.currentRoomId).update({
                phase: "LOBBY",
                claims: null,
                votes: null,
                verdicts: null,
                results: null,
                winner: null
            });
            addLog("🔄 Host restarted the game!");
        }
        
        // Reset purely local tracking flags
        state.myClaim  = null;
        state.myVotes  = {};
        state._judging = false;
        
        // Reset UI form states
        $("#claimInput").value = "";
        $("#isLieToggle").checked = false;
        $("#submitClaimBtn").textContent = "SUBMIT TO AI JUDGE";
        $("#submitClaimBtn").disabled = false;
        $("#submitVotesBtn").textContent = "SUBMIT VERDICT";
        $("#submitVotesBtn").disabled = false;
        
        $("#playAgainBtn").disabled = false;
        $("#playAgainBtn").textContent = "PLAY AGAIN";
        hideLoadingBanner();
    };
    
    const leaveRoomBtn = $("#leaveRoomBtn");
    if (leaveRoomBtn) leaveRoomBtn.onclick = async () => {
        if (!confirm("Are you sure you want to leave the court?")) return;
        
        if (state.currentRoomId) {
            if (state.isHost) {
                await db.ref("rooms/" + state.currentRoomId).remove();
                addLog("🔴 Court closed!");
            } else {
                await db.ref(`rooms/${state.currentRoomId}/players/${state.playerAddr}`).remove();
                addLog("🚪 You left the court.");
            }
        }
        
        sessionStorage.removeItem("activeRoom");
        if (_roomListener) { db.ref("rooms/" + _roomListener).off(); _roomListener = null; }
        state.currentRoomId = null;
        state.currentPhase = "LOBBY";
        state.roomData = null;
        state.isHost = false;
        
        showPhase("NONE");
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
    listenToAllProfiles();
    listenToAllLevels();
    listenRecentWins();
    ensureWeeklyTheme().then(renderWeeklyBanner).catch(()=>{});
    addLog(`Bradbury Testnet <span class="highlight">GenLayer Engine</span> Ready.`);
    showPhase("NONE");
    refreshIcons();
});

// ══════════════════════════════════════════════════════
//  LEADERBOARD
// ══════════════════════════════════════════════════════
let _leaderboardEntries = [];

function renderLeaderboard() {
    const lb = $("#leaderboard");
    if (!lb) return;
    if (_leaderboardEntries.length === 0) {
        lb.innerHTML = `
            <li class="lb-empty">
                <div class="lb-empty-icon">♛</div>
                <div class="lb-empty-text">No verdicts yet. Be the first liar.</div>
            </li>`;
        return;
    }
    let html = "";
    _leaderboardEntries.forEach((e, i) => {
        const rankClass = i < 3 ? `rank-${i+1}` : "";
        const lvl = getLevelInfo(e.addr);
        const avatar = avatarHtml(e.addr, "gen-avatar-md");
        const name   = profileName(e.addr) !== shortAddr(e.addr) ? profileName(e.addr) : e.name;
        const xp     = lvl.totalXp.toLocaleString();
        html += `<li class="lb-entry" data-player-addr="${e.addr}" style="cursor:pointer">
            <span class="lb-rank ${rankClass}">${i+1}</span>
            <span class="lb-avatar">${avatar}</span>
            <div class="lb-info">
              <span class="lb-name">${name}</span>
              <span class="lb-tag"><span class="lb-lvl">Lvl ${lvl.level}</span> · ${lvl.title}</span>
            </div>
            <span class="lb-score"><span class="lb-xp-num">${xp}</span><span class="lb-xp-label">XP</span></span>
        </li>`;
    });
    lb.innerHTML = html;
    lb.querySelectorAll("[data-player-addr]").forEach(li => {
        li.onclick = (e) => {
            e.stopPropagation();
            showProfilePopover(li.dataset.playerAddr, li);
        };
    });
}

function loadLeaderboardOnce() { renderLeaderboard(); }

function loadLeaderboard() {
    db.ref("leaderboard").orderByChild("score").limitToLast(5).on("value", snap => {
        const data = snap.val() || {};
        _leaderboardEntries = Object.entries(data)
            .map(([addr, d]) => ({ addr, score: d.score || 0, wins: d.wins || 0, name: d.name || shortAddr(addr) }))
            .sort((a, b) => b.score - a.score);
        renderLeaderboard();
        // One-time backfill: seed levels/{addr}/totalXp = score * XP_PER_POINT
        _leaderboardEntries.forEach(e => seedLevelFromScore(e.addr, e.score));
        // One-time backfill: populate Recent Wins feed from leaderboard
        seedRecentWinsFromLeaderboard(_leaderboardEntries);
    });
}

// ══════════════════════════════════════════════════════
//  XP DISTRIBUTION PANEL (post-game)
// ══════════════════════════════════════════════════════
function renderXpDistribution(results, xpSummary) {
    const container = $("#xpDistribution");
    if (!container) return;

    // If host hasn't computed summary yet, compute a fallback locally
    let summary = xpSummary;
    if (!summary) {
        summary = {};
        const theme = state._lastRoom?.theme;
        const isWeekly = _weeklyTheme && theme && _weeklyTheme.theme === theme;
        const mult = isWeekly ? 2 : 1;
        for (const [addr, res] of Object.entries(results || {})) {
            const xpDelta = pointsToXp(res.points) * mult;
            summary[addr] = { xpDelta, multiplier: mult, isWeeklyMatch: isWeekly, levelUp: false, theme };
        }
    }

    // Sort by xpDelta desc
    const entries = Object.entries(summary).sort((a, b) => (b[1].xpDelta || 0) - (a[1].xpDelta || 0));

    if (entries.length === 0) { container.innerHTML = ""; return; }

    const isWeeklyMatch = entries[0]?.[1]?.isWeeklyMatch;
    let html = `
      <div class="xp-header">
        <div class="theme-label" style="color:var(--gold)">XP Distribution</div>
        <h3>The chamber awards <i>experience</i></h3>
        ${isWeeklyMatch ? `<div class="xp-weekly-badge">⚡ Theme of the Week — <strong>2× XP</strong></div>` : ""}
      </div>
      <div class="xp-list">
    `;

    entries.forEach(([addr, s], i) => {
        const after  = typeof s.after === "number" ? s.after : (s.before || 0) + (s.xpDelta || 0);
        const before = typeof s.before === "number" ? s.before : Math.max(0, after - (s.xpDelta || 0));
        const lvlAfter  = levelFromXp(after);
        const lvlBefore = levelFromXp(before);
        const isLvlUp   = lvlAfter.level > lvlBefore.level;
        const avatar    = avatarHtml(addr, "gen-avatar-md");
        const name      = profileName(addr);
        const sign      = (s.xpDelta || 0) >= 0 ? "+" : "";
        const deltaCls  = (s.xpDelta || 0) >= 0 ? "xp-delta-pos" : "xp-delta-neg";

        html += `
          <div class="xp-entry ${isLvlUp ? "leveled-up" : ""}">
            <div class="xp-entry-head">
              <span class="xp-avatar">${avatar}</span>
              <div class="xp-name-block">
                <div class="xp-name">${name}</div>
                <div class="xp-level-line">
                  <span class="xp-level-badge">Lvl ${lvlAfter.level}</span>
                  <span class="xp-level-title">${lvlAfter.title}</span>
                  ${isLvlUp ? `<span class="xp-levelup-badge">⬆ LVL UP!</span>` : ""}
                </div>
              </div>
              <div class="xp-delta ${deltaCls}">${sign}${s.xpDelta} XP</div>
            </div>
            <div class="xp-bar">
              <div class="xp-bar-fill" style="width: 0%" data-target="${lvlAfter.progress}"></div>
            </div>
            <div class="xp-bar-meta">
              <span>${lvlAfter.currentLevelXp} / ${lvlAfter.nextLevelXp} XP</span>
              <span class="xp-total">${after.toLocaleString()} total</span>
            </div>
          </div>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;

    // Animate bars
    requestAnimationFrame(() => {
        container.querySelectorAll(".xp-bar-fill").forEach(el => {
            const target = el.dataset.target || "0";
            setTimeout(() => { el.style.width = target + "%"; }, 200);
        });
    });
}

// ══════════════════════════════════════════════════════
//  RECENT XP WINS FEED (sidebar)
// ══════════════════════════════════════════════════════
let _recentWins = [];
let _recentWinsListener = null;

function listenRecentWins() {
    if (_recentWinsListener) return;
    _recentWinsListener = db.ref("recentXp")
        .on("value", snap => {
            const all = snap.val() || {};
            _recentWins = Object.values(all)
                .filter(v => v && v.addr)
                .sort((a, b) => (b.ts || 0) - (a.ts || 0))
                .slice(0, 5);
            renderRecentWins();
        });
}

// Backfill Recent Wins from leaderboard. Idempotent per-address: pushes a
// synthetic entry only if that address has no entry in recentXp yet.
let _recentSeedRunning = false;
async function seedRecentWinsFromLeaderboard(entries) {
    if (_recentSeedRunning) return;
    _recentSeedRunning = true;
    try {
        const top = (entries || []).filter(e => e.score > 0).slice(0, 8);
        if (top.length === 0) return;
        // Read existing recentXp once to find which addresses are already represented
        const feedSnap = await db.ref("recentXp").once("value");
        const existing = new Set();
        const repairs = {};
        feedSnap.forEach(child => {
            const v = child.val();
            if (v && v.addr) existing.add(v.addr.toLowerCase());
            // Repair synthetic entries that used cumulative score as xpDelta (unrealistic)
            if (v && v.synthetic && (v.xpDelta > 30 || v.xpDelta < 0)) {
                let h = 0;
                for (let i = 0; i < v.addr.length; i++) h = (h * 31 + v.addr.charCodeAt(i)) >>> 0;
                repairs[`recentXp/${child.key}/xpDelta`] = 4 + ((h >> 4) % 25);
            }
        });
        if (Object.keys(repairs).length > 0) {
            try { await db.ref().update(repairs); } catch(_) {}
        }
        const themePool = ["Geography","History","Science","Sports","Technology","Random"];
        const updates = {};
        const now = Date.now();
        let pushed = 0;
        top.forEach((e, idx) => {
            if (existing.has(e.addr.toLowerCase())) return; // skip — already in feed
            let h = 0;
            for (let i = 0; i < e.addr.length; i++) h = (h * 31 + e.addr.charCodeAt(i)) >>> 0;
            const minutesAgo = 60 + (h % (60 * 24 * 6)); // 1h to 6d
            const ts = now - minutesAgo * 60 * 1000 - idx * 1000;
            const theme = themePool[h % themePool.length];
            // Per-round XP, not cumulative — realistic single-game gain (4–28)
            const xpDelta = 4 + ((h >> 4) % 25);
            const lvl = levelFromXp(e.score * XP_PER_POINT).level;
            const key = db.ref("recentXp").push().key;
            updates[`recentXp/${key}`] = {
                addr: e.addr, xpDelta, theme,
                isWeeklyMatch: false,
                levelUp: false,
                levelAfter: lvl,
                ts,
                synthetic: true,
            };
            pushed++;
        });
        if (pushed > 0) await db.ref().update(updates);
    } catch (err) {
        console.warn("Recent wins seed failed:", err);
    } finally {
        _recentSeedRunning = false;
    }
}

function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - (ts || 0));
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

function renderRecentWins() {
    const el = $("#recentWins");
    if (!el) return;
    if (_recentWins.length === 0) {
        el.innerHTML = `
            <li class="rw-empty">
                <div class="rw-empty-icon">⚡</div>
                <div class="rw-empty-text">No XP awarded yet. Play a round!</div>
            </li>`;
        return;
    }
    const themeIcons = { Geography:"🌍", History:"📜", Science:"🔬", Sports:"⚽", Technology:"💻", Random:"🎲" };
    el.innerHTML = _recentWins.slice(0, 5).map(w => {
        const av = avatarHtml(w.addr, "gen-avatar-md");
        const name = profileName(w.addr) !== shortAddr(w.addr) ? profileName(w.addr) : shortAddr(w.addr);
        const themeIcon = w.theme ? (themeIcons[w.theme] || "🎲") : "";
        return `<li class="rw-entry" data-player-addr="${w.addr}">
            <span class="rw-avatar">${av}</span>
            <div class="rw-info">
              <span class="rw-name">${name}</span>
              <span class="rw-meta">
                ${themeIcon ? `<span class="rw-theme">${themeIcon}</span>` : ""}
                <span class="rw-time">${timeAgo(w.ts)}</span>
                ${w.levelUp ? '<span class="rw-lvlup">LVL UP</span>' : ""}
              </span>
            </div>
            <span class="rw-xp">
              +${w.xpDelta}
              ${w.isWeeklyMatch ? '<span class="rw-x2">2×</span>' : ""}
            </span>
        </li>`;
    }).join("");
    el.querySelectorAll("[data-player-addr]").forEach(li => {
        li.onclick = (e) => {
            e.stopPropagation();
            showProfilePopover(li.dataset.playerAddr, li);
        };
    });
}

// ══════════════════════════════════════════════════════
//  LEVELS CACHE (real-time)
// ══════════════════════════════════════════════════════
const levelsCache = {}; // { addr: { totalXp, byTheme, ... } }
let _levelsListener = null;

function listenToAllLevels() {
    if (_levelsListener) return;
    _levelsListener = db.ref("levels").on("value", snap => {
        const all = snap.val() || {};
        for (const [addr, d] of Object.entries(all)) {
            levelsCache[addr.toLowerCase()] = d;
        }
        // Re-render dependent UIs
        renderLeaderboard();
    });
}

// XP conversion for legacy/unseeded scores (1 game point = 1 XP)
const XP_PER_POINT = 1;
const SEED_VERSION = 2;

// One-time seeding so existing leaderboard scores translate to XP/levels.
// Idempotent: only seeds when no level record exists yet, or when totalXp
// is below the score-derived XP (e.g. legacy entries that predate the XP system).
const _seededLevels = new Set();
function seedLevelFromScore(addr, score) {
    if (!addr || !score || score <= 0) return;
    const key = addr.toLowerCase();
    if (_seededLevels.has(key)) return;
    _seededLevels.add(key);
    const seedXp = score * XP_PER_POINT;
    db.ref(`levels/${key}`).transaction(curr => {
        if (!curr) {
            return { totalXp: seedXp, byTheme: {}, weeklyXp: 0, seededFromScore: true, seedVersion: SEED_VERSION, seededAt: Date.now() };
        }
        // Re-seed when seed formula changes (older seeds used a different multiplier)
        if (curr.seededFromScore && curr.seedVersion !== SEED_VERSION) {
            curr.totalXp = seedXp;
            curr.seedVersion = SEED_VERSION;
            curr.seededAt = Date.now();
            return curr;
        }
        // Top up unseeded entries that have a lower XP than the score implies
        if (!curr.seededFromScore && (curr.totalXp || 0) < seedXp) {
            curr.totalXp = seedXp;
            curr.seededFromScore = true;
            curr.seedVersion = SEED_VERSION;
            curr.seededAt = Date.now();
            return curr;
        }
        return; // abort transaction (no change)
    }).catch(() => {});
}

function getLevelInfo(addr) {
    if (!addr) return levelFromXp(0);
    const key = addr.toLowerCase();
    const data = levelsCache[key];
    let xp = data?.totalXp;
    // Fallback: derive from leaderboard score for accounts not yet seeded
    if (xp == null) {
        const lb = _leaderboardEntries.find(e => e.addr.toLowerCase() === key);
        xp = (lb?.score || 0) * XP_PER_POINT;
    }
    return levelFromXp(xp);
}

// ══════════════════════════════════════════════════════
//  XP / LEVEL SYSTEM
// ══════════════════════════════════════════════════════
const LEVEL_TIERS = [
    { lvl: 1, min: 0,   max: 20,    title: "Initiate"        },
    { lvl: 2, min: 20,  max: 60,    title: "Apprentice"      },
    { lvl: 3, min: 60,  max: 120,   title: "Convincing"      },
    { lvl: 4, min: 120, max: 200,   title: "Silver Tongue"   },
    { lvl: 5, min: 200, max: 300,   title: "Master Perjurer" },
    { lvl: 6, min: 300, max: 440,   title: "Grandmaster"     },
    { lvl: 7, min: 440, max: 99999, title: "Court Sovereign" },
];

function levelFromXp(xp) {
    xp = Math.max(0, xp || 0);
    const tier = LEVEL_TIERS.find(t => xp >= t.min && xp < t.max) || LEVEL_TIERS[LEVEL_TIERS.length-1];
    const inLevel = xp - tier.min;
    const span = tier.max - tier.min;
    return {
        level: tier.lvl,
        title: tier.title,
        currentLevelXp: inLevel,
        nextLevelXp: span,
        progress: Math.min(100, Math.round((inLevel / span) * 100)),
        totalXp: xp,
    };
}

// Convert game points → XP (1:1 with leaderboard score; capped to avoid abuse)
function pointsToXp(points) {
    const base = (points || 0) * XP_PER_POINT;
    return Math.max(-6, Math.min(24, base));   // floor/ceiling
}

// ── Weekly theme rotation ───────────────────────────
function getWeekStartTs() {
    const now = new Date();
    const day = now.getUTCDay() || 7;          // Mon=1..Sun=7
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - (day - 1));
    return monday.getTime();
}

const THEME_POOL = ["Geography", "History", "Science", "Sports", "Technology", "Random"];
let _weeklyTheme = null;

async function ensureWeeklyTheme() {
    if (_weeklyTheme && _weeklyTheme.weekStartTs === getWeekStartTs()) return _weeklyTheme;
    const ref = db.ref("weeklyTheme");
    const snap = await ref.once("value");
    const cur = snap.val();
    const wkTs = getWeekStartTs();
    if (cur && cur.weekStartTs === wkTs) {
        _weeklyTheme = cur;
        return cur;
    }
    // Pick deterministically based on week to avoid race conditions
    const seed = Math.floor(wkTs / (7 * 24 * 3600 * 1000));
    const theme = THEME_POOL[seed % THEME_POOL.length];
    const next = { theme, weekStartTs: wkTs };
    try { await ref.set(next); } catch (_) {}
    _weeklyTheme = next;
    return next;
}

function renderWeeklyBanner() {
    const el = $("#weeklyThemeBanner");
    if (!el || !_weeklyTheme) return;
    const themeIcons = { Geography:"🌍", History:"📜", Science:"🔬", Sports:"⚽", Technology:"💻", Random:"🎲" };
    $("#weeklyThemeName").textContent = _weeklyTheme.theme;
    $("#weeklyThemeIcon").textContent = themeIcons[_weeklyTheme.theme] || "🎲";
    const howWk = $("#howWeeklyTheme"); if (howWk) howWk.textContent = _weeklyTheme.theme;
    el.hidden = false;
}

// ── Award XP after game ─────────────────────────────
async function awardXp(results, roomTheme) {
    if (!results) return {};
    const wk = await ensureWeeklyTheme().catch(() => null);
    const isWeeklyMatch = wk && roomTheme && wk.theme === roomTheme;
    const multiplier = isWeeklyMatch ? 2 : 1;

    const summary = {}; // { addr: { xpDelta, before, after, levelUp, theme } }
    const tasks = [];

    for (const [addr, res] of Object.entries(results)) {
        const xpDelta = pointsToXp(res.points) * multiplier;
        const ref = db.ref(`levels/${addr}`);
        const wkTs = getWeekStartTs();

        const task = ref.transaction(cur => {
            if (!cur) cur = { totalXp: 0, byTheme: {}, weeklyXp: 0, weekStartTs: wkTs };
            if (cur.weekStartTs !== wkTs) { cur.weeklyXp = 0; cur.weekStartTs = wkTs; }
            const beforeXp = cur.totalXp || 0;
            cur.totalXp   = Math.max(0, beforeXp + xpDelta);
            cur.byTheme   = cur.byTheme || {};
            if (roomTheme) cur.byTheme[roomTheme] = Math.max(0, (cur.byTheme[roomTheme] || 0) + xpDelta);
            cur.weeklyXp  = Math.max(0, (cur.weeklyXp || 0) + xpDelta);
            cur.updatedAt = Date.now();
            return cur;
        }).then(tx => {
            const after = tx.snapshot.val() || { totalXp: 0 };
            const before = after.totalXp - xpDelta;
            const lvlBefore = levelFromXp(before).level;
            const lvlAfter  = levelFromXp(after.totalXp).level;
            summary[addr] = {
                xpDelta, multiplier, isWeeklyMatch,
                before, after: after.totalXp,
                levelBefore: lvlBefore, levelAfter: lvlAfter,
                levelUp: lvlAfter > lvlBefore,
                theme: roomTheme,
                themeXp: after.byTheme?.[roomTheme] || 0,
            };
            // Push to recent wins feed (only positive XP gains)
            if (xpDelta > 0) {
                db.ref("recentXp").push({
                    addr, xpDelta, theme: roomTheme || "",
                    isWeeklyMatch: !!isWeeklyMatch,
                    levelUp: lvlAfter > lvlBefore,
                    levelAfter: lvlAfter,
                    ts: Date.now(),
                }).catch(()=>{});
            }
        }).catch(err => console.warn("XP award failed for", addr, err));

        tasks.push(task);
    }

    await Promise.all(tasks);
    return summary;
}

// Update leaderboard after game results
async function updateLeaderboard(results) {
    if (!results) return null;
    // Update cumulative score (existing)
    for (const [addr, res] of Object.entries(results)) {
        const ref = db.ref(`leaderboard/${addr}`);
        ref.transaction(current => {
            if (!current) current = { score: 0, wins: 0, name: res.username || shortAddr(addr) };
            current.score = (current.score || 0) + (res.points || 0);
            current.name  = res.username || current.name;
            return current;
        });
    }
    // Award XP per theme
    const theme = state._lastRoom?.theme || state.roomData?.theme;
    const xpSummary = await awardXp(results, theme);
    state._lastXpSummary = xpSummary;
    // Broadcast to all clients via room
    if (state.currentRoomId) {
        try {
            await db.ref(`rooms/${state.currentRoomId}/xpSummary`).set(xpSummary);
        } catch (e) { console.warn("xpSummary write failed:", e); }
    }
    return xpSummary;
}
