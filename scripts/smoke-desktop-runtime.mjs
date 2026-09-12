import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// 개발용 Electron의 Node 모드에서 실행한다. 배포 바이너리의 RunAsNode 제한은 변경하지 않는다.
if (!process.versions.electron) {
  const require = createRequire(
    new URL("../apps/desktop/package.json", import.meta.url),
  );
  const child = spawn(
    require("electron"),
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exit(code);
}
assert.equal(
  process.argv.length,
  3,
  "사용법: electron scripts/smoke-desktop-runtime.mjs <app.asar 경로>",
);
const archive = resolve(process.argv[2]);
const { startServer } = await import(
  pathToFileURL(join(archive, "apps/worker/src/server.mjs"))
);
const { workerBundle } = await import(
  pathToFileURL(join(archive, "apps/worker/src/remote.mjs"))
);
const { saveRecordBackup } = await import(
  pathToFileURL(join(archive, "apps/desktop/src/backup.mjs"))
);
const directory = await mkdtemp(join(tmpdir(), "otter-desktop-runtime-"));
const workerDirectory = join(directory, "worker");
const options = {
  directory: workerDirectory,
  port: 0,
  makeCodex: () => {
    throw new Error("런타임 검사에서 모델 호출 금지");
  },
};
let app = await startServer(options);
try {
  const request = async (path, input) => {
    const response = await fetch(app.origin + "/api/" + path, {
      ...(input === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(input) }),
      headers: {
        Authorization: `Bearer ${app.token}`,
        "Content-Type": "application/json",
      },
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${response.status}`);
    return result;
  };
  const root = await fetch(app.origin);
  assert.equal(root.status, 200);
  const html = await root.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
  assert.ok(assets.length >= 2);
  for (const asset of assets)
    assert.equal((await fetch(app.origin + asset[1])).status, 200);
  assert.equal((await fetch(app.origin + "/api/state")).status, 401);
  const company = await request("companies", {
    name: "설치 런타임 검사",
    mode: "single",
  });
  const project = await request("projects", {
    companyId: company.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  await access(join(project.root, ".git"));
  const bundle = await workerBundle();
  assert.ok(
    bundle.files["server.mjs"] &&
      bundle.files["headless.mjs"] &&
      bundle.files["codex.mjs"],
  );
  assert.match(bundle.version, /^[a-f0-9]{64}$/);
  await app.close();
  await assert.rejects(access(join(workerDirectory, "worker.lock")), {
    code: "ENOENT",
  });
  app = await startServer(options);
  const state = await request(
    "state?projectId=" + encodeURIComponent(project.id),
  );
  assert.ok(
    state.companies.some(
      (item) => item.id === company.id && item.name === company.name,
    ),
  );
  assert.ok(
    state.projects.some(
      (item) => item.id === project.id && item.root === project.root,
    ),
  );
  assert.equal(state.tasks.length, 0);
  const backupDirectory = await mkdtemp(join(directory, "backup-"));
  const backupPath = join(backupDirectory, "otter.db");
  const backup = await saveRecordBackup(app.store, backupPath);
  assert.equal(backup.saved, true);
  assert.ok(backup.bytes > 0);
  const backupBytes = await readFile(backupPath);
  await assert.rejects(
    saveRecordBackup(app.store, backupPath),
    /덮어쓰지 말고/,
  );
  await assert.rejects(
    startServer({ ...options, directory: backupDirectory }),
    { code: "OTTER_RECORD_BACKUP" },
  );
  await assert.rejects(access(join(backupDirectory, "worker.lock")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readFile(backupPath), backupBytes);
  assert.equal(app.store.get("companies", company.id).name, company.name);
  const corruptDirectory = await mkdtemp(join(directory, "corrupt-"));
  const damaged = Buffer.from(
    "실제 Electron SQLite 시작 실패 검사 · 보존할 원본",
  );
  await writeFile(join(corruptDirectory, "otter.db"), damaged);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      startServer({ ...options, directory: corruptDirectory }),
      { code: "OTTER_DATA_UNAVAILABLE" },
    );
    await assert.rejects(access(join(corruptDirectory, "worker.lock")), {
      code: "ENOENT",
    });
    assert.deepEqual(
      await readFile(join(corruptDirectory, "otter.db")),
      damaged,
    );
  }
  const metadata = JSON.parse(
    await readFile(join(archive, "package.json"), "utf8"),
  );
  console.log(
    JSON.stringify({
      directory,
      version: metadata.version,
      electron: process.versions.electron,
      node: process.versions.node,
      assets: assets.length,
      remoteModules: Object.keys(bundle.files).length,
      databaseReopened: true,
      startupFailureCleaned: true,
      recordBackupVerified: true,
      backupExecutionBlocked: true,
    }),
  );
} finally {
  await app.close();
}
