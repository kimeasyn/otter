import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

// 패키징 도구가 이미 사용하는 ASAR/fuse 구현을 그대로 검증에 사용한다.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(
  builderRequire.resolve("app-builder-lib"),
);
const asar = appBuilderRequire("@electron/asar");
const { getCurrentFuseWire, FuseV1Options } =
  appBuilderRequire("@electron/fuses");
const { FuseState } = appBuilderRequire("@electron/fuses/dist/constants");
const root = fileURLToPath(new URL("../", import.meta.url));

export async function verifyDesktop(appDirectory) {
  const mac = appDirectory.endsWith(".app");
  const resources = join(
    appDirectory,
    mac ? "Contents/Resources" : "resources",
  );
  const archive = join(resources, "app.asar");
  const expected = new Set([
    "package.json",
    "apps/desktop/src/preload.cjs",
    "apps/desktop/src-tauri/icons/32x32.png",
    "apps/web/dist/index.html",
  ]);
  for (const directory of ["apps/desktop/src", "apps/worker/src"])
    for (const file of await readdir(join(root, directory)))
      if (file.endsWith(".mjs")) expected.add(posix.join(directory, file));
  const assets = "apps/web/dist/assets";
  for (const file of await readdir(join(root, assets), { recursive: true }))
    if (
      (await stat(join(root, assets, file))).isFile() &&
      !file.endsWith(".map")
    )
      expected.add(posix.join(assets, file.replaceAll("\\", "/")));
  const actual = [];
  for (const path of asar.listPackage(archive)) {
    const name = path.replaceAll("\\", "/").replace(/^\//, "");
    const entry = asar.statFile(archive, name, false);
    assert.ok(
      !entry.link && !entry.unpacked,
      `예상하지 않은 링크/외부 파일: ${name}`,
    );
    if (!entry.files) actual.push(name);
  }
  assert.deepEqual(
    actual.sort(),
    [...expected].sort(),
    "필수 파일 누락 또는 개발 데이터 혼입",
  );
  for (const name of actual.filter((name) => name !== "package.json"))
    assert.deepEqual(
      asar.extractFile(archive, name),
      await readFile(join(root, name)),
      `현재 빌드와 다른 파일: ${name}`,
    );
  const metadata = JSON.parse(asar.extractFile(archive, "package.json"));
  const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(metadata.main, "apps/desktop/src/main.mjs");
  assert.equal(metadata.version, source.version);
  assert.ok(
    !metadata.dependencies || Object.keys(metadata.dependencies).length === 0,
  );
  const executableDirectory = mac
    ? join(appDirectory, "Contents/MacOS")
    : appDirectory;
  const executables = (await readdir(executableDirectory)).filter((name) =>
    ["Otter", "Otter.exe", "Otter Preview"].includes(name),
  );
  assert.equal(executables.length, 1, "앱 실행 파일을 하나로 확인할 수 없음");
  const executable = join(executableDirectory, executables[0]);
  const wire = await getCurrentFuseWire(executable);
  for (const name of [
    "RunAsNode",
    "EnableNodeOptionsEnvironmentVariable",
    "EnableNodeCliInspectArguments",
    "GrantFileProtocolExtraPrivileges",
  ])
    assert.equal(
      wire[FuseV1Options[name]],
      FuseState.DISABLE,
      `${name} 제한 누락`,
    );
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
  return {
    archive,
    executable,
    files: actual.length,
    version: metadata.version,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(
    process.argv.length,
    3,
    "사용법: node scripts/verify-desktop.mjs <패키지 앱 폴더>",
  );
  console.log(JSON.stringify(await verifyDesktop(resolve(process.argv[2]))));
}
