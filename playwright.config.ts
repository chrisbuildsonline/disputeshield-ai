import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// A throwaway database that starts empty on every run. Workers load this file too, so only the main process resets it.
const dbDir = join(tmpdir(), "disputeshield-e2e");
const db = join(dbDir, "e2e.db");
if (!process.env.TEST_WORKER_INDEX) {
  rmSync(dbDir, { recursive: true, force: true });
  mkdirSync(dbDir, { recursive: true });
}

const port = process.env.E2E_PORT || "8765";
// E2E_BASE_URL points at an already running server (the docker image), so no webServer is started
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  workers: 1, // one shared database, so tests run one after another
  // the request fixture (and the page) send the token too; the token spec clears this to act like a stranger
  use: { baseURL, extraHTTPHeaders: { Authorization: "Bearer e2e-token" } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: `bun run build && uv run uvicorn app.main:app --port ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: {
      DISPUTESHIELD_DEMO_MODE: "1",
      DISPUTESHIELD_DB: db,
      DISPUTESHIELD_OPERATOR_TOKEN: "e2e-token",
      // regex and template paths only: the e2e run never calls a model or PayPal
      DISPUTESHIELD_LLM: "off",
      ANTHROPIC_API_KEY: "",
      PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
      PAYPAL_WEBHOOK_ID: "",
    },
  },
});
