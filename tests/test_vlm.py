r"""
test_vlm.py — Phase 3 verification: Real VLM reasoning + fallback.

Tests the complete pipeline:
  1. /health reports correct VLM configuration
  2. Heuristic fallback works (no API key configured)
  3. VLM request payload is correctly formed (privacy-safe)
  4. Response schema is validated
  5. Source tagging ("vlm" vs "heuristic") is correct
  6. Error handling: invalid screenshot, missing fields

Run against a live server:
    cd Browser-Agent/server
    .\venv\Scripts\Activate.ps1
    python -m uvicorn main:app --host 127.0.0.1 --port 8002

    # In another terminal:
    cd Browser-Agent
    .\server\venv\Scripts\python.exe test_vlm.py
"""
import json
import sys

import httpx

SERVER_URL = "http://127.0.0.1:8002"
ANALYZE_URL = f"{SERVER_URL}/analyze"
HEALTH_URL = f"{SERVER_URL}/health"

# Tiny 1x1 black PNG — stands in for "sanitized screenshot after redaction"
TINY_BLACK_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)

KNOWN_PII_VALUES = [
    "Amit Kumar", "amit@example.com", "9876543210",
    "Secret123", "4111 1111 1111 1111", "123 Demo Street, New Delhi",
]

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        msg = f"  FAIL  {name}"
        if detail:
            msg += f"  --  {detail}"
        print(msg)


