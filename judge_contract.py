# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json


class LiarsCourtJudge(gl.Contract):
    """
    Lightweight AI fact-checker contract for Liar's Court.
    Uses gl.nondet.exec_prompt + gl.eq_principle.strict_eq
    (same proven pattern as snake-protocol).
    """
    
    # Store the latest verdicts (transaction hash or room id could be used as key, but here we just store latest for simplicity since each room calls it)
    last_verdicts: TreeMap[str, str]

    def __init__(self):
        self.last_verdicts = TreeMap()

    @gl.public.write
    def judge_claims(self, room_id: str, theme: str, claims_text: str) -> None:
        """
        AI fact-checks claims via GenLayer LLM consensus.
        Saves JSON string to state.
        """
        def ask_llm() -> str:
            prompt = f"""You are an expert fact-checker for a trivia game.
THEME: {theme}

CLAIMS TO EVALUATE:
{claims_text}

Analyze each claim individually.
- If a claim is historically, scientifically, mathematically, and factually TRUE, assign it 'true'.
- If a claim contains errors, is a lie, contradicts established facts, or is factually incorrect, assign it 'false'.
Respond ONLY with a valid JSON object where keys are the claim identifiers exactly as provided, and values are the boolean results (true/false).
No markdown formatting, no explanations, ONLY raw JSON."""
            raw = gl.nondet.exec_prompt(prompt)
            raw = raw.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(raw)
            return json.dumps(parsed, sort_keys=True)

        result_str = gl.eq_principle.strict_eq(ask_llm)
        self.last_verdicts[room_id] = result_str

    @gl.public.view
    def get_verdicts(self, room_id: str) -> str:
        if room_id in self.last_verdicts:
            return self.last_verdicts[room_id]
        return "{}"
