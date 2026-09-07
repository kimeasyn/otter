// Read-only validation of one stable, real local provider session. Never prints content.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const temp = await mkdtemp(join(tmpdir(), "otter-history-smoke-"));
const child = spawn(resolve("artifacts/dev/otterd"), [], {
  env: {
    ...process.env,
    OTTER_DATA_DIR: join(temp, "data"),
    OTTER_BIND: "127.0.0.1:0",
    OTTER_AUTO_IMPORT: "0",
    OTTER_WEB_DIR: resolve("apps/web/dist"),
  },
  stdio: "ignore",
});
try {
  let connection;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("History test daemon exited");
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
  const request = async (path, body) => {
    const r = await fetch(connection.url + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(
      r.status,
      200,
      "History API request failed (private detail withheld)",
    );
    return r.json();
  };
  const providers = await request("/providers");
  console.log(
    "Provider detection:",
    providers.map((p) => ({
      id: p.id,
      available: p.available,
      version: p.version,
      oneShot: p.capabilities.one_shot,
    })),
  );
  const discovered = await request("/history/discover");
  const candidates = [];
  for (const provider of ["codex", "claude"])
    for (const path of discovered[provider]) {
      const info = await stat(path);
      if (
        info.mtimeMs < Date.now() - 60000 &&
        info.size > 0 &&
        info.size < 20 * 1024 * 1024
      )
        candidates.push({ provider, path, size: info.size });
    }
  candidates.sort((a, b) => a.size - b.size);
  assert.ok(
    candidates.length,
    "No stable local provider JSONL under 20 MiB available",
  );
  const source = candidates[0];
  const before = createHash("sha256")
    .update(await readFile(source.path))
    .digest("hex");
  let result,
    inserted = 0,
    normalized = 0;
  for (let batch = 0; batch < 1000; batch++) {
    result = await request("/history/import", source);
    inserted += result.inserted;
    normalized += result.normalized;
    if (!result.has_more || !result.inserted) break;
  }
  assert.ok(inserted > 0 && normalized > 0);
  const repeated = await request("/history/import", source);
  assert.equal(repeated.inserted, 0);
  assert.equal(repeated.normalized, 0);
  for (const kind of [
    "conversation",
    "actions",
    "files",
    "commands",
    "timeline",
    "raw",
  ]) {
    const page = await request(
      `/sessions/${result.session_id}/events?kind=${kind}&limit=10`,
    );
    assert.ok(page.items.length <= 10);
    if (kind === "conversation")
      assert.ok(
        page.items.every((e) =>
          /^(user\.message|assistant\.message|assistant\.reasoning_summary)$/.test(
            e.kind,
          ),
        ),
      );
  }
  const after = createHash("sha256")
    .update(await readFile(source.path))
    .digest("hex");
  assert.equal(after, before, "Provider source changed during test");
  console.log(
    `PASS: real ${source.provider} history; ${inserted} raw / ${normalized} normalized records; repeat import inserted zero; source hash unchanged; paginated tabs responded. No private content printed.`,
  );
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGINT");
    await exited;
  }
  await rm(temp, { recursive: true, force: true });
}
