/**
 * BLOCK 3 — Local Privacy Filter (PERSON 2)
 *
 * Given the PII list from piiDetector.js, this module:
 *  1. Draws opaque black overlay boxes on top of every sensitive region
 *     so that a screenshot taken *after* this runs is already sanitized
 *     (raw pixels never leave the machine).
 *  2. Builds a sanitized text/DOM summary (values replaced with "[REDACTED]")
 *     to send alongside the screenshot as extra context for the server VLM.
 *
 * Exposes: window.__aegis.redact(piiList) -> { removeOverlays, sanitizedSummary, count }
 */
(function () {
  const OVERLAY_CLASS = "__aegis_redaction_overlay";

  function drawOverlays(piiList) {
    const overlays = [];
    for (const item of piiList) {
      const box = document.createElement("div");
      box.className = OVERLAY_CLASS;
      box.style.position = "fixed";
      box.style.left = `${item.rect.left}px`;
      box.style.top = `${item.rect.top}px`;
      box.style.width = `${item.rect.width}px`;
      box.style.height = `${item.rect.height}px`;
      box.style.background = "#000000";
      box.style.zIndex = "2147483647";
      box.style.pointerEvents = "none";
      box.setAttribute("data-pii-type", item.type);
      document.documentElement.appendChild(box);
      overlays.push(box);
    }
    return () => overlays.forEach((o) => o.remove());
  }

  function buildSanitizedSummary(piiList) {
    // A short, human-readable, already-redacted text context. This is the
    // "sanitized DOM/context" the server is allowed to see.
    const grouped = {};
    const piiValues = [];
    for (const item of piiList) {
      grouped[item.type] = (grouped[item.type] || 0) + 1;
      if (item.value) piiValues.push(item.value);
    }
    const lines = Object.entries(grouped).map(([type, count]) => `${type}: [REDACTED x${count}]`);

    const sanitizeFn = (window.__aegis && window.__aegis.sanitizeString) || ((s) => s);

    // Include non-sensitive, visible interactive elements (buttons/links)
    // so the server can still reason about what actions are possible.
    const actionable = Array.from(document.querySelectorAll("button, a, input[type=submit], [role=button]"))
      .map((el) => {
        const raw = el.textContent.trim() || el.value || el.getAttribute("aria-label") || "";
        return sanitizeFn(raw, piiValues);
      })
      .filter(Boolean)
      .slice(0, 30);

    return {
      redactedFields: lines,
      visibleActionableElements: actionable,
    };
  }

  function redact(piiList) {
    const removeOverlays = drawOverlays(piiList);
    const sanitizedSummary = buildSanitizedSummary(piiList);
    return { removeOverlays, sanitizedSummary, count: piiList.length };
  }

  window.__aegis = window.__aegis || {};
  window.__aegis.redact = redact;
  window.__aegis.buildSanitizedSummaryOnly = buildSanitizedSummary; // no overlay side effect
})();
