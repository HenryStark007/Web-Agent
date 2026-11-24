/**
 * Background service worker — the orchestrator.
 *
 * FULL PIPELINE (Phase 1-4):
 *   REAL CHROME
 *     -> SCREENSHOT (raw, captured once, held only in memory here)
 *     -> LOCAL VISION + PII DETECTION (DOM/regex + OCR)
 *     -> ON-DEVICE VISUAL PERCEPTION (Phase 3 — edge/contour CV)
 *     -> LOCAL REDACTION (black boxes painted onto screenshot pixels)
 *     -> PRIVACY GUARD (verify no raw PII in outgoing payload)
 *     -> SANITIZED SCREENSHOT + VISUAL SCENE GRAPH -> SERVER
 *     -> ACTION JSON
 *     -> LOCAL EXECUTION (click/scroll/type/coordinate)
 *     -> STATE VERIFICATION (Phase 4)
 *     -> LOOP (observe -> reason -> act -> verify) until done or max steps
 *
 * IMPORTANT PRIVACY BOUNDARY:
 * The raw screenshot captured in step 1 NEVER leaves this function's local
 * memory. Only the OUTPUT of redactScreenshot() is ever sent over the
 * network — and only AFTER the privacy guard confirms no raw PII values
 * appear in the outgoing payload.
 */

const DEFAULT_SERVER_URL = "http://127.0.0.1:8000/analyze";
const MAX_AGENT_STEPS = 8;
const STEP_DELAY_MS = 1500; // delay between multi-step iterations

// ---------------------------------------------------------------------------
// Known PII test values — used by the privacy guard to verify the outgoing
// payload does NOT contain raw sensitive data. Populated from detection at
// runtime so they always reflect the actual page.
// ---------------------------------------------------------------------------
const KNOWN_DEMO_PII_VALUES = [
  "John Doe",
  "john@example.com",
  "9876543210",
  "Secret123",
  "4111 1111 1111 1111",
  "123 Demo Street, New Delhi",
  "Amit Kumar",
  "amit@example.com",
];

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // side panel may not be open
}

