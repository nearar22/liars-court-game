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
* **LLM Consensus:** Once voting ends, the Python Contract calls `gl.nondet.exec_prompt` to pass all claims to the AI validators for fact-checking.
* **Unified Verdict:** Using `gl.eq_principle.strict_eq()`, the contract reaches a final, consensus-backed verdict from all validators on who told the truth and who lied.
* **On-Chain Scores:** The results, points, and total wins are all securely recorded on the Smart Contract state (`scores` and `wins`).

---

## 🛠️ Architecture & Tech Stack
* **Smart Contract (Backend):** Written in Python (`contract.py`) using the `genlayer` SDK. It handles the state machine for the game phases and the AI Judge logic.
* **Frontend:** Built with HTML, CSS (`style.css`), and Vanilla JavaScript (`app.js`). It integrates the `genlayer-bridge` to connect wallets and send transactions to the GenLayer network.

---

## 💻 How to Run Locally
1. **GenLayer Simulator:** Deploy the contract to your local GenLayer simulator.
   ```bash
   genlayer deploy contract.py
   ```
2. **Frontend:** Open `index.html` using a local web server (like Live Server in VSCode or `python -m http.server`).

---
*Built with ❤️ for the GenLayer Ecosystem*
