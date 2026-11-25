"""
Simulates what the Chrome extension does, step by step, against the live
demo site, so the full pipeline can be verified without a GUI browser:

  1. Fetch the demo page (as the content script would see the DOM)
  2. Detect PII via the same rule the extension uses: elements with data-pii
  3. Build the sanitized_context (redacted field counts + visible buttons)
  4. Build a tiny placeholder "already redacted" PNG (stand-in for the real
     screenshot-with-black-boxes the extension would capture)
  5. POST to /analyze — exactly the request body background.js sends
  6. Print the action the server returns
  7. Simulate local execution of that action against the page's real button
"""

import base64
import re

import httpx
from bs4 import BeautifulSoup

DEMO_URL = "http://127.0.0.1:5500"
SERVER_URL = "http://127.0.0.1:8000/analyze"
TASK = "Find the laptop and click Buy Now."

# 1x1 black PNG, standing in for "screenshot after redaction overlays drawn"
TINY_BLACK_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def fetch_page():
    resp = httpx.get(DEMO_URL, timeout=10)
    resp.raise_for_status()
    return resp.text


def detect_and_redact(html):
    soup = BeautifulSoup(html, "html.parser")

    # Step 2: PII detection — same rule as piiDetector.js's data-pii lookup
    pii_elements = soup.select("[data-pii]")
    pii_types = [el["data-pii"] for el in pii_elements]
    print(f"[client] PII detected: {len(pii_elements)} -> types={pii_types}")

    # Step 2b (defense in depth, mirrors the regex patterns in piiDetector.js)
    email_re = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
    text = soup.get_text()
    extra_emails = email_re.findall(text)
    print(f"[client] Regex-matched emails in raw text (would also be redacted): {extra_emails}")

    # Step 3: sanitized context — values are NEVER included, only counts + labels
    redacted_fields = [f"{t}: [REDACTED x1]" for t in pii_types]

    buttons = [b.get_text(strip=True) for b in soup.select("button")]
    print(f"[client] Visible actionable elements (safe to share): {buttons}")

    print("[client] Raw PII values are NOT included in what gets sent. "
          "Confirming none of the raw values appear in the outgoing payload below.")

    return redacted_fields, buttons, pii_elements


def call_server(redacted_fields, buttons):
    payload = {
        "task": TASK,
        "sanitized_screenshot_base64": f"data:image/png;base64,{TINY_BLACK_PNG_B64}",
        "sanitized_context": {
            "redactedFields": redacted_fields,
            "visibleActionableElements": buttons,
        },
    }

    # Prove no raw PII leaks into the request body
    import json
    body_str = json.dumps(payload)
    raw_values = [
        "Amit Kumar", "amit@example.com", "9876543210",
        "Secret123", "4111 1111 1111 1111", "123 Demo Street, New Delhi",
    ]
    leaked = [v for v in raw_values if v in body_str]
    print(f"[privacy check] Raw PII values found in outgoing request body: {leaked or 'NONE'}")

    print(f"\n[client -> server] POST {SERVER_URL}")
    print(f"[client -> server] body = {body_str}\n")

    resp = httpx.post(SERVER_URL, json=payload, timeout=15)
    resp.raise_for_status()
    action = resp.json()
    print(f"[server -> client] action = {action}")
    return action


def simulate_execution(html, action):
    soup = BeautifulSoup(html, "html.parser")
    if action["action"] == "click":
        target_text = action["target"].strip().lower()
        buttons = soup.select("button")
        match = next((b for b in buttons if target_text in b.get_text(strip=True).lower()), None)
        if match:
            print(f"[local exec] Found matching button: <button id='{match.get('id')}'>{match.get_text(strip=True)}</button>")
            print(f"[local exec] Simulating .click() -> would set #status text to 'Purchase initiated' "
                  f"(per the onclick handler in demo-site/index.html)")
            return {"success": True, "executed": "click", "target": action["target"]}
        else:
            print("[local exec] No matching button found")
            return {"success": False, "error": "no match"}
    elif action["action"] == "scroll":
        print(f"[local exec] Simulating scroll {action.get('direction')} by {action.get('amount')}px")
        return {"success": True, "executed": "scroll"}
    return {"success": False}


if __name__ == "__main__":
    print("=" * 70)
    print("Aegis PIPELINE SIMULATION (server + demo site are real; browser")
    print("extension steps are simulated in Python since no GUI is available)")
    print("=" * 70)

    html = fetch_page()
    redacted_fields, buttons, pii_elements = detect_and_redact(html)
    action = call_server(redacted_fields, buttons)
    exec_result = simulate_execution(html, action)

    print("\n" + "=" * 70)
    print("PRIVACY AGENT STATUS")
    print("=" * 70)
    print(f"PII detected:        {len(pii_elements)}")
    print(f"PII redacted:        {len(pii_elements)}")
    print(f"Raw screen sent:     NO")
    print(f"Sanitized screen:    YES")
    print(f"Server action:       {action['action'].upper()} {action.get('target') or action.get('direction')}")
    print(f"Local execution:     {'SUCCESS' if exec_result['success'] else 'FAILED'}")
