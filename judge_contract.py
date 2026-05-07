# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json
import re


VERSION = "3.0.0"

# Few-shot examples that teach the LLM to catch common deception patterns.
# These are intentionally diverse (qualifiers, numbers, named entities, near-truths).
FEW_SHOT_EXAMPLES = '''EXAMPLES of correct judging:

Example A — absolute qualifier trap:
CLAIM: "Camels live only in the Sahara."
VERDICT: false
REASON: Camels also live in the Gobi, Arabian, and other deserts. The word "only" makes it false.

Example B — true general fact:
CLAIM: "The capital of Morocco is Rabat."
VERDICT: true
REASON: Rabat is the official capital of Morocco.

Example C — wrong number:
CLAIM: "The Earth has 3 moons."
VERDICT: false
REASON: Earth has 1 moon.

Example D — near-truth:
CLAIM: "Mount Everest is the tallest mountain on Earth."
VERDICT: true
REASON: At 8,849m above sea level it is the highest peak on Earth.

Example E — sneaky qualifier:
CLAIM: "All birds can fly."
VERDICT: false
REASON: Penguins, ostriches, and kiwis cannot fly.

Example F — named entity swap:
CLAIM: "Albert Einstein invented the telephone."
VERDICT: false
REASON: Alexander Graham Bell is credited with inventing the telephone.
'''


def _safe_extract_json(raw: str) -> dict:
    """
    Robustly extract a JSON object from an LLM response.
    Handles ```json fences, trailing commentary, and partial output.
    Returns {} on total failure (caller decides fallback policy).
    """
    if not raw:
        return {}
    text = raw.strip()
    # Strip markdown fences
    text = text.replace("```json", "").replace("```JSON", "").replace("```", "").strip()
    # Try direct parse first
    try:
        return json.loads(text)
    except Exception:
        pass
    # Greedy match for an object spanning the whole response
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        candidate = match.group(0)
        try:
            return json.loads(candidate)
        except Exception:
            # Some LLMs use Python booleans — coerce them.
            coerced = re.sub(r"\bTrue\b", "true", candidate)
            coerced = re.sub(r"\bFalse\b", "false", coerced)
            coerced = re.sub(r"\bNone\b", "null", coerced)
            try:
                return json.loads(coerced)
            except Exception:
                return {}
    return {}


def _normalize_verdicts(parsed: dict) -> dict:
    """
    Normalize keys (strip whitespace) and coerce values to strict booleans.
    Strings like "true"/"false"/"yes"/"no" are accepted.
    """
    out = {}
    for k, v in parsed.items():
        if not isinstance(k, str):
            continue
        key = k.strip()
        if isinstance(v, bool):
            out[key] = v
        elif isinstance(v, (int, float)):
            out[key] = bool(v)
        elif isinstance(v, str):
            low = v.strip().lower()
            if low in ("true", "yes", "t", "1"):
                out[key] = True
            elif low in ("false", "no", "f", "0"):
                out[key] = False
            else:
                # Default unknown to False — players shouldn't get credit for unparseable verdicts.
                out[key] = False
        elif isinstance(v, dict) and "verdict" in v:
            inner = v["verdict"]
            out[key] = bool(inner) if isinstance(inner, bool) else str(inner).strip().lower() in ("true", "yes", "t", "1")
        else:
            out[key] = False
    return out


