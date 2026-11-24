# Privacy-Aware Self-Learning Browser Agent

An intelligent browser agent that automates web tasks, protects sensitive information through on-device DOM and visual PII detection, and learns from successful executions to make repetitive browser automation faster and more efficient.

## Overview

Traditional browser agents often rely on repeated LLM reasoning to understand webpages and decide their next actions. This can increase execution time, API costs, and unnecessary exposure of sensitive information.

Our approach combines three capabilities:

1. **Privacy-Aware Perception:** Detects sensitive information locally through DOM inspection and screenshot-based detection. Sensitive visual regions are redacted before screenshots are transmitted to external models.
2. **Workflow Learning:** Records successful browser executions as structured, reusable workflows.
3. **Selective LLM Reasoning:** Replays known workflows without repeatedly invoking an LLM, while using LLM/VLM reasoning when new tasks or unexpected webpage changes require it.

The goal is to move from repeatedly reasoning through the same browser tasks to learning and reusing successful execution patterns.

---

## Core Architecture

The agent follows a DOM-first approach. Visual perception is used when the required information or interaction cannot be reliably handled through DOM extraction.

```text
                     USER
                       |
                       v
              NATURAL LANGUAGE TASK
                       |
                       v
              WORKFLOW ORCHESTRATOR
                       |
                       v
                WORKFLOW LOOKUP
                 /           \
                /             \
          FOUND                NOT FOUND
            |                     |
            v                     v
      RETRIEVE WORKFLOW       DOM EXTRACTION
            |                     |
            |                DOM SUFFICIENT?
            |                  /       \
            |                YES        NO
            |                 |          |
            |                 |      SCREENSHOT
            |                 |       CAPTURE
            |                 |          |
            |                 |     LOCAL PII
            |                 |     DETECTION
            |                 |          |
            |                 |     PIXEL-LEVEL
            |                 |      REDACTION
            |                 |          |
            |                 |     PRIVACY GUARD
            |                 |          |
            |                 |     SANITIZED
            |                 |    VISUAL CONTEXT
            |                 |          |
            |                 |      VLM / LLM
            |                 |       REASONING
            |                 |          |
            +-----------------+----------+
                              |
                              v
                     BROWSER EXECUTOR
                              |
                              v
                       ACTION EXECUTION
                              |
                              v
                     RESULT VERIFICATION
                              |
                     /                \
                  SUCCESS             FAILURE
                     |                  |
                     v                  v
              SAVE / UPDATE       RECOVERY OR
                WORKFLOW           LLM FALLBACK
                     |
                     v
                COMPLETED TASK
```

---

## 1. Privacy-Aware Perception

Sensitive information should be handled locally before any relevant webpage context is transmitted to an external LLM/VLM.

### Detection mechanisms

- DOM inspection: Extracts visible text, input values, labels, attributes and element metadata.
- Regex-based detection: Identifies patterns such as email addresses, phone numbers and other structured identifiers.
- Luhn validation: Helps identify potentially valid payment card numbers.
- Screenshot-based detection: Identifies sensitive information visible in rendered webpage content, including information that may not be accessible through the DOM.
- OCR: Extracts text from screenshots for additional visual PII detection.

### Local redaction pipeline

```text
Webpage / DOM / Screenshot
          |
          v
     Local PII Detection
          |
          v
   Identify Sensitive Regions
          |
          v
    Local Data Redaction
          |
          v
     Privacy Validation
          |
          v
  Sanitized Context / Image
          |
          v
       External LLM
```

### Privacy principles

- Raw screenshots are not transmitted.
- Sensitive visual regions are redacted locally before transmission.
- DOM-derived context is sanitized before being included in model requests.
- The privacy gate blocks requests that fail validation.
- Actual sensitive values needed for browser actions are handled locally by the execution layer.

The privacy layer is designed to minimize sensitive-data exposure, not to assume that any individual detector can identify every possible form of PII.

---

## 2. Workflow Learning and Replay

Instead of reasoning through every repeated task from scratch, the agent stores successful executions as structured workflows.

### First execution

```text
User Task
   |
   v
LLM / VLM Reasoning (when required)
   |
   v
Browser Action Execution
   |
   v
Result Verification
   |
   v
Successful Workflow
   |
   v
Store in Database
```

### Subsequent execution

```text
Similar User Task
   |
   v
Workflow Matching
   |
   v
Retrieve Stored Workflow
   |
   v
Check Preconditions
   |
   v
Replay Browser Actions
   |
   v
Verify Expected Results
   |
   v
Task Completed
```

### What gets stored?

A workflow contains structured execution information rather than just a sequence of clicks.

| Field                  | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| Task intent            | Describes what the workflow accomplishes                    |
| Website / page context | Identifies the relevant website and page                    |
| Action type            | Click, type, scroll, navigate, etc.                         |
| Target locator         | Selector or element identifier                              |
| Preconditions          | Expected webpage state before an action                     |
| Parameters             | Task-specific values, without unnecessarily storing raw PII |
| Postconditions         | Expected result after an action                             |
| Execution status       | Success, failure or recovery information                    |

### Intelligent fallback

Workflow replay is not assumed to work in every situation.

- Exact match: Replay the stored workflow.
- Minor webpage changes: Reinspect the DOM and attempt safe locator adaptation.
- Major changes or failed verification: Invoke LLM reasoning to recover or replan.
- Successful recovery: Update or version the stored workflow.

This allows the agent to reuse experience without blindly replaying outdated actions.

---

## 3. Browser Execution

The browser executor is responsible for interacting with the actual webpage.

Supported operations can include:

- Clicking elements.
- Typing into input fields.
- Scrolling.
- Navigating between pages.
- Reading webpage state.
- Verifying action outcomes.

DOM-based interaction is preferred when reliable. Visual reasoning is used when DOM inspection cannot provide the information required for the task.

All returned model actions are validated before execution. Consequential actions such as purchases, payments, submissions or deletions should require appropriate user authorization.

---

## 4. Technology Stack

| Component            | Technology                                 |
| -------------------- | ------------------------------------------ |
| Frontend             | Chrome Extension (Manifest V3), JavaScript |
| Browser interaction  | Chrome APIs, DOM inspection                |
| Backend              | Python, FastAPI                            |
| AI reasoning         | Pluggable LLM / VLM API                    |
| PII detection        | Regex, Luhn validation, DOM semantics, OCR |
| Screenshot redaction | Browser Canvas API                         |
| Workflow storage     | SQLite                                     |
| Workflow execution   | Structured action engine                   |
| Communication        | HTTP APIs / JSON                           |

The stack is intentionally lightweight and modular so that individual components can be replaced or extended.

---

## 5. Project Goals

- Reduce unnecessary LLM calls during repetitive browser tasks.
- Minimize exposure of sensitive information to external models.
- Combine DOM-based automation with visual perception.
- Learn reusable workflows from successful executions.
- Verify actions instead of blindly replaying them.
- Recover intelligently when webpages or execution conditions change.

---

## 6. Future Improvements

- More robust OCR and named-entity-based PII detection.
- Improved workflow similarity matching.
- Adaptive locator recovery.
- Website-independent workflow representation.
- Workflow analytics and execution benchmarking.
- Advanced privacy policies and user-controlled sensitive-data rules.
- Support for additional browsers and automation environments.

---

## Core Idea

**DOM-first. Vision when needed. Privacy before transmission. Learn once, reuse whenever reliable.**

A browser agent should not have to repeatedly reason through tasks it already knows how to perform, nor should sensitive information needlessly leave the user's device just to automate a webpage.
