import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const temp = await mkdtemp(join(tmpdir(), "otter-desktop-smoke-"));
const xvfb = spawn(
  "Xvfb",
  ["-displayfd", "3", "-screen", "0", "1440x1000x24"],
  { stdio: ["ignore", "ignore", "pipe", "pipe"] },
);
let app;
let errors = "";
let connection;
try {
  const display = await new Promise((resolve, reject) => {
    xvfb.stdio[3].once("data", (data) => resolve(data.toString().trim()));
    xvfb.once("error", reject);
  });
  const bundle = (await readdir("artifacts/desktop")).find((name) =>
    name.endsWith(".AppImage"),
  );
  assert.ok(bundle, "AppImage must be built first");
  app = spawn(
    resolve("artifacts/desktop", bundle),
    ["--appimage-extract-and-run"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DISPLAY: `:${display}`,
        XDG_DATA_HOME: join(temp, "data"),
        XDG_CONFIG_HOME: join(temp, "config"),
        OTTER_AUTO_IMPORT: "0",
        OTTER_DESKTOP_SMOKE_TEST: "1",
        WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1",
      },
    },
  );
  // Disabling the WebKit sandbox is confined to this disposable Docker/Xvfb test;
  // the distributable launcher does not set this environment variable.
  app.stderr.on("data", (data) => {
    errors += data;
  });
  const exited = new Promise((resolve) => app.once("exit", resolve));
  for (let i = 0; i < 150; i++) {
    if (app.exitCode !== null)
      throw new Error(`Desktop exited before readiness: ${errors}`);
    try {
      connection = JSON.parse(
        await readFile(
          join(temp, "data/dev.otter.desktop/connection.json"),
          "utf8",
        ),
      );
      break;
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(connection, `Desktop sidecar did not become ready: ${errors}`);
  const response = await fetch(connection.url + "/api/health", {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, "Otter");
  assert.match(
    await (await fetch(connection.url)).text(),
    /<title>Otter<\/title>/,
  );
  assert.equal(await exited, 0, errors);
  let stillRunning = false;
  try {
    process.kill(connection.pid, 0);
    stillRunning = true;
  } catch {
    /* expected */
  }
  assert.equal(stillRunning, false, "Desktop exit must stop its sidecar");
  console.log(
    "PASS: packaged Tauri AppImage starts under Xvfb, serves bundled UI through authenticated sidecar, and closes its daemon",
  );
} finally {
  if (app && app.exitCode === null) app.kill("SIGKILL");
  xvfb.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
