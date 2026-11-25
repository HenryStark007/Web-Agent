/**
 * BLOCK 5 — Local Browser Action Execution (Enhanced for Phase 3 + 4)
 *
 * The server NEVER touches the browser directly. It only returns an
 * action JSON. This module is the only thing on the page allowed to
 * actually click/scroll/type, and it runs locally in the content script.
 *
 * Supported actions:
 *   - "click"             — Click by target text / aria-label
 *   - "click_coordinate"  — Click at precise (x, y) coordinates
 *   - "type"              — Focus an input and type text
 *   - "scroll"            — Scroll up/down
 *   - "wait"              — Wait for a specified duration
 *   - "done"              — Signal task completion
 *
 * If the target is not found, we fail safely and do NOT guess.
 */
(function () {
  // ── Visual click ripple effect ─────────────────────────────────────────
  function showClickRipple(x, y) {
    const ripple = document.createElement("div");
    ripple.className = "__aegis_click_ripple";
    ripple.style.cssText = `
      position: fixed;
      left: ${x - 20}px;
      top: ${y - 20}px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(76, 175, 80, 0.4);
      border: 2px solid #4CAF50;
      pointer-events: none;
      z-index: 2147483647;
      animation: __aegis_ripple 0.6s ease-out forwards;
    `;

    // Inject keyframe if not present
    if (!document.getElementById("__aegis_ripple_style")) {
      const style = document.createElement("style");
      style.id = "__aegis_ripple_style";
      style.textContent = `
        @keyframes __aegis_ripple {
          0% { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(2.5); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    document.documentElement.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  }

  // ── Find click target by text ──────────────────────────────────────────
  function findClickTarget(targetText) {
    if (!targetText) return null;
    const candidates = Array.from(
      document.querySelectorAll(
        "button, a, input[type=submit], input[type=button], " +
        "[role=button], [role=link], [role=tab], [role=menuitem], [role=option], " +
        "[onclick], [data-action], [tabindex], " +
        "li, td, tr, label, summary, details, " +
        "select, option, span[class], div[class]"
      )
    );
    const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const wanted = norm(targetText);

    // exact text/value match first
    let match = candidates.find((el) => norm(el.textContent) === wanted || norm(el.value) === wanted);
    if (!match) {
      // then partial/contains match
      match = candidates.find(
        (el) => norm(el.textContent).includes(wanted) || norm(el.value).includes(wanted)
      );
    }
    if (!match) {
      // try reverse: wanted contains the element's text (for short button labels)
      match = candidates.find((el) => {
        const t = norm(el.textContent);
        return t.length > 2 && wanted.includes(t);
      });
    }
    if (!match) {
      // try matching against aria-label
      match = candidates.find((el) => {
        const aria = norm(el.getAttribute("aria-label"));
        return aria === wanted || aria.includes(wanted);
      });
    }
    if (!match) {
      // try matching against title attribute
      match = candidates.find((el) => {
        const title = norm(el.getAttribute("title"));
        return title === wanted || title.includes(wanted);
      });
    }

    // ── Universal fallback: search ALL visible elements by text content ──
    if (!match) {
      const allElements = Array.from(document.querySelectorAll("*"));
      match = allElements.find((el) => {
        if (el.children.length > 3) return false; // skip large containers
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const t = norm(el.textContent);
        return t === wanted || (t.length < wanted.length * 2 && t.includes(wanted));
      });
    }

    return match || null;
  }


  // ── Find input target ──────────────────────────────────────────────────
  function visibleInputs() {
    return Array.from(
      document.querySelectorAll("input, textarea, select, [contenteditable='true']")
    ).filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });
  }

  function findSearchBox() {
    const inputs = visibleInputs();
    const named = inputs.find(
      (el) =>
        (el.getAttribute("name") || "").toLowerCase() === "q" ||
        (el.getAttribute("type") || "").toLowerCase() === "search" ||
        (el.getAttribute("role") || "").toLowerCase() === "combobox"
    );
    if (named) return named;
    return inputs.find((el) => {
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      return aria.includes("search") || ph.includes("search");
    }) || null;
  }

  function findInputTarget(targetText) {
    const inputs = visibleInputs();
    const norm = (s) => (s || "").trim().toLowerCase();
    const wanted = norm(targetText);

    if (!wanted || wanted.includes("search") || wanted === "q") {
      const searchBox = findSearchBox();
      if (searchBox) return searchBox;
    }

    if (!targetText) return findSearchBox();

    return inputs.find((el) => {
      const name = norm(el.getAttribute("name"));
      const placeholder = norm(el.getAttribute("placeholder"));
      const aria = norm(el.getAttribute("aria-label"));
      const title = norm(el.getAttribute("title"));
      const id = norm(el.id);
      const label = el.labels?.[0] ? norm(el.labels[0].textContent) : "";
      return [name, placeholder, aria, title, id, label].some(
        (v) => v && (v === wanted || v.includes(wanted) || wanted.includes(v))
      );
    }) || findSearchBox();
  }

  function setNativeValue(el, text) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
  }

  function isSearchField(el) {
    if (!el) return false;
    const name = (el.getAttribute("name") || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    return (
      name === "q" ||
      type === "search" ||
      role === "combobox" ||
      aria.includes("search")
    );
  }

  function submitWithEnter(el) {
    const init = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    const form = el.form || el.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit();
      } catch (_) {
        /* Google and other SPAs already handle Enter */
      }
    }
  }

  // ── Synthetic event dispatch for coordinate clicks ─────────────────────
  function dispatchSyntheticClick(el, x, y) {
    const eventInit = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
    };

    el.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", eventInit));
    el.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", eventInit));
    el.dispatchEvent(new MouseEvent("click", eventInit));
  }

  // ── Capture DOM snapshot for state change verification ─────────────────
  function captureStateSnapshot() {
    return {
      url: window.location.href,
      title: document.title,
      scrollY: window.scrollY,
      bodyText: document.body?.innerText?.slice(0, 500) || "",
      elementCount: document.querySelectorAll("*").length,
      timestamp: Date.now(),
    };
  }

  // ── Detect state change ────────────────────────────────────────────────
  function detectStateChange(before, after) {
    const changes = [];
    if (before.url !== after.url) changes.push(`url: ${before.url} → ${after.url}`);
    if (before.title !== after.title) changes.push(`title changed`);
    if (Math.abs(before.scrollY - after.scrollY) > 50) changes.push(`scrolled ${after.scrollY - before.scrollY}px`);
    if (before.elementCount !== after.elementCount) changes.push(`elements: ${before.elementCount} → ${after.elementCount}`);
    if (before.bodyText.slice(0, 200) !== after.bodyText.slice(0, 200)) changes.push("content changed");
    return {
      changed: changes.length > 0,
      changes,
    };
  }

  // ── Execute action ─────────────────────────────────────────────────────
  function executeAction(action) {
    if (!action || !action.action) {
      return { success: false, error: "No action provided" };
    }

    const beforeState = captureStateSnapshot();

    // ── CLICK (by text/label) ────────────────────────────────────────────
    if (action.action === "click") {
      if (!action.target) {
        return { success: false, error: "Click action has no target" };
      }
      const el = findClickTarget(action.target);
      if (!el) {
        return { success: false, error: `Action target not found: "${action.target}"` };
      }
      try {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        showClickRipple(cx, cy);
        el.click();
        const afterState = captureStateSnapshot();
        const stateChange = detectStateChange(beforeState, afterState);
        return { success: true, executed: "click", target: action.target, stateChange };
      } catch (e) {
        return { success: false, error: `Click failed: ${e.message}` };
      }
    }

    // ── CLICK COORDINATE ─────────────────────────────────────────────────
    if (action.action === "click_coordinate") {
      const x = action.x;
      const y = action.y;
      if (x == null || y == null) {
        return { success: false, error: "click_coordinate requires x and y" };
      }
      const el = document.elementFromPoint(x, y);
      if (!el) {
        return { success: false, error: `No element at (${x}, ${y})` };
      }
      try {
        showClickRipple(x, y);
        dispatchSyntheticClick(el, x, y);
        const afterState = captureStateSnapshot();
        const stateChange = detectStateChange(beforeState, afterState);
        return {
          success: true, executed: "click_coordinate",
          x, y, element: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().slice(0, 100),
          stateChange,
        };
      } catch (e) {
        return { success: false, error: `Coordinate click failed: ${e.message}` };
      }
    }

    // ── TYPE / INPUT ─────────────────────────────────────────────────────
    if (action.action === "type") {
      const target = action.target;
      const text = action.text || action.value || "";
      if (!target) {
        return { success: false, error: "Type action has no target" };
      }
      const el = findInputTarget(target) || findClickTarget(target);
      if (!el) {
        return { success: false, error: `Input target not found: "${target}"` };
      }
      try {
        el.focus();
        el.click();
        if ("value" in el) {
          setNativeValue(el, text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.contentEditable === "true") {
          el.textContent = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (action.submit !== false && (action.submit === true || isSearchField(el))) {
          submitWithEnter(el);
        }
        const afterState = captureStateSnapshot();
        const stateChange = detectStateChange(beforeState, afterState);
        return { success: true, executed: "type", target, textLength: text.length, submitted: isSearchField(el), stateChange };
      } catch (e) {
        return { success: false, error: `Type failed: ${e.message}` };
      }
    }

    // ── SCROLL ───────────────────────────────────────────────────────────
    if (action.action === "scroll") {
      const amount = action.amount || 400;
      const dir = action.direction === "up" ? -1 : 1;
      try {
        window.scrollBy({ top: dir * amount, behavior: "smooth" });
        const afterState = captureStateSnapshot();
        const stateChange = detectStateChange(beforeState, afterState);
        return { success: true, executed: "scroll", direction: action.direction || "down", amount, stateChange };
      } catch (e) {
        return { success: false, error: `Scroll failed: ${e.message}` };
      }
    }

    // ── WAIT ─────────────────────────────────────────────────────────────
    if (action.action === "wait") {
      return { success: true, executed: "wait", duration: action.duration || 1000 };
    }

    // ── DONE (task complete signal) ──────────────────────────────────────
    if (action.action === "done") {
      return { success: true, executed: "done", reason: action.reason || "Task completed" };
    }

    return { success: false, error: `Unsupported action type: "${action.action}"` };
  }

  window.__aegis = window.__aegis || {};
  window.__aegis.executeAction = executeAction;
  window.__aegis.captureStateSnapshot = captureStateSnapshot;
  window.__aegis.detectStateChange = detectStateChange;
})();
