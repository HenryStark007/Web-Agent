// Contract between the local extension (client) and the FastAPI server.
// Mirrored on the server side in server/schemas.py (Pydantic).
// Phase 3+4 scope: click, click_coordinate, scroll, type, wait, done.

export type ClickAction = {
  action: "click";
  target: string; // visible text/label of the element to click
  confidence?: number; // 0.0 - 1.0
  reason?: string;
  source?: "vlm" | "heuristic";
};

export type ClickCoordinateAction = {
  action: "click_coordinate";
  x: number; // viewport x coordinate
  y: number; // viewport y coordinate
  element_id?: string; // optional visual scene element id
  confidence?: number;
  reason?: string;
  source?: "vlm" | "heuristic";
};

export type ScrollAction = {
  action: "scroll";
  direction: "up" | "down";
  amount?: number; // pixels, default 400
  confidence?: number;
  reason?: string;
  source?: "vlm" | "heuristic";
};

export type TypeAction = {
  action: "type";
  target: string; // name/placeholder/aria-label of the input field
  text: string; // text to type
  confidence?: number;
  reason?: string;
  source?: "vlm" | "heuristic";
};

export type WaitAction = {
  action: "wait";
  duration?: number; // ms, default 1000
  reason?: string;
  source?: "vlm" | "heuristic";
};

export type DoneAction = {
  action: "done";
  reason?: string;
  source?: "vlm" | "heuristic";
};

export type AgentAction =
  | ClickAction
  | ClickCoordinateAction
  | ScrollAction
  | TypeAction
  | WaitAction
  | DoneAction;

// Visual Scene Element — produced by on-device visual perception (Phase 3)
export type VisualSceneElement = {
  id: string;
  visualBox: { x: number; y: number; width: number; height: number };
  classification: string;
  spatialRegion: string;
  domMatch: {
    id: string;
    tag: string;
    text: string;
    ariaLabel?: string;
    role?: string;
  } | null;
  domMatchIoU: number;
  confidence: number;
  source: "vision" | "dom" | "fused";
  ocrText?: string;
};

// Visual Scene Graph — full on-device perception output
export type VisualSceneGraph = {
  timestamp: number;
  viewport: { width: number; height: number };
  imageSize: { width: number; height: number };
  processingMs: number;
  totalElements: number;
  elementsBySource: {
    fused: number;
    visionOnly: number;
    domOnly: number;
  };
  elementsByType: Record<string, number>;
  elements: VisualSceneElement[];
};

// Request body sent from the client to POST /analyze
export type AnalyzeRequest = {
  task: string;
  // Already-redacted PNG data URL. NEVER a raw/unredacted screenshot.
  sanitized_screenshot_base64: string;
  sanitized_context: {
    redactedFields: string[];
    visibleActionableElements: string[];
    elements?: Array<Record<string, any>>; // DOM elements with rects
  };
};
