/**
 * BLOCK 2 (upgrade) — Local visual PII detection via real OCR (PERSON 1)
 *
 * Uses the bundled tesseract.js (vendor/tesseract/) to run actual OCR on
 * the RAW captured screenshot, so PII that is baked into pixels — e.g. a
 * <canvas> receipt, a scanned ID, text inside an <img> — can be detected
 * and redacted too, not just PII sitting in DOM text nodes.
 *
 * IMPORTANT / HONEST LIMITATION:
 * tesseract.js still needs to fetch its WASM core + trained-language data
 * at runtime (not bundled here — that payload is 10-15MB). It fetches
 * these from jsdelivr's public CDN by default. That means:
 *   - This requires the extension to have normal internet access when it
 *     runs in a real Chrome browser (fine for a demo laptop; not fine for
 *     a fully air-gapped deployment).
 *   - manifest.json's CSP must allow 'wasm-unsafe-eval' and connecting to
 *     the CDN (already added).
 *   - This module has NOT been exercised in a real Chrome instance in
 *     this development environment (no GUI browser available here — see
 *     README "Priority 2" notes). Treat it as implemented-but-unverified
 *     until you run it locally.
 *
 * This detector is ADDITIVE. Per priority 4, the existing DOM/regex
 * detector (piiDetector.js) remains the primary, proven path and always
 * runs; OCR results are unioned in on top when available, and any OCR
 * failure (offline, CDN blocked, timeout) is caught and simply skipped
 * so the pipeline never breaks because of it.
 *
 * Exposes: window.__aegis.detectPIIFromScreenshot(rawDataUrl) -> Promise<rects[]>
 */
(function () {
  const PII_TEXT_PATTERNS = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // email
    /\b(?:\d[ -]?){13,19}\b/, // credit-card-like
    /\b(?:\+?\d{1,3}[-\s]?)?\d{10}\b/, // phone
  ];

  const OCR_TIMEOUT_MS = 8000;

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("OCR timed out")), ms)),
    ]);
  }

  async function detectPIIFromScreenshot(rawDataUrl) {
    if (!window.Tesseract) {
      console.warn("[aegis-ocr] tesseract.js not loaded; skipping visual OCR detection (DOM fallback still applies)");
      return [];
    }

    try {
      const result = await withTimeout(
        window.Tesseract.recognize(rawDataUrl, "eng"),
        OCR_TIMEOUT_MS
      );

      const words = result?.data?.words || [];
      const rects = [];
      for (const w of words) {
        const text = w.text || "";
        const isPII = PII_TEXT_PATTERNS.some((re) => re.test(text));
        if (isPII && w.bbox) {
          // OCR bbox is in image-pixel space; caller (screenshotRedactor.js)
          // already expects rects in CSS px, so convert back down using the
          // same devicePixelRatio-derived scale used to capture the image.
          const scaleX = window.innerWidth / result.data.imageWidth || 1;
          const scaleY = window.innerHeight / result.data.imageHeight || 1;
          rects.push({
            left: w.bbox.x0 * scaleX,
            top: w.bbox.y0 * scaleY,
            width: (w.bbox.x1 - w.bbox.x0) * scaleX,
            height: (w.bbox.y1 - w.bbox.y0) * scaleY,
            type: "ocr_pii",
            source: "ocr",
          });
        }
      }
      console.log(`[aegis-ocr] OCR found ${rects.length} additional PII region(s) in image pixels`);
      return rects;
    } catch (e) {
      console.warn("[aegis-ocr] OCR detection failed/skipped, continuing with DOM-only detection:", e.message);
      return [];
    }
  }

  window.__aegis = window.__aegis || {};
  window.__aegis.detectPIIFromScreenshot = detectPIIFromScreenshot;
})();
