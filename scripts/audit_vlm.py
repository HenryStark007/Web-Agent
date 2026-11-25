r"""
Forensic VLM audit — traces the EXACT runtime behavior.
Answers: Is the real VLM being called? What is the data flow?
"""
import json
import httpx

SERVER = "http://127.0.0.1:8003"

# Tiny 1x1 black PNG — stands in for a sanitized screenshot
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)

KNOWN_PII = [
    "Amit Kumar", "amit@example.com", "9876543210",
    "Secret123", "4111 1111 1111 1111", "123 Demo Street, New Delhi",
]

print("=" * 70)
print("FORENSIC VLM AUDIT")
print("=" * 70)

# ── 1. Health check ──────────────────────────────────────────────────
print("\n[AUDIT 1] GET /health — what does the server CLAIM to be?")
r = httpx.get(f"{SERVER}/health", timeout=5)
h = r.json()
print(json.dumps(h, indent=2))

print(f"\n  vlm_configured = {h.get('vlm_configured')}")
print(f"  reasoning_mode = {h.get('reasoning_mode')}")
print(f"  model_provider = {h.get('model_provider')}")
print(f"  model_name     = {h.get('model_name')}")
print(f"  api_url        = {h.get('api_url')}")

if h.get("vlm_configured"):
    print("\n  >>> SERVER CLAIMS: Real VLM is active")
else:
    print("\n  >>> SERVER CLAIMS: Heuristic fallback (no API key)")

# ── 2. Send a real request and inspect the response ─────────────────
print("\n[AUDIT 2] POST /analyze — send a real request")
payload = {
    "task": "Find the laptop and click Buy Now.",
    "sanitized_screenshot_base64": f"data:image/png;base64,{TINY_PNG_B64}",
    "sanitized_context": {
        "redactedFields": [
            "name: [REDACTED x1]",
            "email: [REDACTED x1]",
            "phone: [REDACTED x1]",
            "password: [REDACTED x1]",
            "credit_card: [REDACTED x1]",
            "address: [REDACTED x1]",
        ],
        "visibleActionableElements": ["Search", "Add to Cart", "Buy Now"],
    },
}

# Privacy check BEFORE sending
body_str = json.dumps(payload)
leaked = [v for v in KNOWN_PII if v in body_str]
print(f"  Privacy check: {'LEAKED: ' + str(leaked) if leaked else 'CLEAN — no raw PII in payload'}")

r = httpx.post(f"{SERVER}/analyze", json=payload, timeout=15)
action = r.json()
print(f"\n  HTTP status: {r.status_code}")
print(f"  Response:\n{json.dumps(action, indent=2)}")

# ── 3. Source verdict ───────────────────────────────────────────────
print("\n[AUDIT 3] Source analysis")
source = action.get("source", "MISSING")
print(f"  source = '{source}'")

if source == "vlm":
    print("  >>> This response was produced by a REAL VLM")
elif source == "heuristic":
    print("  >>> This response was produced by the HEURISTIC KEYWORD MATCHER")
    print("  >>> The VLM was NOT called. The reasoning is:")
    print(f"      {action.get('reason', 'N/A')}")
else:
    print(f"  >>> Unknown source: '{source}'")

# ── 4. Confidence analysis ──────────────────────────────────────────
print("\n[AUDIT 4] Confidence analysis")
conf = action.get("confidence")
print(f"  confidence = {conf}")
if source == "heuristic" and conf is not None:
    print(f"  >>> Heuristic confidence is always 0.4 (click) or 0.2 (scroll)")
    print(f"  >>> A real VLM would return higher confidence (typically 0.7+)")

# ── 5. Verdict ──────────────────────────────────────────────────────
print("\n" + "=" * 70)
print("FINAL VERDICT")
print("=" * 70)

if not h.get("vlm_configured"):
    print("  MODEL_API_KEY is BLANK in server/.env")
    print("  The VLM code path is NEVER entered at runtime.")
    print("  get_next_action() skips _call_anthropic() and goes straight")
    print("  to heuristic_action().")
    print()
    print("  RESULT: HEURISTIC IS THE ACTIVE REASONER.")
    print("          VLM code exists but is NOT being executed.")

elif source == "vlm":
    print("  MODEL_API_KEY is configured AND the VLM responded.")
    print("  source = 'vlm' confirms the real API was called.")
    print()
    print("  RESULT: REAL VLM IS VERIFIED AND WORKING.")

elif source == "heuristic" and h.get("vlm_configured"):
    print("  MODEL_API_KEY is configured but the VLM call FAILED.")
    print("  The server attempted the VLM but fell back to heuristic.")
    print("  Check server console logs for the error.")
    print()
    print("  RESULT: VLM ATTEMPTED BUT FAILED — FALLBACK ACTIVE.")

else:
    print("  Unexpected state — manual investigation needed.")

print("=" * 70)
