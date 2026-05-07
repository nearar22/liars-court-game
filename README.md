# ⚖️ Liar's Court

## 🌟 Overview
**Liar's Court** is an engaging trivia and bluffing multiplayer game built on GenLayer. In this game, players choose a theme and submit claims that can either be true or a deliberate lie. The goal is to deceive your opponents and correctly guess who is lying. The ultimate twist is the GenLayer AI, which acts as the Fact-Checker Judge to determine whether the submitted claims are factually true or false in the real world!

---

## 🕹️ Gameplay (How It Works)
The game consists of 5 phases:
1. **WAITING:** A player creates a room and others join. The game requires 2 to 4 players to start.
2. **CLAIMING:** A theme is assigned to the room (e.g., Space, Geography, or History). Each player submits a factual claim and secretly tags it as a "truth" or a "lie". Other players cannot see this tag.
3. **VOTING:** All players review the claims made by others and vote on whether each claim is a "TRUTH" or a "LIE".
4. **JUDGING:** This is where the GenLayer Intelligent Contract steps in! The AI evaluates all claims and checks their factual accuracy using *Optimistic Democracy* and LLM validator consensus.
5. **RESULTS:** Points are awarded based on the outcome:
   - Successfully lied without getting caught: +3 Points 🏆
   - Caught lying: -1 Point ❌
   - Told a truth that is factually correct: +1 Point ✅
   - Told a "truth" but it was factually incorrect (AI says it's false): -1 Point ❌
   - Correctly guessed another player's lie/truth: +1 Point 🎯

---

## 🧠 The GenLayer Twist: AI Fact-Checker
The core of this game leverages GenLayer's **Equivalence Principle** and **Non-deterministic Execution**:
* **LLM Consensus:** Once voting ends, `judge_contract.py` calls `gl.nondet.exec_prompt` to pass all claims to the AI validators for fact-checking.
* **Unified Verdict:** Using `gl.eq_principle.strict_eq()`, the contract reaches a final, consensus-backed verdict from all validators on who told the truth and who lied.
* **Mandatory — No Trust Fallback:** The round **cannot** reach the `RESULTS` phase without real GenLayer verdicts. If consensus fails or times out, the room is rolled back to `VOTING` and the host auto-retries. Player declarations are **never** used as a substitute — that would defeat the purpose of the AI Judge.
* **On-Chain Evidence:** Every round's judging transaction hash is stored with the result and linked to the Bradbury block explorer, so any player can audit the AI's decision.
* **On-Chain Scoring (v3.0.0):** After every round, the result is committed to `judge_contract.record_round(room_id, points_json, winner)`. The host fires this call inline, and **every other client also runs a staggered fallback commit** so even if the host abandons the room mid-flight, the round still lands on chain. The contract is **idempotent** (`room_id` is the storage key) — the first valid commit wins, all duplicates are silent no-ops. Cumulative `scores`, `wins`, and a per-room `round_results` snapshot are stored on-chain, making the leaderboard tamper-proof and independently verifiable through `get_score`, `get_wins`, and `get_round_result`. Firebase keeps a synced cache for instant UX, but the contract is the source of truth.

---

## ✅ Design Requirements — How We Honored Them

This game was built around four core design principles. Here is how each is reflected in the implementation:

| Requirement | Implementation |
|---|---|
| **Multiplayer and/or in rooms** | Players create or join named **Courts (rooms)** that support **2–4 players**. Real-time room state, presence, voting and judging are synced via Firebase Realtime Database. |
| **Last between 5–15 min** | A full session takes **~5–10 min** — short claim/voting timers, fast AI judging via GenLayer LLM validators, and a single-round structure keep matches tight and replayable. |
| **Replayable once per week (new / random content or expertise level-up)** | Two mechanics combine: <br>• A **Weekly Theme** auto-rotates every Monday (`Geography → History → Science → Sports → Technology → Random`) — playing the active weekly theme grants a **2× XP multiplier**. <br>• An **Expertise Level-Up** system tracks XP **per theme**, so each week players grow stronger in the rotating discipline (`byTheme` XP, theme-specific tiers). |
| **Leaderboard after the game for XP distribution** | After every round, a **post-game XP Distribution panel** breaks down each player's gain (base XP, weekly 2× bonus, level-up animation, theme-specific XP). The persistent **Top Liars** leaderboard and live **Recent Wins** feed reflect XP in real time across the whole community. |

---

## 🛠️ Architecture & Tech Stack
* **AI Judge Contract:** [`judge_contract.py`](./judge_contract.py) — the only deployed contract. Written in Python with the `genlayer` SDK. Two methods power the game: `judge_claims(room_id, theme, claims_text)` invokes `gl.nondet.exec_prompt` across validators and reduces their outputs through `gl.eq_principle.strict_eq` to a consensus verdict map `{ address → truthful? }`; `record_round(room_id, points_json, winner)` then persists per-round and cumulative scoring on-chain. Read methods (`get_score`, `get_wins`, `get_round_result`, `get_verdicts`) let any client independently audit the chain.
* **Frontend:** HTML + CSS (`style.css`) + Vanilla JavaScript (`app.js`). Integrates `genlayer-bridge` to connect MetaMask to the Bradbury testnet and submit judging transactions.
* **Realtime Sync (Firebase RTDB):** Rooms, claims, votes, profiles, leaderboard, level/XP and the live *Recent Wins* feed are synchronised in milliseconds so multiplayer UX stays snappy. GenLayer is reserved for the one decision that matters — the AI fact-check — where correctness, not latency, is critical.

---

## 💻 How to Run Locally
1. **GenLayer Simulator:** Deploy the contract to your local GenLayer simulator.
   ```bash
   genlayer deploy judge_contract.py
   ```
2. **Frontend:** Open `index.html` using a local web server (like Live Server in VSCode or `python -m http.server`).

---
*Built with ❤️ for the GenLayer Ecosystem*
