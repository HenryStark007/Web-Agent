from pathlib import Path
from dotenv import load_dotenv

# Explicitly load server/.env (the one with actual API keys)
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path, override=True)  # loads MODEL_API_KEY / MODEL_NAME / MODEL_PROVIDER

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.models.schemas import AnalyzeRequest, ErrorResponse
from app.services.vlm import (
    ANTHROPIC_URL,
    GEMINI_API_URL,
    MODEL_API_KEY,
    MODEL_NAME,
    MODEL_PROVIDER,
    VLM_TIMEOUT_SEC,
    get_next_action,
)

app = FastAPI(title="Aegis Privacy-Preserving Vision Agent — Server")

_mode = (
    f"REAL VLM ({MODEL_PROVIDER}/{MODEL_NAME})"
    if MODEL_API_KEY and MODEL_PROVIDER in ("gemini", "anthropic")
    else "HEURISTIC FALLBACK (no MODEL_API_KEY set)"
)
print(f"[startup] Reasoning mode: {_mode}")

# The demo Chrome extension calls this from a background service worker,
# which has no origin restrictions, but CORS is opened for local testing
# via curl / a future web-based test harness too.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    """
    Reports the current reasoning mode and VLM configuration.
    Use this to verify whether the server will use the real VLM or
    the heuristic fallback before running the demo.
    """
    key_configured = bool(MODEL_API_KEY)
    if key_configured and MODEL_PROVIDER == "gemini":
        active_model = MODEL_NAME
        active_url = GEMINI_API_URL.format(model=MODEL_NAME)
    elif key_configured and MODEL_PROVIDER == "anthropic":
        active_model = MODEL_NAME
        active_url = ANTHROPIC_URL
    else:
        active_model = None
        active_url = None

    return {
        "status": "ok",
        "reasoning_mode": _mode,
        "vlm_configured": key_configured,
        "model_provider": MODEL_PROVIDER if key_configured else None,
        "model_name": active_model,
        "api_url": active_url,
        "timeout_sec": VLM_TIMEOUT_SEC,
    }


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """
    Receives ONLY sanitized (already locally-redacted) visual context.
    Returns a single structured action for the local client to execute.

    Privacy boundary: the server NEVER receives raw screenshots or raw PII
    values. That is enforced client-side (privacy guard in background.js);
    on the server side we simply trust whatever arrives here is already
    sanitized — this endpoint would be meaningless with raw data anyway
    since the VLM needs to see what the page looks like *after* redaction
    to reason about the remaining visible elements.
    """
    print(f"\n[server] POST /analyze — task: {req.task!r}")
    print(f"[server]   redacted fields: {req.sanitized_context.redactedFields}")
    print(f"[server]   actionable elements: {req.sanitized_context.visibleActionableElements[:5]}...")

    # Defensive: re-verify the screenshot is a data URL (Pydantic already
    # validates this via the field_validator in AnalyzeRequest, but defence
    # in depth is cheap and the error is more readable).
    if not req.sanitized_screenshot_base64.startswith("data:image"):
        raise HTTPException(
            status_code=400,
            detail=ErrorResponse(
                error="invalid_screenshot",
                detail="sanitized_screenshot_base64 must be a data:image/... URL",
            ).model_dump(),
        )

    try:
        action = await get_next_action(req)
    except Exception as e:
        print(f"[server] UNEXPECTED error in get_next_action: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=500,
            detail=ErrorResponse(
                error="reasoning_failed",
                detail=f"Server failed to produce an action: {type(e).__name__}: {e}",
                source="error",
            ).model_dump(),
        )

    print(f"[server] Returning action: {action}")
    return action
