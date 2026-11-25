/**
 * Side panel UI logic for Aegis Privacy Vision Agent.
 * Enhanced for Phase 3 (Perception Inspector) + Phase 4 (Multi-Step Agent Loop).
 */

const $ = (id) => document.getElementById(id);
const logEl = $("log");

// ---------------------------------------------------------------------------
// PII type display names
// ---------------------------------------------------------------------------
const PII_LABELS = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  password: "Password",
  credit_card: "Credit Card",
  address: "Address",
  api_key: "API Key",
  ocr_pii: "OCR (image)",
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function appendLog(line) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.textContent = "";
}

// ---------------------------------------------------------------------------
// PII breakdown grid
// ---------------------------------------------------------------------------
function renderPIIBreakdown(breakdown, totalCount) {
  const grid = $("piiGrid");
  grid.innerHTML = "";

  if (!breakdown || totalCount === 0) {
    grid.innerHTML = '<div class="pii-type neutral" style="grid-column:1/-1;">No PII detected</div>';
    $("piiTotal").textContent = "0";
    $("piiTotal").className = "neutral";
    return;
  }

  const order = ["name", "email", "phone", "password", "credit_card", "address", "api_key", "ocr_pii"];
  const entries = Object.entries(breakdown).sort(([a], [b]) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const [type, count] of entries) {
    const typeDiv = document.createElement("div");
    typeDiv.className = "pii-type";
    typeDiv.textContent = PII_LABELS[type] || type;

    const countDiv = document.createElement("div");
    countDiv.className = "pii-count";
    countDiv.textContent = count;

    grid.appendChild(typeDiv);
    grid.appendChild(countDiv);
  }

  $("piiTotal").textContent = totalCount;
  $("piiTotal").className = totalCount > 0 ? "warn" : "neutral";
}

// ---------------------------------------------------------------------------
// Step progress (Phase 4)
// ---------------------------------------------------------------------------
let totalSteps = 1;
let currentStep = 0;

function initStepProgress(maxSteps) {
  totalSteps = maxSteps;
  currentStep = 0;
  const container = $("stepProgress");
  container.innerHTML = "";
  for (let i = 1; i <= maxSteps; i++) {
    const dot = document.createElement("div");
    dot.className = "step-dot";
    dot.id = `step_${i}`;
    dot.textContent = i;
    container.appendChild(dot);
  }
  $("stepPanel").style.display = "block";
  $("stepBadge").textContent = `0/${maxSteps}`;
}

function updateStepDot(step, state) {
  const dot = $(`step_${step}`);
  if (!dot) return;
  dot.className = `step-dot ${state}`;
  if (state === "done") dot.textContent = "✓";
  if (state === "failed") dot.textContent = "✗";
}

// ---------------------------------------------------------------------------
// Perception inspector (Phase 3)
// ---------------------------------------------------------------------------
function renderPerceptionData(sceneData) {
  if (!sceneData) return;

  $("perceptionPanel").style.display = "block";
  const grid = $("perceptionGrid");
  grid.innerHTML = "";

  const rows = [
    ["Total elements", sceneData.totalElements || 0],
    ["Fused (Vision + DOM)", sceneData.elementsBySource?.fused || 0],
    ["Vision-only", sceneData.elementsBySource?.visionOnly || 0],
    ["DOM-only", sceneData.elementsBySource?.domOnly || 0],
    ["Processing time", `${sceneData.processingMs || 0}ms`],
  ];

  for (const [label, value] of rows) {
    const lDiv = document.createElement("div");
    lDiv.className = "p-label";
    lDiv.textContent = label;
    const vDiv = document.createElement("div");
    vDiv.className = "p-value";
    vDiv.textContent = value;
    grid.appendChild(lDiv);
    grid.appendChild(vDiv);
  }

  // Type chips
  const chips = $("typeChips");
  chips.innerHTML = "";
  if (sceneData.elementsByType) {
    for (const [type, count] of Object.entries(sceneData.elementsByType)) {
      const chip = document.createElement("span");
      chip.className = `type-chip ${type}`;
      chip.textContent = `${type}: ${count}`;
      chips.appendChild(chip);
    }
  }
}

