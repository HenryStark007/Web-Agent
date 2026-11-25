"""
BLOCK 4 — Server-side VLM/LLM integration (PERSON 3)

Sends only the SANITIZED screenshot + sanitized context to a configurable
VLM/LLM and asks it to return one structured action (click/scroll for MVP).

Configuration via .env (see .env.example):
    MODEL_API_KEY=
    MODEL_NAME=claude-sonnet-4-6
    MODEL_PROVIDER=anthropic   # "anthropic" or "gemini"

If MODEL_API_KEY is not set, this module falls back to the simple
heuristic agent in agent.py so the end-to-end demo still runs without
any API key configured (useful for the first days of development).

Every returned action is tagged with `source` ("vlm" or "heuristic") so
the client dashboard can show truthfully which reasoning path ran.
"""

import json
import os
import time as _time

import httpx

from pathlib import Path
from dotenv import load_dotenv

# Explicitly load server/.env (the one with actual API keys), not server/app/.env
_env_path = Path(__file__).resolve().parent.parent.parent / ".env"
load_dotenv(_env_path, override=True)


from app.services.agent import heuristic_action
from app.models.schemas import (
    AnalyzeRequest,
    ClickAction,
    ClickCoordinateAction,
    DoneAction,
    ErrorResponse,
    ScrollAction,
    TypeAction,
    WaitAction,
)


MODEL_API_KEY = os.getenv("MODEL_API_KEY", "")
MODEL_NAME = os.getenv("MODEL_NAME", "claude-sonnet-4-6")
MODEL_PROVIDER = os.getenv("MODEL_PROVIDER", "anthropic")

# When provider is "gemini", MODEL_NAME is used directly (e.g. "gemini-3.6-flash").
# The hard-coded default "claude-sonnet-4-6" is only relevant for MODEL_PROVIDER=anthropic.

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
VLM_TIMEOUT_SEC = 900
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

SYSTEM_PROMPT = (
    "You are the server-side reasoning component of a privacy-preserving "
    "browser agent. You are shown a SCREENSHOT THAT HAS ALREADY BEEN "
    "REDACTED LOCALLY (black boxes cover all sensitive fields) plus a list "
    "of visible actionable elements. Given the user's task, respond with "
    "ONLY a single JSON object — no prose, no markdown fences, no "
    "explanation outside the JSON.\n\n"
    "You are part of a MULTI-STEP agent loop. Each time you are called, you see the CURRENT "
    "state of the page. Return the SINGLE BEST next action to make progress on the task. "
    "When the task is fully complete, return a 'done' action.\n\n"
    "Supported action schemas (pick exactly one):\n"
    '{"action": "click", "target": "<exact visible button/link text>", '
    '"confidence": <0.0-1.0>, "reason": "<one sentence>"}\n'
    '{"action": "click_coordinate", "x": <int>, "y": <int>, '
    '"confidence": <0.0-1.0>, "reason": "<one sentence>"}\n'
    '{"action": "type", "target": "<input name/placeholder/aria-label>", '
    '"text": "<text to type>", "confidence": <0.0-1.0>, "reason": "<one sentence>"}\n'
    '{"action": "scroll", "direction": "up"|"down", "amount": 400, '
    '"confidence": <0.0-1.0>, "reason": "<one sentence>"}\n'
    '{"action": "wait", "duration": <ms 100-10000>, "reason": "<one sentence>"}\n'
    '{"action": "done", "reason": "<why the task is complete>"}\n\n'
    "Rules:\n"
    "- For 'click', 'target' MUST exactly match the text, ariaLabel, or value of one of the provided actionable elements.\n"
    "- For 'type', 'target' should match the input's name, placeholder, or aria-label. 'text' is what to type.\n"
    "- For 'click_coordinate', use x/y pixel coordinates from the element bounding boxes provided.\n"
    "- Use 'type' when the task involves searching, filling forms, entering text, or typing into any input field.\n"
    "- On Google (or any search page), if a search box is visible and the user asked to search/look up something, "
    "use 'type' with target matching the search box (often name 'q' or aria-label 'Search') and put the query in 'text'. "
    "Typing into a search box submits automatically — do not also click a Search button in the same step.\n"
    "- After results appear, click the best matching result link for the task, then use 'done' when the goal is met.\n"
    "- Use 'done' when you can see that the task has been completed successfully.\n"
    "- 'confidence' is your estimated certainty (0.0 to 1.0).\n"
    "- Do NOT return JavaScript, HTML, or any code — JSON only.\n"
    "- Do NOT return more than one action.\n"
    "- If you cannot determine a specific action, return a scroll action to explore more of the page.\n"
)


