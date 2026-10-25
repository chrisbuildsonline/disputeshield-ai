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

export default defineConfig({
  testDir: "e2e",
  workers: 1, // one shared database, so tests run one after another
  use: { baseURL: "http://127.0.0.1:8765" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run build && uv run uvicorn app.main:app --port 8765",
    url: "http://127.0.0.1:8765/api/health",
    reuseExistingServer: false,
    env: {
      DISPUTESHIELD_DEMO_MODE: "1",
      DISPUTESHIELD_DB: db,
      // regex and template paths only: the e2e run never calls Claude or PayPal
      ANTHROPIC_API_KEY: "",
      PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
      PAYPAL_WEBHOOK_ID: "",
    },
  },
});
