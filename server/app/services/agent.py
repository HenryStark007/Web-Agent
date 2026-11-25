"""
Heuristic fallback "reasoner" — enhanced for Phase 3 + Phase 4.

Given the sanitized list of visible actionable elements AND the DOM
element structure (with bounding box coordinates from Phase 3), find
the best action for the user's task.

Supports: click, click_coordinate, type, scroll, done.
"""

import re

from app.models.schemas import AnalyzeRequest


def _extract_search_query(task: str) -> str:
    m = re.search(
        r"(?:search(?:\s+for)?|google|look up)\s+(.+)$",
        task.strip(),
        re.I,
    )
    if not m:
        return ""
    q = m.group(1).strip().strip("\"'")
    q = re.sub(r"\s+on\s+google.*$", "", q, flags=re.I)
    return q.rstrip(".").strip()


def _is_search_element(el: dict) -> bool:
    attrs = el.get("attributes") or {}
    name = (attrs.get("name") or "").lower()
    aria = (el.get("ariaLabel") or "").lower()
    placeholder = (attrs.get("placeholder") or "").lower()
    el_type = (el.get("type") or "").lower()
    tag = (el.get("tag") or "").lower()
    return (
        name == "q"
        or el_type == "search"
        or (tag in ("input", "textarea") and ("search" in aria or "search" in placeholder))
    )


def _score_element(el_text: str, task_lower: str) -> int:
    """Score an element's relevance to the task via keyword matching."""
    el_words = [w.strip(".,!?\"'").lower() for w in el_text.split() if len(w) > 2]
    return sum(1 for w in el_words if w in task_lower)


def heuristic_action(req: AnalyzeRequest) -> dict:
    task_lower = req.task.lower()
    elements = req.sanitized_context.visibleActionableElements
    dom_elements = req.sanitized_context.elements or []

    search_query = _extract_search_query(req.task)
    if search_query:
        search_el = next((el for el in dom_elements if _is_search_element(el)), None)
        if search_el:
            target = (
                search_el.get("ariaLabel")
                or (search_el.get("attributes") or {}).get("name")
                or "Search"
            )
            return {
                "action": "type",
                "target": target,
                "text": search_query,
                "confidence": 0.7,
                "reason": f"Heuristic: type search query into the page search box",
            }

    # ── Phase 1: Try DOM elements with coordinates (Phase 3 enhancement) ──
    best_dom, best_dom_score = None, 0
    for el in dom_elements:
        if not el.get("visible") or not el.get("enabled", True):
            continue
        el_text = el.get("text", "") or el.get("ariaLabel", "") or ""
        if not el_text.strip():
            continue
        score = _score_element(el_text, task_lower)
        if score > best_dom_score:
            best_dom_score = score
            best_dom = el

    # If we found a good DOM match with coordinates, use click
    if best_dom and best_dom_score > 0:
        target_text = (best_dom.get("text") or best_dom.get("ariaLabel") or "").strip()
        rect = best_dom.get("rect", {})

        # If it's an input and task suggests typing, return type action
        if best_dom.get("tag") in ("input", "textarea") and any(
            kw in task_lower for kw in ("type", "enter", "fill", "write", "search", "input")
        ):
            # Extract what to type from the task (simple heuristic)
            return {
                "action": "type",
                "target": target_text or best_dom.get("attributes", {}).get("name", ""),
                "text": "",  # VLM would fill this; heuristic leaves empty
                "confidence": 0.35,
                "reason": f"Heuristic: input field '{target_text}' matches task keywords",
            }

        return {
            "action": "click",
            "target": target_text,
            "confidence": min(0.6, 0.3 + best_dom_score * 0.1),
            "reason": f"Heuristic keyword match (DOM element with rect) for task: '{req.task}'",
        }

    # ── Phase 2: Fall back to text-only matching ──────────────────────────
    best, best_score = None, 0
    for el in elements:
        score = _score_element(el, task_lower)
        if score > best_score:
            best, best_score = el, score

    if best:
        return {
            "action": "click",
            "target": best,
            "confidence": 0.4,
            "reason": f"Heuristic keyword match for task: '{req.task}'",
        }

    # ── No match → scroll ─────────────────────────────────────────────────
    return {
        "action": "scroll",
        "direction": "down",
        "amount": 400,
        "confidence": 0.2,
        "reason": "No matching element found; scrolling to look for it.",
    }
