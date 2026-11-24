/**
 * Generic webpage DOM extractor.
 * Runs entirely inside the browser with automatic PII sanitization.
 */

(function () {
  const PII_REGEXES = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email
    /\b(?:\+?\d{1,3}[-\s]?)?\d{10}\b/g, // Phone
    /\b(?:\d[ -]?){13,19}\b/g, // Credit Card
    /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9]{10,}\b/gi, // API keys
  ];

  function sanitizeString(str, piiValues = []) {
    if (!str || typeof str !== "string") return str;
    let sanitized = str;
    for (const val of piiValues) {
      if (val && typeof val === "string" && val.trim().length >= 3) {
        sanitized = sanitized.split(val.trim()).join("[REDACTED]");
      }
    }
    for (const regex of PII_REGEXES) {
      sanitized = sanitized.replace(regex, "[REDACTED]");
    }
    return sanitized;
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      parseFloat(style.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function cleanText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function getElementData(el, index, piiValues = []) {
    const rect = el.getBoundingClientRect();
    const isSensitive = el.getAttribute("data-pii") || el.getAttribute("type") === "password";

    const rawText = isSensitive ? "[REDACTED]" : cleanText(el.innerText || el.textContent).slice(0, 500);
    const text = sanitizeString(rawText, piiValues);
    const ariaLabel = sanitizeString(el.getAttribute("aria-label"), piiValues);
    const placeholder = sanitizeString(el.getAttribute("placeholder"), piiValues);
    const name = sanitizeString(el.getAttribute("name"), piiValues);
    const href = el.tagName.toLowerCase() === "a" ? sanitizeString(el.getAttribute("href"), piiValues) : null;

    return {
      id: `el_${index}`,
      tag: el.tagName.toLowerCase(),
      text,
      ariaLabel,
      role: el.getAttribute("role"),
      type: el.getAttribute("type"),
      visible: isVisible(el),
      enabled: !el.disabled,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      attributes: {
        name,
        placeholder,
        href
      }
    };
  }

  function extractPage(piiValues = []) {
    const elements = [];
    let index = 0;

    const selector = [
      "button",
      "a",
      "input",
      "select",
      "textarea",
      "[role='button']",
      "[role='link']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='tab']"
    ].join(",");

    document.querySelectorAll(selector).forEach((el) => {
      if (!isVisible(el)) return;
      elements.push(getElementData(el, index++, piiValues));
    });

    return {
      url: sanitizeString(window.location.href, piiValues),
      title: sanitizeString(document.title, piiValues),
      elements
    };
  }

  window.__web= window.__web || {};
  window.__web.extractPage = extractPage;
  window.__web.sanitizeString = sanitizeString;
})();