// ---------------------------------------------------------------------------
// Telemetry (Phase 3)
// ---------------------------------------------------------------------------
function updateTelemetry(timings, visionElements) {
  $("telemetryPanel").style.display = "block";
  if (timings.detectMs != null) $("telDetectMs").textContent = `${timings.detectMs}ms`;
  if (timings.visionMs != null) $("telVisionMs").textContent = `${timings.visionMs}ms`;
  if (timings.redactMs != null) $("telRedactMs").textContent = `${timings.redactMs}ms`;
  if (visionElements != null) $("telElements").textContent = visionElements;
}

// ---------------------------------------------------------------------------
// Message handler from background.js
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  // Before/After screenshots
  if (msg.type === "AEGIS_BEFORE_AFTER") {
    $("beforeAfterPanel").style.display = "block";
    $("beforeImg").src = msg.before;
    $("afterImg").src = msg.after;
    return;
  }

  // Telemetry
  if (msg.type === "AEGIS_TELEMETRY") {
    updateTelemetry(msg.timings || {}, msg.visionElements);
    return;
  }

  // Status messages
  if (msg.type !== "AEGIS_STATUS") return;
  appendLog(msg.message);

  // Multi-step tracking
  if (msg.currentStep && msg.totalSteps) {
    currentStep = msg.currentStep;
    $("stepBadge").textContent = `${msg.currentStep}/${msg.totalSteps}`;
    updateStepDot(msg.currentStep, "active");
    // Mark previous as done
    if (msg.currentStep > 1) {
      updateStepDot(msg.currentStep - 1, "done");
    }
  }

  if (msg.maxSteps && msg.multiStep) {
    initStepProgress(msg.maxSteps);
  }

  // PII breakdown
  if (msg.piiBreakdown !== undefined && msg.piiDetected !== undefined) {
    renderPIIBreakdown(msg.piiBreakdown, msg.piiDetected);
  }

  // Visual perception data (Phase 3)
  if (msg.sceneGraph) {
    renderPerceptionData(msg.sceneGraph);
  }

  // Privacy check status
  if (msg.privacyCheck === "PASSED") {
    $("privacyCheck").textContent = "PASSED \u2705";
    $("privacyCheck").className = "ok";
    $("rawPIISent").textContent = "NO \u274C";
    $("rawPIISent").className = "ok";
  } else if (msg.privacyCheck === "FAILED") {
    $("privacyCheck").textContent = "FAILED \u274C";
    $("privacyCheck").className = "bad";
    $("rawPIISent").textContent = "BLOCKED";
    $("rawPIISent").className = "bad";
  }

  // Sending status
  if (msg.step === "sending") {
    $("rawSent").textContent = "NO \u274C";
    $("rawSent").className = "ok";
    $("sanitizedSent").textContent = "YES \u2705";
    $("sanitizedSent").className = "ok";
  }

  // Server action
  if (msg.serverAction) {
    const a = msg.serverAction;
    const actionLabel = `${a.action.toUpperCase()} ${a.target || a.direction || ""}`.trim();
    $("serverAction").textContent = actionLabel;
    $("serverAction").className = "ok";

    if (a.source === "vlm") {
      $("reasoningSource").textContent = "Real VLM";
      $("reasoningSource").className = "ok";
    } else if (a.source === "heuristic") {
      $("reasoningSource").textContent = "Heuristic fallback";
      $("reasoningSource").className = "warn";
    } else {
      $("reasoningSource").textContent = a.source || "unknown";
      $("reasoningSource").className = "neutral";
    }

    if (a.confidence !== undefined && a.confidence !== null) {
      const pct = Math.round(a.confidence * 100);
      $("confidence").textContent = `${pct}%`;
      $("confidence").className = pct >= 70 ? "ok" : pct >= 40 ? "warn" : "bad";
    }
  }

  // Execution result
  if (msg.execResult) {
    if (msg.execResult.success) {
      $("execStatus").textContent = "SUCCESS \u2705";
      $("execStatus").className = "ok";
      if (currentStep > 0) updateStepDot(currentStep, "done");
    } else {
      $("execStatus").textContent = `FAILED: ${msg.execResult.error || "unknown"}`;
      $("execStatus").className = "bad";
      if (currentStep > 0) updateStepDot(currentStep, "failed");
    }
  }

  // Pipeline complete
  if (msg.pipelineComplete) {
    $("stepBadge").textContent = "DONE";
    $("stepBadge").className = "badge badge-green";
  }

  // Final step
  if (msg.finalStep) {
    $("stepBadge").textContent = `Done at ${msg.finalStep}`;
  }

  // Errors
  if (msg.pipelineError || msg.serverError || msg.step === "privacy_failed" || msg.step === "error") {
    const banner = $("errorBanner");
    banner.style.display = "block";
    banner.textContent = msg.message;
  }
});

