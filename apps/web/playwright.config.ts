import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  workers: 1,
  use: { headless: true, viewport: { width: 1440, height: 1000 } },
  reporter: "list",
  outputDir: "../../test-results",
});