def _strip_markdown_fences(raw: str) -> str:
    """Remove markdown code fences that VLMs sometimes wrap around JSON."""
    text = raw.strip()
    for prefix in ("```json", "```JSON", "```"):
        if text.startswith(prefix):
            text = text[len(prefix):]
            break
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()


def _validate_action_dict(parsed: dict) -> dict:
    """
    Validate the raw dict from the VLM using Pydantic models.
    Returns the validated, serialised dict (model_dump) or raises ValueError.
    """
    action_type = parsed.get("action")

    if action_type == "click":
        model = ClickAction(**parsed)
        if not model.target or not model.target.strip():
            raise ValueError("Click action has empty target")
        return model.model_dump()

    if action_type == "click_coordinate":
        model = ClickCoordinateAction(**parsed)
        return model.model_dump()

    if action_type == "scroll":
        model = ScrollAction(**parsed)
        return model.model_dump()

    if action_type == "type":
        model = TypeAction(**parsed)
        if not model.target or not model.target.strip():
            raise ValueError("Type action has empty target")
        return model.model_dump()

    if action_type == "wait":
        model = WaitAction(**parsed)
        return model.model_dump()

    if action_type == "done":
        model = DoneAction(**parsed)
        return model.model_dump()

    raise ValueError(f"Unsupported action type from VLM: {action_type!r}")


# ── Gemini provider ─────────────────────────────────────────────────────────

# DOM-Only Gemini VLM Function

async def _call_gemini(req: AnalyzeRequest) -> dict:
    """
    Call Google Gemini Multimodal VLM with the sanitized screenshot + context.
    Provides visual grounding, element recognition, and precise browser action.
    """
    prefix, _, b64 = req.sanitized_screenshot_base64.partition(",")
    if not b64:
        b64 = req.sanitized_screenshot_base64

    n_redacted = len(req.sanitized_context.redactedFields)
    n_actionable = len(req.sanitized_context.visibleActionableElements)
    elements_summary = [
        {"id": el.get("id"), "tag": el.get("tag"), "text": el.get("text", "")[:80], "aria": el.get("ariaLabel"), "type": el.get("type"), "rect": el.get("rect")}
        for el in (req.sanitized_context.elements or [])[:40]
    ]

    print("[vlm] --- Outgoing Multimodal VLM request (Gemini) ---")
    print(f"[vlm]   Task: {req.task!r}")
    print(f"[vlm]   Redacted fields: {n_redacted}")
    print(f"[vlm]   Actionable elements count: {n_actionable}")
    print(f"[vlm]   Sanitized screenshot attached: YES ({len(b64)} chars)")

    prompt_text = (
        "You are an expert browser agent navigating a webpage.\n"
        "You are provided with a SANITIZED SCREENSHOT (all sensitive PII is blacked out) and extracted page elements.\n"
        "You are part of a MULTI-STEP agent loop — you will be called repeatedly with updated screenshots. "
        "Return the SINGLE BEST next action to make progress. Return 'done' when the task is fully complete.\n\n"
        f"USER TASK: {req.task}\n\n"
        f"VISIBLE ACTIONABLE ELEMENTS (sample):\n{json.dumps(req.sanitized_context.visibleActionableElements[:35], indent=2)}\n\n"
        f"PAGE DOM ELEMENTS WITH BOUNDING BOXES:\n{json.dumps(elements_summary[:30], indent=2)}\n\n"
        "INSTRUCTIONS:\n"
        "1. Understand the user's task carefully. Break it down into individual steps if needed.\n"
        "2. Examine the screenshot AND the element list to identify the exact button, link, search box, or input needed for the NEXT step.\n"
        "3. If searching or typing is needed (e.g. typing into a search box, filling a form field), return a 'type' action with the exact text to enter.\n"
        "4. If clicking a specific item/row/link/button is needed, return a 'click' action with target matching the EXACT text or label from the elements list.\n"
        "5. If you need to click but the text doesn't uniquely identify the element, use 'click_coordinate' with x/y from the bounding box center.\n"
        "6. If the page is loading or transitioning, return a 'wait' action.\n"
        "7. If the task is complete (you can see the expected result on screen), return a 'done' action.\n"
        "8. If you need to see more of the page, return a 'scroll' action.\n\n"
        "Return ONLY a single raw JSON object matching one of these formats:\n"
        '{"action": "click", "target": "<exact text/label of element>", "confidence": 0.9, "reason": "<reason>"}\n'
        '{"action": "click_coordinate", "x": 350, "y": 200, "confidence": 0.85, "reason": "<reason>"}\n'
        '{"action": "type", "target": "<input placeholder/name/label>", "text": "<text to type>", "confidence": 0.9, "reason": "<reason>"}\n'
        '{"action": "scroll", "direction": "down"|"up", "amount": 400, "confidence": 0.8, "reason": "<reason>"}\n'
        '{"action": "wait", "duration": 1500, "reason": "<reason>"}\n'
        '{"action": "done", "reason": "<reason task is complete>"}\n'
    )

    parts = []
    if b64 and len(b64) > 100:
        parts.append({
            "inline_data": {
                "mime_type": "image/png",
                "data": b64
            }
        })
    parts.append({"text": prompt_text})

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 500,
        }
    }

    # Candidate models in priority order (verified active on Google AI Studio)
    candidate_models = [MODEL_NAME, "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"]
    candidate_models = list(dict.fromkeys([m for m in candidate_models if m]))

    last_err = None
    for model_cand in candidate_models:
        clean_model = model_cand.replace("models/", "")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{clean_model}:generateContent?key={MODEL_API_KEY}"
        print(f"[vlm]   Trying Gemini model: {clean_model} ...")
        t0 = _time.monotonic()

        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                resp = await client.post(
                    url,
                    headers={"x-goog-api-key": MODEL_API_KEY, "Content-Type": "application/json"},
                    json=payload,
                )
            elapsed = _time.monotonic() - t0
            print(f"[vlm]   HTTP {resp.status_code} in {elapsed:.1f}s")

            if resp.status_code == 200:
                data = resp.json()
                candidates = data.get("candidates", [])
                if not candidates:
                    raise ValueError("Gemini returned no candidates")
                parts_out = candidates[0].get("content", {}).get("parts", [])
                text_blocks = [p["text"] for p in parts_out if "text" in p]
                if not text_blocks:
                    raise ValueError("Gemini returned no text content")
                raw = "\n".join(text_blocks).strip()
                print(f"[vlm] Raw Gemini output: {raw[:300]}")
                cleaned = _strip_markdown_fences(raw)
                parsed = json.loads(cleaned)
                validated = _validate_action_dict(parsed)
                print(f"[vlm] Validated action from {clean_model}: {validated}")
                return validated

            if resp.status_code == 404:
                print(f"[vlm] Model {clean_model} returned 404, trying next candidate...")
                continue
            if resp.status_code in (401, 403):
                raise PermissionError(f"Invalid API key ({resp.status_code} from Gemini): {resp.text[:200]}")
            
            print(f"[vlm] Gemini error {resp.status_code}: {resp.text[:300]}")
            last_err = RuntimeError(f"Gemini error {resp.status_code}: {resp.text[:200]}")
        except PermissionError:
            raise
        except Exception as ex:
            print(f"[vlm] Error attempting {clean_model}: {ex}")
            last_err = ex

    if last_err:
        raise last_err
    raise RuntimeError("All Gemini model candidates failed")

