/**
 * PHASE 3 — On-Device Visual Perception Engine
 * Aegis: on-device visual perception for lightweight browser agents.
 *
 * This module implements a fully client-side computer vision pipeline that
 * analyzes screenshot pixels directly in the browser using the Canvas API.
 * No server calls, no cloud dependencies — everything runs on-device.
 *
 * Capabilities:
 *   1. Edge detection via Sobel gradient operators
 *   2. Adaptive luminance thresholding for UI component boundaries
 *   3. Connected-component bounding box extraction
 *   4. UI element classification (button, input, card, icon, link, image)
 *   5. Visual-DOM fusion — correlates visual boxes with DOM elements & OCR
 *   6. Visual Scene Graph generation for server/agent reasoning
 *
 * Exposes: window.__aegis.analyzeVisualScene(screenshotDataUrl, domElements, ocrTokens)
 */
(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────────
  const CONFIG = {
    EDGE_THRESHOLD: 40,       // Sobel gradient magnitude threshold
    MIN_BOX_WIDTH: 15,        // Minimum bounding box width in pixels
    MIN_BOX_HEIGHT: 12,       // Minimum bounding box height in pixels
    MAX_BOX_WIDTH_RATIO: 0.95,  // Max width as ratio of image width
    MAX_BOX_HEIGHT_RATIO: 0.9,  // Max height as ratio of image height
    MERGE_DISTANCE: 8,        // Pixel distance to merge nearby boxes
    DOM_OVERLAP_THRESHOLD: 0.3, // IoU threshold for visual-DOM matching
    MAX_VISUAL_ELEMENTS: 150, // Cap on visual elements to avoid overload
    DOWNSCALE_FACTOR: 2,      // Downscale for faster processing
  };

  // ── Image loading helper ───────────────────────────────────────────────
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // ── Grayscale conversion ───────────────────────────────────────────────
  function toGrayscale(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return gray;
  }

  // ── Sobel edge detection ───────────────────────────────────────────────
  function sobelEdges(gray, width, height) {
    const edges = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        // Horizontal Sobel kernel
        const gx =
          -gray[(y - 1) * width + (x - 1)] + gray[(y - 1) * width + (x + 1)]
          - 2 * gray[y * width + (x - 1)] + 2 * gray[y * width + (x + 1)]
          - gray[(y + 1) * width + (x - 1)] + gray[(y + 1) * width + (x + 1)];
        // Vertical Sobel kernel
        const gy =
          -gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + (x + 1)]
          + gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + (x + 1)];
        edges[idx] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return edges;
  }

  // ── Binary thresholding ────────────────────────────────────────────────
  function threshold(edges, width, height, thresh) {
    const binary = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      binary[i] = edges[i] > thresh ? 1 : 0;
    }
    return binary;
  }

  // ── Connected component labeling (simple flood-fill) ───────────────────
  function extractBoundingBoxes(binary, width, height) {
    const visited = new Uint8Array(width * height);
    const boxes = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (binary[idx] === 0 || visited[idx]) continue;

        // BFS flood fill
        let minX = x, maxX = x, minY = y, maxY = y;
        const queue = [idx];
        visited[idx] = 1;
        let pixelCount = 0;

        while (queue.length > 0) {
          const ci = queue.shift();
          const cy = Math.floor(ci / width);
          const cx = ci % width;
          pixelCount++;

          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);

          // 4-connectivity neighbors
          const neighbors = [
            cy > 0 ? (cy - 1) * width + cx : -1,
            cy < height - 1 ? (cy + 1) * width + cx : -1,
            cx > 0 ? cy * width + (cx - 1) : -1,
            cx < width - 1 ? cy * width + (cx + 1) : -1,
          ];

          for (const ni of neighbors) {
            if (ni >= 0 && !visited[ni] && binary[ni] === 1) {
              visited[ni] = 1;
              queue.push(ni);
            }
          }
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        if (bw >= CONFIG.MIN_BOX_WIDTH && bh >= CONFIG.MIN_BOX_HEIGHT
          && bw < width * CONFIG.MAX_BOX_WIDTH_RATIO
          && bh < height * CONFIG.MAX_BOX_HEIGHT_RATIO) {
          boxes.push({
            x: minX, y: minY, width: bw, height: bh,
            area: bw * bh, edgePixels: pixelCount,
          });
        }
      }
    }
    return boxes;
  }

  // ── Merge overlapping / nearby boxes ────────────────────────────────────
  function mergeBoxes(boxes, mergeDist) {
    if (boxes.length === 0) return [];
    // Sort by area descending
    boxes.sort((a, b) => b.area - a.area);

    const merged = [];
    const used = new Set();

    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i)) continue;
      let { x, y, width: w, height: h } = boxes[i];
      used.add(i);

      let changed = true;
      while (changed) {
        changed = false;
        for (let j = i + 1; j < boxes.length; j++) {
          if (used.has(j)) continue;
          const b = boxes[j];
          // Check overlap or proximity
          if (b.x <= x + w + mergeDist && b.x + b.width >= x - mergeDist &&
              b.y <= y + h + mergeDist && b.y + b.height >= y - mergeDist) {
            const nx = Math.min(x, b.x);
            const ny = Math.min(y, b.y);
            w = Math.max(x + w, b.x + b.width) - nx;
            h = Math.max(y + h, b.y + b.height) - ny;
            x = nx;
            y = ny;
            used.add(j);
            changed = true;
          }
        }
      }
      merged.push({ x, y, width: w, height: h, area: w * h });
    }
    return merged;
  }

  // ── UI Element Classification ──────────────────────────────────────────
  function classifyElement(box, imgWidth, imgHeight) {
    const aspectRatio = box.width / box.height;
    const relWidth = box.width / imgWidth;
    const relHeight = box.height / imgHeight;
    const relArea = (box.width * box.height) / (imgWidth * imgHeight);

    // Classify based on shape heuristics
    if (relArea > 0.15) return "card";
    if (relArea > 0.08) return "section";
    if (aspectRatio > 2.5 && relHeight < 0.08) return "input_field";
    if (aspectRatio > 1.5 && relHeight < 0.06 && relWidth < 0.25) return "button";
    if (aspectRatio >= 0.7 && aspectRatio <= 1.4 && box.width < 60 && box.height < 60) return "icon";
    if (aspectRatio >= 0.5 && aspectRatio <= 2.0 && relArea < 0.03) return "badge";
    if (relWidth > 0.6 && relHeight < 0.12) return "nav_bar";
    if (relHeight > 0.5 && relWidth < 0.25) return "sidebar";
    return "interactive";
  }

  // ── Spatial layout analysis ────────────────────────────────────────────
  function classifySpatialRegion(box, imgWidth, imgHeight) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const relX = cx / imgWidth;
    const relY = cy / imgHeight;

    if (relY < 0.12) return "top_bar";
    if (relY > 0.88) return "footer";
    if (relX < 0.2) return "left_rail";
    if (relX > 0.8) return "right_rail";
    if (relY > 0.35 && relY < 0.65 && relX > 0.3 && relX < 0.7) return "center_content";
    return "body";
  }

  // ── IoU (Intersection over Union) ──────────────────────────────────────
  function computeIoU(boxA, boxB) {
    const xA = Math.max(boxA.x, boxB.x);
    const yA = Math.max(boxA.y, boxB.y);
    const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
    const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    const areaA = boxA.width * boxA.height;
    const areaB = boxB.width * boxB.height;
    return interArea / (areaA + areaB - interArea);
  }

  // ── Visual-DOM Fusion ──────────────────────────────────────────────────
  function fuseWithDOM(visualBoxes, domElements, scaleFactor) {
    const fused = [];

    for (let i = 0; i < visualBoxes.length; i++) {
      const vb = visualBoxes[i];
      // Scale visual box back to page coordinates
      const scaledBox = {
        x: vb.x * scaleFactor,
        y: vb.y * scaleFactor,
        width: vb.width * scaleFactor,
        height: vb.height * scaleFactor,
      };

      let bestMatch = null;
      let bestIoU = 0;

      for (const domEl of (domElements || [])) {
        if (!domEl.rect) continue;
        const domBox = {
          x: domEl.rect.x,
          y: domEl.rect.y,
          width: domEl.rect.width,
          height: domEl.rect.height,
        };
        const iou = computeIoU(scaledBox, domBox);
        if (iou > bestIoU) {
          bestIoU = iou;
          bestMatch = domEl;
        }
      }

      const entry = {
        id: `vis_${i}`,
        visualBox: scaledBox,
        classification: vb.classification,
        spatialRegion: vb.spatialRegion,
        domMatch: null,
        domMatchIoU: 0,
        confidence: 0.5,
        source: "vision",
      };

      if (bestMatch && bestIoU > CONFIG.DOM_OVERLAP_THRESHOLD) {
        entry.domMatch = {
          id: bestMatch.id,
          tag: bestMatch.tag,
          text: bestMatch.text,
          ariaLabel: bestMatch.ariaLabel,
          role: bestMatch.role,
        };
        entry.domMatchIoU = Math.round(bestIoU * 100) / 100;
        entry.confidence = Math.min(0.95, 0.5 + bestIoU * 0.45);
        entry.source = "fused";
      }

      fused.push(entry);
    }

    // Add DOM-only elements that had no visual match
    for (const domEl of (domElements || [])) {
      const alreadyFused = fused.some(
        f => f.domMatch && f.domMatch.id === domEl.id
      );
      if (!alreadyFused && domEl.rect && domEl.visible) {
        fused.push({
          id: `dom_${domEl.id}`,
          visualBox: {
            x: domEl.rect.x, y: domEl.rect.y,
            width: domEl.rect.width, height: domEl.rect.height,
          },
          classification: domEl.tag === "button" || domEl.role === "button"
            ? "button"
            : domEl.tag === "input" ? "input_field"
            : domEl.tag === "a" ? "link"
            : "interactive",
          spatialRegion: classifySpatialRegion(domEl.rect,
            window.innerWidth, window.innerHeight),
          domMatch: {
            id: domEl.id, tag: domEl.tag, text: domEl.text,
            ariaLabel: domEl.ariaLabel, role: domEl.role,
          },
          domMatchIoU: 1.0,
          confidence: 0.85,
          source: "dom",
        });
      }
    }

    return fused;
  }

  // ── Fuse with OCR tokens ───────────────────────────────────────────────
  function fuseWithOCR(fused, ocrTokens) {
    if (!ocrTokens || ocrTokens.length === 0) return fused;
    for (const entry of fused) {
      const overlapping = ocrTokens.filter(tok => {
        if (!tok.left && !tok.x) return false;
        const tokBox = {
          x: tok.left || tok.x,
          y: tok.top || tok.y,
          width: tok.width || 50,
          height: tok.height || 16,
        };
        return computeIoU(entry.visualBox, tokBox) > 0.15;
      });
      if (overlapping.length > 0) {
        entry.ocrText = overlapping.map(t => t.text || t.value || "").join(" ").trim();
        if (!entry.domMatch) {
          entry.confidence = Math.min(0.9, entry.confidence + 0.15);
        }
      }
    }
    return fused;
  }

  // ── Main analysis function ─────────────────────────────────────────────
  async function analyzeVisualScene(screenshotDataUrl, domElements, ocrTokens) {
    const t0 = performance.now();

    // Load screenshot into canvas
    const img = await loadImage(screenshotDataUrl);
    const scale = CONFIG.DOWNSCALE_FACTOR;
    const w = Math.floor(img.width / scale);
    const h = Math.floor(img.height / scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    // Step 1: Grayscale
    const gray = toGrayscale(imageData);

    // Step 2: Edge detection
    const edges = sobelEdges(gray, w, h);

    // Step 3: Threshold
    const binary = threshold(edges, w, h, CONFIG.EDGE_THRESHOLD);

    // Step 4: Extract bounding boxes
    let rawBoxes = extractBoundingBoxes(binary, w, h);

    // Step 5: Merge overlapping boxes
    let mergedBoxes = mergeBoxes(rawBoxes, CONFIG.MERGE_DISTANCE);

    // Step 6: Classify each box
    mergedBoxes = mergedBoxes.map(box => ({
      ...box,
      classification: classifyElement(box, w, h),
      spatialRegion: classifySpatialRegion(box, w, h),
    }));

    // Cap to max elements
    mergedBoxes = mergedBoxes
      .sort((a, b) => b.area - a.area)
      .slice(0, CONFIG.MAX_VISUAL_ELEMENTS);

    // Step 7: Visual-DOM fusion
    let sceneElements = fuseWithDOM(mergedBoxes, domElements, scale);

    // Step 8: Fuse with OCR
    sceneElements = fuseWithOCR(sceneElements, ocrTokens);

    const tVision = performance.now() - t0;

    // Build the Visual Scene Graph
    const sceneGraph = {
      timestamp: Date.now(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      imageSize: { width: img.width, height: img.height },
      processingMs: Math.round(tVision),
      totalElements: sceneElements.length,
      elementsBySource: {
        fused: sceneElements.filter(e => e.source === "fused").length,
        visionOnly: sceneElements.filter(e => e.source === "vision").length,
        domOnly: sceneElements.filter(e => e.source === "dom").length,
      },
      elementsByType: {},
      elements: sceneElements,
    };

    // Count by type
    for (const el of sceneElements) {
      sceneGraph.elementsByType[el.classification] =
        (sceneGraph.elementsByType[el.classification] || 0) + 1;
    }

    return sceneGraph;
  }

  // ── Render debug overlay on page ───────────────────────────────────────
  function renderPerceptionOverlay(sceneGraph) {
    // Remove existing overlays
    document.querySelectorAll(".__aegis_perception_overlay").forEach(e => e.remove());

    const colors = {
      button: "rgba(76, 175, 80, 0.35)",
      input_field: "rgba(33, 150, 243, 0.35)",
      icon: "rgba(255, 193, 7, 0.4)",
      card: "rgba(156, 39, 176, 0.2)",
      link: "rgba(0, 188, 212, 0.3)",
      badge: "rgba(255, 87, 34, 0.35)",
      nav_bar: "rgba(96, 125, 139, 0.2)",
      interactive: "rgba(255, 255, 255, 0.2)",
      section: "rgba(121, 85, 72, 0.15)",
      sidebar: "rgba(63, 81, 181, 0.15)",
    };

    const borderColors = {
      button: "#4CAF50",
      input_field: "#2196F3",
      icon: "#FFC107",
      card: "#9C27B0",
      link: "#00BCD4",
      badge: "#FF5722",
      nav_bar: "#607D8B",
      interactive: "#FFFFFF",
      section: "#795548",
      sidebar: "#3F51B5",
    };

    for (const el of sceneGraph.elements) {
      const box = el.visualBox;
      if (!box || box.width < 5 || box.height < 5) continue;

      const overlay = document.createElement("div");
      overlay.className = "__aegis_perception_overlay";
      overlay.style.cssText = `
        position: fixed;
        left: ${box.x}px;
        top: ${box.y}px;
        width: ${box.width}px;
        height: ${box.height}px;
        background: ${colors[el.classification] || "rgba(255,255,255,0.15)"};
        border: 1.5px solid ${borderColors[el.classification] || "#fff"};
        z-index: 2147483640;
        pointer-events: none;
        border-radius: 3px;
        transition: opacity 0.3s;
      `;

      // Label
      const label = document.createElement("span");
      label.style.cssText = `
        position: absolute;
        top: -16px;
        left: 0;
        font-size: 9px;
        font-family: monospace;
        color: #fff;
        background: ${borderColors[el.classification] || "#333"};
        padding: 1px 4px;
        border-radius: 2px;
        white-space: nowrap;
        line-height: 12px;
      `;
      const displayText = el.domMatch?.text
        ? el.domMatch.text.slice(0, 20)
        : el.ocrText
          ? el.ocrText.slice(0, 20)
          : el.classification;
      label.textContent = `${el.classification} ${el.source === "fused" ? "⚡" : el.source === "dom" ? "📄" : "👁️"} ${displayText}`;
      overlay.appendChild(label);

      document.documentElement.appendChild(overlay);
    }

    return () => {
      document.querySelectorAll(".__aegis_perception_overlay").forEach(e => e.remove());
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.__aegis = window.__aegis || {};
  window.__aegis.analyzeVisualScene = analyzeVisualScene;
  window.__aegis.renderPerceptionOverlay = renderPerceptionOverlay;
})();