// ---------------------------------------------------------------------------
// Reset dashboard
// ---------------------------------------------------------------------------
function resetDashboard() {
  clearLog();
  appendLog("Waiting for task...");
  $("errorBanner").style.display = "none";
  $("errorBanner").textContent = "";

  // PII panel
  $("piiGrid").innerHTML = '<div class="pii-type neutral" style="grid-column:1/-1;">Scanning...</div>';
  $("piiTotal").textContent = "0";
  $("piiTotal").className = "neutral";

  // Privacy status
  $("rawSent").textContent = "NO \u274C";
  $("rawSent").className = "ok";
  $("rawPIISent").textContent = "NO \u274C";
  $("rawPIISent").className = "ok";
  $("sanitizedSent").textContent = "\u2014";
  $("sanitizedSent").className = "neutral";
  $("privacyCheck").textContent = "\u2014";
  $("privacyCheck").className = "neutral";
  $("reasoningSource").textContent = "\u2014";
  $("reasoningSource").className = "neutral";
  $("serverAction").textContent = "\u2014";
  $("serverAction").className = "neutral";
  $("confidence").textContent = "\u2014";
  $("confidence").className = "neutral";
  $("execStatus").textContent = "\u2014";
  $("execStatus").className = "neutral";

  // Screenshots
  $("beforeAfterPanel").style.display = "none";
  $("beforeImg").src = "";
  $("afterImg").src = "";

  // Step progress
  $("stepPanel").style.display = "none";
  $("stepProgress").innerHTML = "";
  currentStep = 0;

  // Perception
  $("perceptionPanel").style.display = "none";
  $("perceptionGrid").innerHTML = "";
  $("typeChips").innerHTML = "";

  // Telemetry
  $("telemetryPanel").style.display = "none";
  $("telDetectMs").textContent = "—";
  $("telVisionMs").textContent = "—";
  $("telRedactMs").textContent = "—";
  $("telElements").textContent = "—";
}

// ---------------------------------------------------------------------------
// Run buttons
// ---------------------------------------------------------------------------
function runTask(multiStep) {
  const task = $("task").value.trim();
  const serverUrl = $("serverUrl").value.trim();
  if (!task) return;

  $("run").disabled = true;
  $("runMulti").disabled = true;
  resetDashboard();
  appendLog(multiStep ? "Starting multi-step agent loop..." : "Starting single-step pipeline...");

  if (multiStep) {
    initStepProgress(8);
  }

  chrome.runtime.sendMessage(
    {
      type: "AEGIS_RUN_TASK",
      task,
      serverUrl,
      multiStep: multiStep,
      maxSteps: multiStep ? 8 : 1,
    },
    (resp) => {
      $("run").disabled = false;
      $("runMulti").disabled = false;
      if (!resp || !resp.ok) {
        const errMsg = resp ? resp.error : "no response from background";
        appendLog(`PIPELINE ERROR: ${errMsg}`);
        $("errorBanner").style.display = "block";
        $("errorBanner").textContent = errMsg;
      } else {
        appendLog(multiStep ? "Multi-step agent loop finished." : "Pipeline finished.");
      }
    }
  );
}

$("run").addEventListener("click", () => runTask(false));
$("runMulti").addEventListener("click", () => runTask(true));

// ---------------------------------------------------------------------------
// Lightbox — click to enlarge Before / After screenshots
// ---------------------------------------------------------------------------
(function initLightbox() {
  const overlay = $("lightbox");
  const lbImg = $("lightboxImg");
  const lbLabel = $("lightboxLabel");

  function openLightbox(src, label) {
    lbImg.src = src;
    lbLabel.textContent = label;
    overlay.classList.add("active");
  }

  function closeLightbox() {
    overlay.classList.remove("active");
    lbImg.src = "";
  }

  $("beforeImg").addEventListener("click", () => {
    const src = $("beforeImg").src;
    if (src) openLightbox(src, "Before Redaction — Raw (Local Only)");
  });

  $("afterImg").addEventListener("click", () => {
    const src = $("afterImg").src;
    if (src) openLightbox(src, "After Redaction — Sanitized (Sent to Server)");
  });

  // Close on overlay click (but not on the image itself)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.classList.contains("lightbox-hint")) {
      closeLightbox();
    }
  });

  $("lightboxClose").addEventListener("click", closeLightbox);

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });
})();