function logStep(step, message, extra) {
  const msg = { type: "STATUS", step, message, ...(extra || {}) };
  broadcast(msg);
  console.log(`[web] [${step}] ${message}`);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// PRIVACY GUARD — runs before EVERY network request to the server.
// Inspects the outgoing JSON payload and blocks it if any known raw PII
// value appears anywhere in the serialized body.
// ---------------------------------------------------------------------------
function runPrivacyGuard(payload, detectedPIIValues) {
  const payloadStr = JSON.stringify(payload);
  const allValuesToCheck = [
    ...KNOWN_DEMO_PII_VALUES,
    ...detectedPIIValues,
  ];

  const leakedValues = [];
  for (const val of allValuesToCheck) {
    if (!val || val.length < 3) continue;
    if (payloadStr.includes(val)) {
      leakedValues.push(val);
    }
  }

  return {
    passed: leakedValues.length === 0,
    leakedValues,
  };
}

// ---------------------------------------------------------------------------
// SINGLE STEP — one observe-reason-act cycle
// ---------------------------------------------------------------------------
async function runSingleStep(tab, task, serverUrl, stepNum, detectedPIIValues) {
  const stepLabel = `Step ${stepNum}`;
  const timings = {};

  // ====================================================================
  // OBSERVE: Capture screenshot
  // ====================================================================
  const tCapture = performance.now();
  logStep("capturing", `[${stepLabel}] Capturing screenshot...`);
  const rawScreenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  timings.captureMs = Math.round(performance.now() - tCapture);

  // ====================================================================
  // OBSERVE: Local PII detection (DOM/regex + OCR)
  // ====================================================================
  const tDetect = performance.now();
  logStep("detecting", `[${stepLabel}] Detecting PII locally (DOM + regex)...`);
  const domResult = await chrome.tabs.sendMessage(tab.id, { type: "GET_PII_RECTS" });

  let ocrRects = [];
  try {
    const ocrResult = await chrome.tabs.sendMessage(tab.id, {
      type: "ADD_OCR_RECTS",
      rawDataUrl: rawScreenshot,
    });
    ocrRects = ocrResult?.rects || [];
  } catch (e) {
    console.warn("[web] OCR unavailable, continuing with DOM-only:", e);
  }

  const allRects = [...domResult.rects, ...ocrRects];
  const stepPIIValues = [...(detectedPIIValues || []), ...(domResult.piiValues || [])];
  // Deduplicate
  const uniquePII = [...new Set(stepPIIValues)];
  timings.detectMs = Math.round(performance.now() - tDetect);

  const piiBreakdown = {};
  for (const r of domResult.rects) {
    piiBreakdown[r.type] = (piiBreakdown[r.type] || 0) + 1;
  }

  logStep("detected", `[${stepLabel}] PII: ${allRects.length} (${domResult.rects.length} DOM + ${ocrRects.length} OCR)`, {
    piiDetected: allRects.length,
    piiRedacted: allRects.length,
    domCount: domResult.rects.length,
    ocrCount: ocrRects.length,
    piiBreakdown,
  });

  // ====================================================================
  // OBSERVE: Extract sanitized DOM context
  // ====================================================================
  const domContext = await chrome.tabs.sendMessage(tab.id, {
    type: "EXTRACT_PAGE",
    piiValues: uniquePII,
  });

  // ====================================================================
  // PHASE 3: On-Device Visual Perception
  // ====================================================================
  const tVision = performance.now();
  logStep("vision", `[${stepLabel}] Running on-device visual perception...`);
  let sceneGraph = null;
  try {
    const visionResult = await chrome.tabs.sendMessage(tab.id, {
      type: "ANALYZE_VISUAL_SCENE",
      screenshotDataUrl: rawScreenshot,
      domElements: domContext?.elements || [],
      ocrTokens: ocrRects,
    });
    sceneGraph = visionResult?.sceneGraph || null;
  } catch (e) {
    console.warn("[web] Visual perception failed, continuing without:", e);
  }
  timings.visionMs = sceneGraph ? Math.round(performance.now() - tVision) : 0;

  if (sceneGraph) {
    logStep("vision_done", `[${stepLabel}] Visual scene: ${sceneGraph.totalElements} elements (${sceneGraph.elementsBySource?.fused || 0} fused, ${sceneGraph.elementsBySource?.visionOnly || 0} vision, ${sceneGraph.elementsBySource?.domOnly || 0} DOM) in ${sceneGraph.processingMs}ms`, {
      sceneGraph: {
        totalElements: sceneGraph.totalElements,
        elementsBySource: sceneGraph.elementsBySource,
        elementsByType: sceneGraph.elementsByType,
        processingMs: sceneGraph.processingMs,
      },
    });

    // Render perception overlay on page
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "RENDER_PERCEPTION",
        sceneGraph,
      });
    } catch (e) { /* ignore */ }
  }

  // ====================================================================
  // REDACT: Paint black boxes onto the screenshot
  // ====================================================================
  const tRedact = performance.now();
  logStep("redacting", `[${stepLabel}] Redacting screenshot locally...`);
  const { sanitizedDataUrl } = await chrome.tabs.sendMessage(tab.id, {
    type: "REDACT_SCREENSHOT",
    rawDataUrl: rawScreenshot,
    rects: allRects,
  });
  timings.redactMs = Math.round(performance.now() - tRedact);

  logStep("redacted", `[${stepLabel}] Sanitized screenshot ready`);

  // Show before/after in side panel
  broadcast({
    type: "BEFORE_AFTER",
    before: rawScreenshot,
    after: sanitizedDataUrl,
  });

  // ====================================================================
  // BUILD PAYLOAD
  // ====================================================================
  const payload = {
    task,
    sanitized_screenshot_base64: sanitizedDataUrl,
    sanitized_context: {
      ...domResult.sanitizedSummary,
      elements: domContext?.elements || [],
    },
  };

  // ====================================================================
  // PRIVACY GUARD
  // ====================================================================
  const privacyResult = runPrivacyGuard(payload, uniquePII);

  if (!privacyResult.passed) {
    const errMsg = `[${stepLabel}] Privacy check FAILED — ${privacyResult.leakedValues.length} value(s). BLOCKED.`;
    logStep("privacy_failed", errMsg, {
      privacyCheck: "FAILED",
      leakedCount: privacyResult.leakedValues.length,
    });
    throw new Error("Privacy check failed — request blocked.");
  }

  logStep("privacy_passed", `[${stepLabel}] Privacy check PASSED`, {
    privacyCheck: "PASSED",
  });

  // ====================================================================
  // SEND TO SERVER
  // ====================================================================
  logStep("sending", `[${stepLabel}] Sending sanitized data to server...`, {
    rawSent: false,
    sanitizedSent: true,
  });

  let response;
  try {
    response = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    logStep("server_error", `[${stepLabel}] Server unavailable: ${networkErr.message}`, { serverError: true });
    throw new Error(`Server unavailable: ${networkErr.message}`);
  }

  if (!response.ok) {
    const errText = await response.text();
    logStep("server_error", `[${stepLabel}] Server error ${response.status}`, { serverError: true });
    throw new Error(`Server error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const action = await response.json();

  if (!action || !action.action) {
    logStep("invalid_action", `[${stepLabel}] Server returned no action`, { serverAction: null });
    throw new Error("Server returned an invalid/empty action");
  }

  const validActions = ["click", "click_coordinate", "scroll", "type", "wait", "done"];
  if (!validActions.includes(action.action)) {
    logStep("unsupported_action", `[${stepLabel}] Unsupported: ${action.action}`, { serverAction: action });
    throw new Error(`Unsupported action type: ${action.action}`);
  }

  logStep("server_responded", `[${stepLabel}] Action: ${action.action.toUpperCase()} ${action.target || action.direction || ""} (source: ${action.source || "unknown"})`, {
    serverAction: action,
  });

  // ====================================================================
  // EXECUTE ACTION LOCALLY
  // ====================================================================
  // Handle "wait" action specially
  if (action.action === "wait") {
    const waitMs = action.duration || 1000;
    logStep("waiting", `[${stepLabel}] Waiting ${waitMs}ms...`);
    await sleep(waitMs);
    return { action, execResult: { success: true, executed: "wait" }, timings, sceneGraph, piiBreakdown, privacyResult, sanitizedDataUrl, uniquePII, continueLoop: true };
  }

  // Handle "done" action — stop the loop
  if (action.action === "done") {
    logStep("done", `[${stepLabel}] Task marked COMPLETE — ${action.reason || ""}`, { execResult: { success: true, executed: "done" } });
    return { action, execResult: { success: true, executed: "done" }, timings, sceneGraph, piiBreakdown, privacyResult, sanitizedDataUrl, uniquePII, continueLoop: false };
  }

  const execResult = await chrome.tabs.sendMessage(tab.id, {
    type: "EXECUTE_ACTION",
    action,
  });

  if (execResult.success) {
    logStep("executed", `[${stepLabel}] ${action.action.toUpperCase()} SUCCESS${execResult.stateChange?.changed ? " — state changed" : ""}`, {
      execResult,
    });
  } else {
    logStep("exec_failed", `[${stepLabel}] FAILED — ${execResult.error}`, { execResult });
  }

  // Clean up perception overlay after action
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_PERCEPTION" });
  } catch (e) { /* ignore */ }

  // Broadcast step timings
  broadcast({
    type: "TELEMETRY",
    step: stepNum,
    timings,
    visionElements: sceneGraph?.totalElements || 0,
  });

  return {
    action, execResult, timings, sceneGraph, piiBreakdown, privacyResult,
    sanitizedDataUrl, uniquePII,
    continueLoop: execResult.success,
  };
}

// ---------------------------------------------------------------------------
// MAIN PIPELINE — Multi-Step Agent Loop (Phase 4)
// ---------------------------------------------------------------------------
async function runPipeline(task, serverUrl, maxSteps) {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab found");

  const steps = maxSteps || MAX_AGENT_STEPS;
  let detectedPIIValues = [];
  let lastResult = null;

  logStep("pipeline_start", `Starting multi-step pipeline (max ${steps} steps)`, {
    maxSteps: steps,
    multiStep: true,
  });

  for (let stepNum = 1; stepNum <= steps; stepNum++) {
    logStep("step_start", `═══ Step ${stepNum}/${steps} ═══`, {
      currentStep: stepNum,
      totalSteps: steps,
    });

    try {
      lastResult = await runSingleStep(tab, task, serverUrl, stepNum, detectedPIIValues);

      // Accumulate detected PII across steps
      if (lastResult.uniquePII) {
        detectedPIIValues = [...new Set([...detectedPIIValues, ...lastResult.uniquePII])];
      }

      // Check if loop should continue
      if (!lastResult.continueLoop) {
        logStep("loop_end", `Agent loop ended at step ${stepNum} — ${lastResult.action?.action === "done" ? "task completed" : "action failed"}`, {
          finalStep: stepNum,
        });
        break;
      }

      // If this is not the last step, wait before next iteration
      if (stepNum < steps) {
        logStep("step_wait", `Waiting ${STEP_DELAY_MS}ms before next observation...`);
        await sleep(STEP_DELAY_MS);
      }

    } catch (err) {
      logStep("step_error", `Step ${stepNum} error: ${err.message}`, { stepError: true });
      // Don't break on step errors in multi-step mode — let the next step retry
      if (stepNum >= steps) {
        throw err;
      }
      await sleep(STEP_DELAY_MS);
    }
  }

  if (lastResult) {
    logStep("pipeline_done", `Pipeline completed — ${lastResult.action?.action || "unknown"} was last action`, {
      pipelineComplete: true,
    });
  }

  return lastResult || {};
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RUN_TASK") {
    const maxSteps = msg.maxSteps || (msg.multiStep ? MAX_AGENT_STEPS : 1);
    runPipeline(msg.task, msg.serverUrl || DEFAULT_SERVER_URL, maxSteps)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => {
        const errMsg = err && err.message ? err.message : String(err);
        console.error("[web] Pipeline error:", errMsg);
        logStep("error", `PIPELINE ERROR: ${errMsg}`, { pipelineError: true });
        sendResponse({ ok: false, error: errMsg });
      });
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});