class LiarsCourtJudge(gl.Contract):
    """
    AI fact-checker contract for Liar's Court — v2.

    Improvements over v1:
      * Strict, few-shot prompt that catches absolute-qualifier traps
        ("only", "all", "never", ...).
      * Robust JSON parsing with regex fallback and value coercion.
      * Stores per-room history (last 10 judgements) + reasoning.
      * Exposes the contract VERSION for clients to verify deployment.
    """

    # Latest verdicts per room (JSON string of {claim_id: bool})
    last_verdicts: TreeMap[str, str]
    # Latest reasoning per room (JSON string of {claim_id: str})
    last_reasons: TreeMap[str, str]
    # Audit log: room_id -> JSON list of past judgements (most recent first, capped)
    history: TreeMap[str, str]
    # Total number of judgement calls served (lifetime)
    total_judgements: u64

    # ── On-chain scoring (v2.1.0) ──
    # Cumulative points per player (signed — players can lose points).
    scores: TreeMap[Address, i64]
    # Total wins per player.
    wins: TreeMap[Address, u64]
    # Per-round result snapshot, keyed by room_id (JSON string).
    # Stores the full {addr: points} map plus winner so anyone can audit.
    round_results: TreeMap[str, str]
    # Total number of rounds recorded on-chain.
    total_rounds: u64

    def __init__(self):
        self.total_judgements = 0
        self.total_rounds = 0

    # ═══════════════════════════════════════
    #  CORE: AI FACT-CHECK
    # ═══════════════════════════════════════

    @gl.public.write
    def judge_claims(self, room_id: str, theme: str, claims_text: str) -> None:
        """
        AI fact-checks all claims via GenLayer LLM consensus.

        Args:
            room_id:     Unique room identifier (used as the storage key).
            theme:       Game theme (e.g. "Geography", "Sports").
            claims_text: Free-form text listing claims, one per line, in the
                         format "<CLAIM_ID>: \"<text>\"".

        Saves to state:
            last_verdicts[room_id] -> JSON {claim_id: bool}
            last_reasons[room_id]  -> JSON {claim_id: short reason}
            history[room_id]       -> JSON list of recent judgements (cap 10)
        """
        if not room_id:
            raise gl.vm.UserError("room_id is required")
        if not claims_text or not claims_text.strip():
            raise gl.vm.UserError("claims_text is empty")

        safe_theme = theme.strip() if theme else "General Knowledge"

        def ask_llm() -> str:
            prompt = f"""You are a STRICT and METICULOUS fact-checker judge for the deception game "Liar's Court".
Your job is to catch lies — players are actively trying to deceive you.

THEME: {safe_theme}

{FEW_SHOT_EXAMPLES}

EVALUATION RULES:
1. Evaluate every claim EXACTLY AS WRITTEN. Every word counts.
2. Absolute qualifiers — "only", "all", "every", "never", "always", "no", "exclusively",
   "the first", "the last", "the largest", "the smallest", "the most", "the fastest" —
   make the claim FALSE if even ONE counterexample exists.
3. Numbers, dates, named entities, and locations must be exact. Wrong by any margin = FALSE.
4. A claim is TRUE only if the WHOLE statement is factually correct.
5. Do NOT reward a claim for being "close" or "associated with the truth".
6. Default to FALSE when uncertain — the burden of proof is on the claim.

CLAIMS TO EVALUATE:
{claims_text}

OUTPUT FORMAT (STRICT):
Return ONE raw JSON object. No prose, no markdown fences, no commentary.
Schema: {{"<claim_id>": true_or_false}}
Use the claim identifiers EXACTLY as provided. Values are JSON booleans only.
"""
            raw = gl.nondet.exec_prompt(prompt)
            parsed = _safe_extract_json(raw)
            verdicts = {}
            for k, v in parsed.items():
                # Accept either flat {addr: bool} or nested {addr: {verdict: bool}}
                if isinstance(v, dict):
                    verdict_val = v.get("verdict", v.get("value", False))
                else:
                    verdict_val = v
                norm = _normalize_verdicts({k: verdict_val})
                if k.strip() in norm:
                    verdicts[k.strip()] = norm[k.strip()]
            # CRITICAL: only return booleans (deterministic) so validators reach
            # byte-identical strict_eq consensus. LLM-generated reasoning text
            # is non-deterministic and would break consensus.
            return json.dumps(verdicts, sort_keys=True)

        # Equivalence-principle consensus: validators must agree on the JSON output.
        # `gl.eq_principle.strict_eq` (v0.1.3 API) requires byte-identical output
        # across validators; we ensure that by sorting keys in `ask_llm` and
        # returning only deterministic boolean values (no LLM prose).
        result_str = gl.eq_principle.strict_eq(ask_llm)

        try:
            verdicts = json.loads(result_str) or {}
            if not isinstance(verdicts, dict):
                verdicts = {}
        except Exception:
            verdicts = {}
        # Reasons are not produced under strict_eq because they are non-deterministic.
        # Clients can still call get_reasons; it just returns "{}" until reasons are added.
        reasons = {}

        verdicts_json = json.dumps(verdicts, sort_keys=True)
        reasons_json = json.dumps(reasons, sort_keys=True)

        self.last_verdicts[room_id] = verdicts_json
        self.last_reasons[room_id] = reasons_json

        # Append to per-room history (cap 10, newest first)
        prev_hist = "[]"
        try:
            prev_hist = self.history[room_id]
        except Exception:
            prev_hist = "[]"
        try:
            hist_list = json.loads(prev_hist) if prev_hist else []
        except Exception:
            hist_list = []
        hist_list.insert(0, {
            "theme": safe_theme,
            "claims": claims_text,
            "verdicts": verdicts,
            "reasons": reasons,
        })
        if len(hist_list) > 10:
            hist_list = hist_list[:10]
        self.history[room_id] = json.dumps(hist_list)

        self.total_judgements = self.total_judgements + 1

    # ═══════════════════════════════════════
    #  READ METHODS
    # ═══════════════════════════════════════

    @gl.public.view
    def get_verdicts(self, room_id: str) -> str:
        """Latest verdicts for a room as JSON string {claim_id: bool}."""
        try:
            return self.last_verdicts[room_id]
        except Exception:
            return "{}"

    @gl.public.view
    def get_reasons(self, room_id: str) -> str:
        """Latest per-claim reasoning as JSON string {claim_id: str}."""
        try:
            return self.last_reasons[room_id]
        except Exception:
            return "{}"

    @gl.public.view
    def get_full_result(self, room_id: str) -> str:
        """Latest verdicts + reasons combined."""
        try:
            v = self.last_verdicts[room_id]
        except Exception:
            v = "{}"
        try:
            r = self.last_reasons[room_id]
        except Exception:
            r = "{}"
        try:
            verdicts = json.loads(v)
        except Exception:
            verdicts = {}
        try:
            reasons = json.loads(r)
        except Exception:
            reasons = {}
        return json.dumps({"verdicts": verdicts, "reasons": reasons}, sort_keys=True)

    @gl.public.view
    def get_history(self, room_id: str) -> str:
        """JSON list of last 10 judgements for the room."""
        try:
            return self.history[room_id]
        except Exception:
            return "[]"

    @gl.public.view
    def get_version(self) -> str:
        """Contract version — clients can verify the deployed build."""
        return VERSION

    @gl.public.view
    def get_total_judgements(self) -> int:
        """Lifetime count of judgement calls served by this contract."""
        return int(self.total_judgements)

    # ═══════════════════════════════════════
    #  ON-CHAIN SCORING (v2.1.0)
    # ═══════════════════════════════════════

    @gl.public.write
    def record_round(self, room_id: str, points_json: str, winner: str) -> None:
        """
        Commit a round's results on-chain. Cumulative scores and wins are
        updated atomically. Anyone (typically the host) may call this — the
        room_id acts as an idempotency key: re-submitting the same room_id
        is a no-op (the first commit wins).

        Args:
            room_id:     Same room_id used in `judge_claims`.
            points_json: JSON string {"<address>": <int_points>, ...}.
                         Points may be negative (a caught liar loses 1).
            winner:      Address of the round winner (or empty string if none).
        """
        if not room_id:
            raise gl.vm.UserError("room_id is required")
        if not points_json:
            raise gl.vm.UserError("points_json is required")

        # Idempotency: if a result for this room is already recorded, do nothing.
        try:
            existing = self.round_results[room_id]
            if existing:
                return
        except Exception:
            pass

        try:
            points = json.loads(points_json)
        except Exception:
            raise gl.vm.UserError("points_json is not valid JSON")
        if not isinstance(points, dict):
            raise gl.vm.UserError("points_json must be a JSON object")

        # Apply per-player point deltas.
        for addr_str, pts in points.items():
            if not isinstance(addr_str, str) or not addr_str.startswith("0x"):
                continue
            try:
                pts_int = int(pts)
            except Exception:
                continue
            try:
                addr = Address(addr_str)
            except Exception:
                continue
            try:
                cur = self.scores[addr]
            except Exception:
                cur = 0
            self.scores[addr] = cur + pts_int

        # Increment winner's win count.
        if winner and isinstance(winner, str) and winner.startswith("0x"):
            try:
                w = Address(winner)
                try:
                    cur_w = self.wins[w]
                except Exception:
                    cur_w = 0
                self.wins[w] = cur_w + 1
            except Exception:
                pass

        # Snapshot the round (audit trail).
        snapshot = json.dumps({
            "points": points,
            "winner": winner or "",
        }, sort_keys=True)
        self.round_results[room_id] = snapshot
        self.total_rounds = self.total_rounds + 1

    @gl.public.view
    def get_score(self, addr: Address) -> int:
        """Cumulative on-chain score for a player."""
        try:
            return int(self.scores[addr])
        except Exception:
            return 0

    @gl.public.view
    def get_wins(self, addr: Address) -> int:
        """Total on-chain win count for a player."""
        try:
            return int(self.wins[addr])
        except Exception:
            return 0

    @gl.public.view
    def get_round_result(self, room_id: str) -> str:
        """JSON snapshot of a recorded round: {"points": {...}, "winner": "0x..."}."""
        try:
            return self.round_results[room_id]
        except Exception:
            return "{}"

    @gl.public.view
    def get_total_rounds(self) -> int:
        """Lifetime count of rounds recorded on-chain."""
        return int(self.total_rounds)

    # ═══════════════════════════════════════
    #  ATOMIC JUDGE + SCORE (v3.0.0)
    # ═══════════════════════════════════════
    #
    # Single entry point that does the whole round on-chain in ONE tx:
    #   1. AI fact-checks every claim under eq-principle consensus.
    #   2. Contract itself computes points from (verdicts, votes) — no client
    #      logic is trusted. The player's intent button is irrelevant; only
    #      the AI verdict and the recorded votes matter.
    #   3. Cumulative scores, wins, and a round snapshot are persisted.
    #
    # This eliminates the need for a separate `record_round` follow-up tx and
    # closes the abandonment loophole: scoring is atomic with judging.

    @gl.public.write
    def judge_and_record(
        self,
        room_id: str,
        theme: str,
        claims_json: str,
        votes_json: str,
    ) -> None:
        """
        Atomic round finalization.

        Args:
            room_id:     Unique room identifier (idempotency key).
            theme:       Game theme (used in the AI prompt).
            claims_json: JSON {"<addr>": {"text": str, "intent_lie": bool}}.
                         The intent_lie field is recorded for audit only —
                         it is never used in scoring.
            votes_json:  JSON {"<voter_addr>": {"<target_addr>": "LIE"|"TRUTH"}}.
        """
        if not room_id:
            raise gl.vm.UserError("room_id is required")
        if not claims_json:
            raise gl.vm.UserError("claims_json is required")

        # Idempotency — first commit wins.
        try:
            existing = self.round_results[room_id]
            if existing:
                return
        except Exception:
            pass

        try:
            claims = json.loads(claims_json) or {}
        except Exception:
            raise gl.vm.UserError("claims_json is not valid JSON")
        if not isinstance(claims, dict) or not claims:
            raise gl.vm.UserError("claims_json must be a non-empty object")

        try:
            votes = json.loads(votes_json) if votes_json else {}
        except Exception:
            votes = {}
        if not isinstance(votes, dict):
            votes = {}

        safe_theme = theme.strip() if theme else "General Knowledge"

        # Build the prompt input — addresses are stable identifiers.
        # Sort keys so all validators see byte-identical input.
        sorted_addrs = sorted(claims.keys())
        claim_lines = []
        for addr in sorted_addrs:
            entry = claims[addr]
            text = ""
            if isinstance(entry, dict):
                text = str(entry.get("text", ""))[:500]
            elif isinstance(entry, str):
                text = entry[:500]
            # Strip newlines so each claim is a single line.
            text = text.replace("\n", " ").replace("\r", " ").strip()
            claim_lines.append(f'{addr}: "{text}"')
        claims_text = "\n".join(claim_lines)

        def ask_llm() -> str:
            prompt = f"""You are a STRICT and METICULOUS fact-checker judge for the deception game "Liar's Court".
Your job is to catch lies — players are actively trying to deceive you.

THEME: {safe_theme}

{FEW_SHOT_EXAMPLES}

EVALUATION RULES:
1. Evaluate every claim EXACTLY AS WRITTEN. Every word counts.
2. Absolute qualifiers — "only", "all", "every", "never", "always", "no", "exclusively",
   "the first", "the last", "the largest", "the smallest", "the most", "the fastest" —
   make the claim FALSE if even ONE counterexample exists.
3. Numbers, dates, named entities, and locations must be exact. Wrong by any margin = FALSE.
4. A claim is TRUE only if the WHOLE statement is factually correct.
5. Do NOT reward a claim for being "close" or "associated with the truth".
6. Default to FALSE when uncertain — the burden of proof is on the claim.

CLAIMS TO EVALUATE:
{claims_text}

OUTPUT FORMAT (STRICT):
Return ONE raw JSON object. No prose, no markdown fences, no commentary.
Schema: {{"<claim_id>": true_or_false}}
Use the claim identifiers EXACTLY as provided. Values are JSON booleans only.
"""
            raw = gl.nondet.exec_prompt(prompt)
            parsed = _safe_extract_json(raw)
            verdicts_local = {}
            for k, v in parsed.items():
                if isinstance(v, dict):
                    verdict_val = v.get("verdict", v.get("value", False))
                else:
                    verdict_val = v
                norm = _normalize_verdicts({k: verdict_val})
                if k.strip() in norm:
                    verdicts_local[k.strip()] = norm[k.strip()]
            return json.dumps(verdicts_local, sort_keys=True)

        result_str = gl.eq_principle.strict_eq(ask_llm)

        try:
            verdicts = json.loads(result_str) or {}
            if not isinstance(verdicts, dict):
                verdicts = {}
        except Exception:
            verdicts = {}

        # Refuse to commit anything if the AI failed — round must be retried.
        # No silent fallback to player declarations, ever.
        if not verdicts:
            raise gl.vm.UserError("AI Judge produced no verdicts; round cannot be recorded")

        # ── Compute points deterministically from (verdicts, votes) ──
        n_players = len(sorted_addrs)
        points = {addr: 0 for addr in sorted_addrs}

        for addr in sorted_addrs:
            v = verdicts.get(addr)
            ai_says_true = (v is True)
            ai_says_lie = (v is False)

            lie_votes = 0
            for voter, voter_votes in votes.items():
                if voter == addr or not isinstance(voter_votes, dict):
                    continue
                if voter_votes.get(addr) == "LIE":
                    lie_votes += 1

            others = max(n_players - 1, 1)
            was_caught = lie_votes * 2 > others  # strict majority

            if ai_says_lie and not was_caught:
                points[addr] += 3   # successful lie
            elif ai_says_lie and was_caught:
                points[addr] += -1  # caught lying
            elif ai_says_true and was_caught:
                points[addr] += 1   # truth wrongly accused
            elif ai_says_true and not was_caught:
                points[addr] += 2   # truth confirmed and trusted

        # Voter bonuses — each correct vote (matching AI verdict) earns +1.
        for voter, voter_votes in votes.items():
            if not isinstance(voter_votes, dict) or voter not in points:
                continue
            bonus = 0
            for target, vote_value in voter_votes.items():
                if target not in claims:
                    continue
                tv = verdicts.get(target)
                if tv is True and vote_value == "TRUTH":
                    bonus += 1
                elif tv is False and vote_value == "LIE":
                    bonus += 1
            points[voter] += bonus

        # Determine winner deterministically (highest points, ties → first by sort).
        winner = ""
        best = -10**9
        for addr in sorted_addrs:
            if points[addr] > best:
                best = points[addr]
                winner = addr

        # ── Persist cumulative state ──
        for addr_str, pts_int in points.items():
            if not isinstance(addr_str, str) or not addr_str.startswith("0x"):
                continue
            try:
                a = Address(addr_str)
            except Exception:
                continue
            try:
                cur = self.scores[a]
            except Exception:
                cur = 0
            self.scores[a] = cur + int(pts_int)

        if winner and winner.startswith("0x"):
            try:
                w = Address(winner)
                try:
                    cur_w = self.wins[w]
                except Exception:
                    cur_w = 0
                self.wins[w] = cur_w + 1
            except Exception:
                pass

        # Mirror verdicts to the existing storage for backward-compat readers.
        verdicts_json = json.dumps(verdicts, sort_keys=True)
        self.last_verdicts[room_id] = verdicts_json
        self.last_reasons[room_id] = "{}"

        # Snapshot the round.
        snapshot = json.dumps({
            "verdicts": verdicts,
            "points":   points,
            "winner":   winner,
            "theme":    safe_theme,
        }, sort_keys=True)
        self.round_results[room_id] = snapshot

        self.total_rounds = self.total_rounds + 1
        self.total_judgements = self.total_judgements + 1
