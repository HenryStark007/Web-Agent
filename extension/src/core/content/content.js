/**
 * Content script — message handler bridge between background.js and
 * the on-page modules (PII detection, redaction, visual perception,
 * action execution).
 *
 * Enhanced for Phase 3 (Visual Perception) + Phase 4 (Multi-Step Agent Loop).
 */
(function () {
  let removeOverlaysFn = null;
  let removePerceptionFn = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // ── Extract page DOM (sanitized) ─────────────────────────────────────
    if (msg.type === "EXTRACT_PAGE") {
      const pageData = window.__web.extractPage(msg.piiValues || []);
      sendResponse(pageData);
      return true;
    }

    // ── Redact for capture ───────────────────────────────────────────────
    if (msg.type === "REDACT_FOR_CAPTURE") {
      const piiList = window.__web.detectPII(document.body);
      const { removeOverlays, sanitizedSummary, count } = window.__web.redact(piiList);
      removeOverlaysFn = removeOverlays;
      const types = piiList.map((p) => p.type);
      sendResponse({ count, types, sanitizedSummary });
      return true;
    }

    // ── Remove redaction overlays ────────────────────────────────────────
    if (msg.type === "REMOVE_REDACTION") {
      if (removeOverlaysFn) {
        removeOverlaysFn();
        removeOverlaysFn = null;
      }
      sendResponse({ ok: true });
      return true;
    }

    // ── Get PII rects (DOM/regex) ────────────────────────────────────────
    if (msg.type === "GET_PII_RECTS") {
      // DOM/regex detection is the proven, always-on base layer.
      const piiList = window.__web.detectPII(document.body);
      const rects = piiList.map((p) => ({
        left: p.rect.left,
        top: p.rect.top,
        width: p.rect.width,
        height: p.rect.height,
        type: p.type,
        source: "dom",
      }));
      const sanitizedSummary = window.__web.buildSanitizedSummaryOnly(piiList);

      // Collect raw PII values for the client-side privacy guard.
      // These values stay on-device and are NEVER sent to the server.
      const piiValues = piiList
        .map((p) => (p.value || "").trim())
        .filter(Boolean);

      sendResponse({ rects, count: rects.length, sanitizedSummary, piiValues });
      return true;
    }

    // ── OCR detection ────────────────────────────────────────────────────
    if (msg.type === "ADD_OCR_RECTS") {
      window.__web
        .detectPIIFromScreenshot(msg.rawDataUrl)
        .then((ocrRects) => sendResponse({ rects: ocrRects }))
        .catch(() => sendResponse({ rects: [] }));
      return true; // async
    }

    // ── Redact screenshot pixels ─────────────────────────────────────────
    if (msg.type === "REDACT_SCREENSHOT") {
      window.__web
        .redactScreenshot(msg.rawDataUrl, msg.rects)
        .then((sanitizedDataUrl) => sendResponse({ sanitizedDataUrl }))
        .catch((e) => sendResponse({ error: String(e) }));
      return true; // async
    }

    // ── Execute action ───────────────────────────────────────────────────
    if (msg.type === "EXECUTE_ACTION") {
      const result = window.__web.executeAction(msg.action);
      sendResponse(result);
      return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: On-Device Visual Perception
    // ═══════════════════════════════════════════════════════════════════════

    // ── Analyze visual scene ─────────────────────────────────────────────
    if (msg.type === "ANALYZE_VISUAL_SCENE") {
      const domElements = msg.domElements || [];
      const ocrTokens = msg.ocrTokens || [];
      window.__web
        .analyzeVisualScene(msg.screenshotDataUrl, domElements, ocrTokens)
        .then((sceneGraph) => sendResponse({ sceneGraph }))
        .catch((e) => sendResponse({ error: String(e) }));
      return true; // async
    }

    // ── Render / clear perception overlay ─────────────────────────────────
    if (msg.type === "RENDER_PERCEPTION") {
      if (removePerceptionFn) {
        removePerceptionFn();
        removePerceptionFn = null;
      }
      if (msg.sceneGraph) {
        removePerceptionFn = window.__web.renderPerceptionOverlay(msg.sceneGraph);
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "CLEAR_PERCEPTION") {
      if (removePerceptionFn) {
        removePerceptionFn();
        removePerceptionFn = null;
      }
      document.querySelectorAll(".__web_perception_overlay").forEach(e => e.remove());
      sendResponse({ ok: true });
      return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4: State capture for multi-step loop
    // ═══════════════════════════════════════════════════════════════════════

    if (msg.type === "CAPTURE_STATE") {
      const snapshot = window.__web.captureStateSnapshot();
      sendResponse(snapshot);
      return true;
    }
  });
})();