# ── Anthropic provider ──────────────────────────────────────────────────────


async def _call_anthropic(req: AnalyzeRequest) -> dict:
    """
    Call the Anthropic Messages API with the sanitized screenshot + context.
    Returns a validated action dict on success, raises on any failure.

    Privacy guarantee: only the SANITIZED (already redacted) screenshot is
    ever included in this request. The raw screenshot never reaches this
    function — it is captured and held client-side only.
    """
    # sanitized_screenshot_base64 is a data URL: "data:image/png;base64,XXXX"
    prefix, _, b64 = req.sanitized_screenshot_base64.partition(",")
    if not b64:
        raise ValueError("sanitized_screenshot_base64 contains no base64 data after comma")

    # Diagnostic logging — prove what we're sending WITHOUT leaking content
    img_size_kb = len(b64) * 3 / 4 / 1024  # approximate decoded size
    n_redacted = len(req.sanitized_context.redactedFields)
    n_actionable = len(req.sanitized_context.visibleActionableElements)
    print(f"[vlm] --- Outgoing VLM request ---")
    print(f"[vlm]   Image: {prefix},... ({len(b64)} base64 chars ≈ {img_size_kb:.1f} KB decoded)")
    print(f"[vlm]   Task: {req.task!r}")
    print(f"[vlm]   Redacted fields: {n_redacted} ({req.sanitized_context.redactedFields})")
    print(f"[vlm]   Actionable elements: {n_actionable} ({req.sanitized_context.visibleActionableElements})")
    print(f"[vlm]   Raw screenshot sent: NO (only sanitized image)")
    print(f"[vlm]   Calling {MODEL_PROVIDER}/{MODEL_NAME} ...")

    payload = {
        "model": MODEL_NAME,
        "max_tokens": 300,
        "system": SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": b64},
                    },
                    {
                        "type": "text",
                        "text": (
                            f"Task: {req.task}\n"
                            f"Redacted fields on screen: {req.sanitized_context.redactedFields}\n"
                            f"Visible actionable elements: {req.sanitized_context.visibleActionableElements}\n"
                            "Return the single best next action as JSON only."
                        ),
                    },
                ],
            }
        ],
    }
    headers = {
        "x-api-key": MODEL_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    t0 = _time.monotonic()

    async with httpx.AsyncClient(timeout=VLM_TIMEOUT_SEC) as client:
        resp = await client.post(ANTHROPIC_URL, headers=headers, json=payload)

    elapsed = _time.monotonic() - t0
    print(f"[vlm]   HTTP {resp.status_code} in {elapsed:.1f}s")

    if resp.status_code == 401:
        raise PermissionError("Invalid API key (401 from Anthropic)")
    if resp.status_code == 429:
        raise RuntimeError("VLM rate limit exceeded (429)")
    if resp.status_code >= 400:
        print(f"[vlm] Anthropic error body: {resp.text[:2000]}")
        raise RuntimeError(
            f"Anthropic API error ({resp.status_code}): {resp.text[:1000]}"
        )

    data = resp.json()

    # Extract the text block from the response
    text_blocks = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
    if not text_blocks:
        raise ValueError("VLM returned no text content")

    raw = "\n".join(text_blocks).strip()
    print(f"[vlm] Raw VLM output: {raw[:300]}")

    # Strip markdown fences and parse JSON
    cleaned = _strip_markdown_fences(raw)

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise ValueError(f"VLM output is not valid JSON: {e}")

    if not isinstance(parsed, dict):
        raise ValueError(f"VLM output is not a JSON object: {type(parsed).__name__}")

    # Validate with Pydantic (raises ValueError on schema mismatch)
    validated = _validate_action_dict(parsed)
    print(f"[vlm] Validated action: {validated}")
    return validated


async def get_next_action(req: AnalyzeRequest) -> dict:
    """
    PRIORITY 1: a real VLM call is the primary reasoning path whenever
    MODEL_API_KEY is configured (Gemini or Anthropic). The server never
    receives anything but the sanitized screenshot + sanitized context.

    The heuristic keyword-matcher (agent.py) is kept ONLY as a resilience
    fallback: it fires if no key is configured, or if all configured VLM
    providers error out mid-demo.

    Returns a validated action dict tagged with `source` = "vlm" or "heuristic".
    """
    # ── Try Gemini if configured ──────────────────────────────────────────
    if MODEL_API_KEY and MODEL_PROVIDER == "gemini":
        try:
            action = await _call_gemini(req)
            action["source"] = "vlm"
            print(f"[vlm] SUCCESS (gemini) — action={action['action']}, source=vlm")
            return action
        except PermissionError as e:
            print(f"[vlm] GEMINI AUTH FAILED: {e} — falling back")
        except httpx.TimeoutException:
            print(f"[vlm] GEMINI TIMEOUT ({VLM_TIMEOUT_SEC}s) — falling back")
        except httpx.ConnectError:
            print("[vlm] GEMINI CONNECT ERROR — cannot reach Gemini API, falling back")
        except Exception as e:
            print(f"[vlm] GEMINI ERROR: {type(e).__name__}: {e} — falling back")

    # ── Try Anthropic if configured ───────────────────────────────────────
    if MODEL_API_KEY and MODEL_PROVIDER == "anthropic":
        try:
            action = await _call_anthropic(req)
            action["source"] = "vlm"
            print(f"[vlm] SUCCESS (anthropic) — action={action['action']}, source=vlm")
            return action
        except PermissionError as e:
            print(f"[vlm] ANTHROPIC AUTH FAILED: {e} — falling back")
        except httpx.TimeoutException:
            print(f"[vlm] ANTHROPIC TIMEOUT ({VLM_TIMEOUT_SEC}s) — falling back")
        except httpx.ConnectError:
            print("[vlm] ANTHROPIC CONNECT ERROR — cannot reach Anthropic API, falling back")
        except Exception as e:
            print(f"[vlm] ANTHROPIC ERROR: {type(e).__name__}: {e} — falling back")

    # ── Fallback path ─────────────────────────────────────────────────────
    fallback = heuristic_action(req)
    fallback["source"] = "heuristic"
    print(f"[vlm] FALLBACK — action={fallback['action']}, source=heuristic")
    return fallback
