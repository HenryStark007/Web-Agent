/**
 * BLOCK 3 (upgrade) — Screenshot-based local redaction (PERSON 2)
 *
 * Takes the RAW screenshot (captured by background.js via
 * chrome.tabs.captureVisibleTab BEFORE any redaction) and a list of PII
 * rects in CSS pixels (viewport coordinates), and paints solid black
 * rectangles directly onto those pixels using an offscreen <canvas>.
 *
 * This is the genuine "capture screen -> redact locally -> only then send"
 * flow: the image that leaves the machine is a pixel-level redaction of
 * the real screenshot, not a page that was pre-painted with CSS overlays
 * and then captured (that approach still worked, but coupled redaction
 * correctness to paint timing; this is more direct and auditable).
 *
 * Exposes: window.__aegis.redactScreenshot(rawDataUrl, rects) -> Promise<string dataUrl>
 */
(function () {
  async function redactScreenshot(rawDataUrl, rects) {
    const img = await loadImage(rawDataUrl);

    // chrome.tabs.captureVisibleTab captures at device pixel resolution,
    // while getBoundingClientRect() rects are in CSS px. Scale accordingly
    // so boxes line up with the actual sensitive content in the image.
    const scaleX = img.width / window.innerWidth;
    const scaleY = img.height / window.innerHeight;

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    ctx.fillStyle = "#000000";
    for (const r of rects) {
      ctx.fillRect(r.left * scaleX, r.top * scaleY, r.width * scaleX, r.height * scaleY);
    }

    return canvas.toDataURL("image/png");
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  window.__aegis = window.__aegis || {};
  window.__aegis.redactScreenshot = redactScreenshot;
})();
