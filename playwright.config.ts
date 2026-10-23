import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://127.0.0.1:8765" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run build && DISPUTESHIELD_DEMO_MODE=1 uv run uvicorn app.main:app --port 8765",
    url: "http://127.0.0.1:8765/api/health",
    reuseExistingServer: false,
  },
});