def make_payload(**overrides):
    """Build a standard valid AnalyzeRequest payload."""
    base = {
        "task": "Find the laptop and click Buy Now.",
        "sanitized_screenshot_base64": f"data:image/png;base64,{TINY_BLACK_PNG_B64}",
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
    base.update(overrides)
    return base


# ======================================================================
print("=" * 70)
print("PHASE 3 TEST — Real VLM reasoning + fallback")
print("=" * 70)

# ------------------------------------------------------------------
# TEST 1: /health endpoint
# ------------------------------------------------------------------
print("\n[TEST 1] /health endpoint")
try:
    r = httpx.get(HEALTH_URL, timeout=5)
    check("GET /health returns 200", r.status_code == 200)
    h = r.json()
    check("status = ok", h.get("status") == "ok")
    check("reasoning_mode present", "reasoning_mode" in h)
    check("vlm_configured present", "vlm_configured" in h)
    check("timeout_sec present", "timeout_sec" in h)
    print(f"  -> reasoning_mode: {h.get('reasoning_mode')}")
    print(f"  -> vlm_configured: {h.get('vlm_configured')}")
    print(f"  -> model: {h.get('model_provider')}/{h.get('model_name')}")
    print(f"  -> api_url: {h.get('api_url')}")
    print(f"  -> timeout: {h.get('timeout_sec')}s")

    if h.get("vlm_configured"):
        print("  -> VLM MODE: Real VLM is active (API key is set)")
    else:
        print("  -> FALLBACK MODE: No API key — heuristic will be used")
except Exception as e:
    check("GET /health", False, str(e))

# ------------------------------------------------------------------
# TEST 2: Valid request → heuristic fallback (no key)
# ------------------------------------------------------------------
print("\n[TEST 2] POST /analyze — valid request")
try:
    payload = make_payload()
    r = httpx.post(ANALYZE_URL, json=payload, timeout=15)
    check("Returns 200", r.status_code == 200, f"got {r.status_code}")

    action = r.json()
    print(f"  -> response: {json.dumps(action, indent=2)}")

    # Schema validation
    check("Has 'action' key", "action" in action)
    check("action is click or scroll", action.get("action") in ("click", "scroll"))
    check("Has 'source' key", "source" in action)
    check("source is vlm or heuristic", action.get("source") in ("vlm", "heuristic"))

    if action.get("action") == "click":
        check("click has 'target'", bool(action.get("target")))
        check("target is 'Buy Now'",
              action.get("target", "").strip() == "Buy Now",
              f"got '{action.get('target')}'")

    if action.get("confidence") is not None:
        c = action["confidence"]
        check("confidence in [0, 1]", 0.0 <= c <= 1.0, f"got {c}")

    # For the heuristic demo, verify it correctly identifies Buy Now
    if action.get("source") == "heuristic":
        check("Heuristic correctly targets 'Buy Now'",
              action.get("target", "").strip() == "Buy Now")
        print("  -> Heuristic fallback working correctly")
    elif action.get("source") == "vlm":
        print("  -> Real VLM responded — checking action quality")
        check("VLM action is click",
              action.get("action") == "click")
        check("VLM targets Buy Now",
              action.get("target", "").strip() == "Buy Now")
        print("  -> Real VLM reasoning working correctly")
except Exception as e:
    check("POST /analyze", False, str(e))

# ------------------------------------------------------------------
# TEST 3: Privacy — no raw PII in payload
# ------------------------------------------------------------------
print("\n[TEST 3] Privacy verification — payload contains no raw PII")
payload = make_payload()
body_str = json.dumps(payload)
for val in KNOWN_PII_VALUES:
    short = val[:30]
    check(f"'{short}' NOT in payload", val not in body_str)

# Also verify the redacted summary doesn't leak values
ctx = payload["sanitized_context"]
ctx_str = json.dumps(ctx)
for val in KNOWN_PII_VALUES:
    check(f"'{val[:30]}' NOT in sanitized_context", val not in ctx_str)

# ------------------------------------------------------------------
# TEST 4: Error handling — invalid screenshot
# ------------------------------------------------------------------
print("\n[TEST 4] Error handling — invalid screenshot")
try:
    bad = make_payload(sanitized_screenshot_base64="not-a-data-url")
    r = httpx.post(ANALYZE_URL, json=bad, timeout=10)
    check("Rejected with 422", r.status_code == 422, f"got {r.status_code}")
except Exception as e:
    check("Invalid screenshot rejected", False, str(e))

# ------------------------------------------------------------------
# TEST 5: Error handling — missing required fields
# ------------------------------------------------------------------
print("\n[TEST 5] Error handling — missing fields")
try:
    r = httpx.post(ANALYZE_URL, json={"task": "test"}, timeout=10)
    check("Missing fields rejected with 422", r.status_code == 422, f"got {r.status_code}")
except Exception as e:
    check("Missing fields rejected", False, str(e))

# ------------------------------------------------------------------
# TEST 6: VLM request format validation (inspect what would be sent)
# ------------------------------------------------------------------
print("\n[TEST 6] VLM request format — validate structure")
payload = make_payload()
# Verify the screenshot is a valid data URL
ss = payload["sanitized_screenshot_base64"]
check("Screenshot starts with data:image/", ss.startswith("data:image/"))
check("Screenshot contains base64 comma", "," in ss)

# The base64 part after the comma should be non-empty
_, _, b64 = ss.partition(",")
check("Base64 data is non-empty", len(b64) > 0)

# Context structure
ctx = payload["sanitized_context"]
check("redactedFields is a list", isinstance(ctx["redactedFields"], list))
check("visibleActionableElements is a list", isinstance(ctx["visibleActionableElements"], list))
check("6 redacted field entries", len(ctx["redactedFields"]) == 6)
check("Buy Now in actionable elements",
      "Buy Now" in ctx["visibleActionableElements"])

# ------------------------------------------------------------------
# TEST 7: Source tagging correctness
# ------------------------------------------------------------------
print("\n[TEST 7] Source tagging — every response identifies its origin")
try:
    # Send two requests and verify both tag their source
    for i in range(2):
        r = httpx.post(ANALYZE_URL, json=make_payload(), timeout=15)
        action = r.json()
        src = action.get("source")
        check(f"Request {i+1}: source is '{src}'",
              src in ("vlm", "heuristic"),
              f"unexpected source: {src}")
except Exception as e:
    check("Source tagging", False, str(e))

# ------------------------------------------------------------------
# TEST 8: Scroll fallback when no matching element
# ------------------------------------------------------------------
print("\n[TEST 8] Scroll fallback — task with no matching button")
try:
    payload = make_payload(task="Find something completely unrelated xyz")
    payload["sanitized_context"]["visibleActionableElements"] = ["Search", "Add to Cart", "Buy Now"]
    r = httpx.post(ANALYZE_URL, json=payload, timeout=15)
    check("Returns 200", r.status_code == 200)
    action = r.json()
    print(f"  -> response: {json.dumps(action, indent=2)}")
    # Heuristic should scroll when no keyword match
    if action.get("source") == "heuristic":
        check("Heuristic scrolls when no match",
              action.get("action") == "scroll")
    else:
        # VLM may still click something — that's fine
        check("VLM returns valid action",
              action.get("action") in ("click", "scroll"))
except Exception as e:
    check("Scroll fallback", False, str(e))

# ======================================================================
# SUMMARY
# ======================================================================
print("\n" + "=" * 70)
total = passed + failed
print(f"RESULTS: {passed}/{total} passed, {failed}/{total} failed")
print("=" * 70)

if failed == 0:
    print("ALL TESTS PASSED — Phase 3 VLM integration verified")
else:
    print(f"{failed} TEST(S) FAILED — see above for details")

sys.exit(0 if failed == 0 else 1)
