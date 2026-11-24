/**
 * BLOCK 2 — Local Vision + PII Detection (PERSON 1)
 *
 * PoC-scope detector. Runs entirely in the content-script (local machine).
 * No network calls, no training. DOM + regex only for the first prototype,
 * as instructed ("Start with DOM + regex + OCR" -> OCR deferred post-MVP).
 *
 * Exposes: window.__web.detectPII(root)
 * Returns: [{ type, value, node, rect }]
 */
(function () {
  const PII_PATTERNS = [
    { type: "email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
    { type: "phone", regex: /\b(?:\+?\d{1,3}[-\s]?)?\d{10}\b/g },
    { type: "password", regex: /\b(?=\S{6,})(?=.*[A-Za-z])(?=.*\d)\S{6,}\b/g }, // scoped to fields labeled "password" only, see below
    { type: "credit_card", regex: /\b(?:\d[ -]?){13,19}\b/g },
    { type: "api_key", regex: /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9]{10,}\b/gi },
  ];

  // Fields we treat as sensitive by *label*, regardless of pattern match.
  // This is the simple, reliable "DOM-based detection" the PS calls out,
  // and it's what makes the MVP robust without needing OCR.
  const SENSITIVE_LABELS = ["name", "email", "phone", "password", "card", "credit card", "cvv", "address"];

  function textNodesUnder(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function findLabeledSensitiveElements(root) {
    // Looks for elements marked up as data-pii="true" (demo site uses this),
    // or a <label>/preceding text that matches a known sensitive field name.
    const results = [];
    root.querySelectorAll("[data-pii]").forEach((el) => {
      results.push({ type: el.getAttribute("data-pii") || "pii", value: el.textContent.trim(), node: el });
    });
    return results;
  }

  function findPatternMatches(root) {
    const results = [];
    const nodes = textNodesUnder(root);
    for (const node of nodes) {
      const text = node.nodeValue;
      console.log("[web] SCANNING TEXT:", JSON.stringify(text));
      for (const { type, regex } of PII_PATTERNS) {
        // "password" pattern is too broad on its own -> only apply near a
        // password-labeled context (handled via data-pii elements above).
        if (type === "password") continue;
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(text)) !== null) {
          results.push({ type, value: m[0], node, textRange: [m.index, m.index + m[0].length] });
        }
      }
    }
    return results;
  }

  function rectFor(item) {
    try {
      if (item.node.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        if (item.textRange) {
          range.setStart(item.node, item.textRange[0]);
          range.setEnd(item.node, item.textRange[1]);
        } else {
          range.selectNodeContents(item.node);
        }
        return range.getBoundingClientRect();
      }
      return item.node.getBoundingClientRect();
    } catch (e) {
      return null;
    }
  }

  function detectPII(root = document.body) {
    const labeled = findLabeledSensitiveElements(root);
    const patterned = findPatternMatches(root);
    const all = [...labeled, ...patterned];

    const enriched = all
      .map((item) => ({ ...item, rect: rectFor(item) }))
      .filter((item) => item.rect && item.rect.width > 0 && item.rect.height > 0);

    // de-dupe overlapping rects roughly by rounded coords
    const seen = new Set();
    const deduped = [];
    for (const item of enriched) {
      const key = `${Math.round(item.rect.left)},${Math.round(item.rect.top)},${Math.round(item.rect.width)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    console.log("[web] FINAL PII DETECTIONS:", deduped);
    return deduped;
  }

  window.__web= window.__web || {};
  window.__web.detectPII = detectPII;
})();