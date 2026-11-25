/**
 * PRIORITY 2 — Run the actual extension in a REAL Chrome browser.
 *
 * This does NOT download or bundle any browser (puppeteer-core has no
 * bundled Chromium). It launches YOUR ALREADY-INSTALLED Chrome with the
 * unpacked extension loaded via --load-extension, the same as doing it
 * by hand via chrome://extensions, just scripted so it's one command.
 *
 * Why this exists: a sandboxed dev environment (like the one this repo
 * was built in) typically has no GUI and no route to download a real
 * browser, so this step can only be verified on your own machine. This
 * script is what makes that a single command instead of 6 manual clicks.
 *
 * Usage:
 *   cd tools
 *   npm install
 *   node launch-chrome.js
 *
 * Requires: Google Chrome installed locally. Set CHROME_PATH env var if
 * it's not in one of the default locations this script checks.
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const EXTENSION_PATH = path.resolve(__dirname, "..", "extension");
const DEMO_SITE_URL = "http://127.0.0.1:5500";

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // macOS
    "/usr/bin/google-chrome", // Linux
    "/usr/bin/google-chrome-stable",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", // Windows
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      "Could not find Chrome automatically. Set CHROME_PATH env var to your chrome binary, e.g.\n" +
        "  CHROME_PATH='/usr/bin/google-chrome' node launch-chrome.js"
    );
  }
  return found;
}

async function main() {
  const chromePath = findChrome();
  console.log(`[launch-chrome] Using Chrome at: ${chromePath}`);
  console.log(`[launch-chrome] Loading extension from: ${EXTENSION_PATH}`);
  console.log(
    "[launch-chrome] NOTE: make sure the FastAPI server (port 8000) and demo site (port 5500) are already running."
  );

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false, // MUST be a real visible window: MV3 side panel + captureVisibleTab need a real render surface
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
    ],
  });

  const [page] = await browser.pages();
  await page.goto(DEMO_SITE_URL, { waitUntil: "networkidle2" });

  console.log("\n[launch-chrome] Real Chrome is open with the Aegis extension loaded.");
  console.log("[launch-chrome] Click the extension icon to open the side panel, then click 'Run Task'.");
  console.log("[launch-chrome] Close the Chrome window when done to end this script.\n");
}

main().catch((err) => {
  console.error("[launch-chrome] Failed:", err.message);
  process.exit(1);
});
