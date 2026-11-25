"""
Quick test script for Phase 1 + Phase 2 verification.
Tests the full pipeline against the live server + demo site.
"""
import json
import httpx
from bs4 import BeautifulSoup

DEMO_URL = "http://127.0.0.1:5500"
SERVER_URL = "http://127.0.0.1:8001/analyze"  # using 8001 since 8000 is occupied
TASK = "Find the laptop and click Buy Now."

TINY_BLACK_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)

KNOWN_PII_VALUES = [
    "Amit Kumar", "amit@example.com", "9876543210",
    "Secret123", "4111 1111 1111 1111", "123 Demo Street, New Delhi",
]

errors = []
passes = []


def check(name, condition, detail=""):
    if condition:
        passes.append(name)
        print(f"  PASS  {name}")
    else:
        errors.append(name)
        print(f"  FAIL  {name} -- {detail}")


print("=" * 70)
print("Aegis PIPELINE TEST (Phase 1 + Phase 2)")
print("=" * 70)

# ======================================================================
# TEST 1: FastAPI server starts and /health works
# ======================================================================
print("\n[TEST 1] FastAPI /health endpoint")
try:
    r = httpx.get("http://127.0.0.1:8001/health", timeout=5)
    check("Server starts", r.status_code == 200)
    data = r.json()
    check("Health status=ok", data.get("status") == "ok")
    check("Reasoning mode reported", "reasoning_mode" in data)
    print(f"  -> reasoning_mode: {data.get('reasoning_mode')}")
except Exception as e:
    check("Server starts", False, str(e))

# ======================================================================
# TEST 2: Demo page serves content with expected PII
# ======================================================================
print("\n[TEST 2] Demo page")
try:
    html = httpx.get(DEMO_URL, timeout=5).text
    check("Demo page loads", len(html) > 100)

    soup = BeautifulSoup(html, "html.parser")
    pii_els = soup.select("[data-pii]")
    pii_types = [el["data-pii"] for el in pii_els]

    check("PII fields found (>=6)", len(pii_els) >= 6, f"found {len(pii_els)}")
    check("Name field present", "name" in pii_types)
    check("Email field present", "email" in pii_types)
    check("Phone field present", "phone" in pii_types)
    check("Password field present", "password" in pii_types)
    check("Credit card field present", "credit_card" in pii_types)
    check("Address field present", "address" in pii_types)

    # Verify the fake data values are in the page
    page_text = soup.get_text()
    for val in KNOWN_PII_VALUES:
        check(f"Demo contains '{val[:20]}...'", val in page_text)

    buttons = [b.get_text(strip=True) for b in soup.select("button")]
    check("Buy Now button present", "Buy Now" in buttons, f"buttons={buttons}")
except Exception as e:
    check("Demo page loads", False, str(e))

# ======================================================================
# TEST 3: Build sanitized payload (simulating extension)
# ======================================================================
print("\n[TEST 3] Build sanitized payload")
redacted_fields = [f"{t}: [REDACTED x1]" for t in pii_types]
payload = {
    "task": TASK,
    "sanitized_screenshot_base64": f"data:image/png;base64,{TINY_BLACK_PNG_B64}",
    "sanitized_context": {
        "redactedFields": redacted_fields,
        "visibleActionableElements": buttons,
    },
}
check("Payload has task", payload["task"] == TASK)
check("Payload has sanitized screenshot", payload["sanitized_screenshot_base64"].startswith("data:image"))
check("Payload has 6 redacted fields", len(redacted_fields) >= 6)

# ======================================================================
# TEST 4: Privacy check — no raw PII in outgoing payload
# ======================================================================
print("\n[TEST 4] Privacy guard — raw PII NOT in payload")
body_str = json.dumps(payload)
for val in KNOWN_PII_VALUES:
    check(f"'{val[:25]}' NOT in payload", val not in body_str)

# ======================================================================
# TEST 5: Send to server and get action
# ======================================================================
print("\n[TEST 5] POST /analyze")
action = None
try:
    resp = httpx.post(SERVER_URL, json=payload, timeout=15)
    check("Server responds 200", resp.status_code == 200, f"got {resp.status_code}")

    action = resp.json()
    print(f"  -> action = {json.dumps(action, indent=2)}")

    check("Action has 'action' key", "action" in action)
    check("Action type is click or scroll", action.get("action") in ("click", "scroll"))
    check("Action has 'source' key", "source" in action)
    check("Source is vlm or heuristic", action.get("source") in ("vlm", "heuristic"))

    if "confidence" in action and action["confidence"] is not None:
        conf = action["confidence"]
        check("Confidence in [0,1]", 0.0 <= conf <= 1.0, f"got {conf}")

    if action.get("action") == "click":
        check("Click has target", bool(action.get("target")))
        check("Target is 'Buy Now'", action.get("target", "").strip() == "Buy Now",
              f"got '{action.get('target')}'")
except Exception as e:
    check("POST /analyze", False, str(e))

# ======================================================================
# TEST 6: Simulate local execution
# ======================================================================
print("\n[TEST 6] Simulate local execution")
if action and action.get("action") == "click":
    target = action["target"].strip().lower()
    match = next(
        (b for b in soup.select("button") if target in b.get_text(strip=True).lower()),
        None,
    )
    check("Button found locally", match is not None)
    if match:
        check("Button is 'Buy Now'", "buy now" in match.get_text(strip=True).lower())
        print(f"  -> Would click: <button id='{match.get('id')}'>{match.get_text(strip=True)}</button>")
        print(f"  -> Page would show: 'Purchase initiated'")

# ======================================================================
# TEST 7: Invalid request handling
# ======================================================================
print("\n[TEST 7] Error handling — invalid screenshot")
try:
    bad_payload = {
        "task": "test",
        "sanitized_screenshot_base64": "not-a-data-url",
        "sanitized_context": {"redactedFields": [], "visibleActionableElements": []},
    }
    r = httpx.post(SERVER_URL, json=bad_payload, timeout=10)
    check("Invalid screenshot rejected (422)", r.status_code == 422, f"got {r.status_code}")
except Exception as e:
    check("Invalid screenshot rejected", False, str(e))

# ======================================================================
# SUMMARY
# ======================================================================
print("\n" + "=" * 70)
print(f"RESULTS: {len(passes)} passed, {len(errors)} failed")
print("=" * 70)
for name in passes:
    print(f"  PASS  {name}")
for name in errors:
    print(f"  FAIL  {name}")
print("=" * 70)
if not errors:
    print("ALL TESTS PASSED")
else:
    print(f"{len(errors)} TEST(S) FAILED")
