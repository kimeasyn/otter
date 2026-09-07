import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const temp = await mkdtemp(join(tmpdir(), "otter-release-smoke-"));
let child;
try {
  execFileSync("tar", [
    "-xzf",
    resolve("artifacts/otter-linux-x86_64.tar.gz"),
    "-C",
    temp,
  ]);
  const dir = join(temp, "otter-linux-x86_64");
  const env = {
    ...process.env,
    OTTER_BIND: "127.0.0.1:0",
    OTTER_DATA_DIR: join(temp, "data"),
    OTTER_AUTO_IMPORT: "0",
  };
  child = spawn(join(dir, "otter"), [], { cwd: dir, env, stdio: "ignore" });
  let connection;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error("Archive launcher exited unexpectedly");
    try {
      connection = JSON.parse(
        await readFile(join(temp, "data/connection.json"), "utf8"),
      );
      break;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(connection);
  assert.equal(
    execFileSync(join(dir, "otter"), ["--url"], {
      env,
      encoding: "utf8",
    }).trim(),
    `${connection.url}/#token=${connection.token}`,
  );
  const response = await fetch(connection.url + "/api/health", {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  assert.equal(response.status, 200);
  const html = await (await fetch(connection.url)).text();
  assert.match(html, /<title>Otter<\/title>/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(connection.url + asset)).status, 200);
  const exit = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exit;
  assert.throws(() => process.kill(connection.pid, 0));
  console.log(
    "PASS: downloaded-style archive extraction, launcher, private URL, authenticated API, bundled UI assets and shutdown cleanup",
  );
} finally {
  if (child?.exitCode === null && child?.signalCode === null)
    child.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
