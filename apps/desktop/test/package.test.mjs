import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  packageOptions,
  desktopConfig,
  checkPackageSpace,
} from "../../../scripts/package-desktop.mjs";

test("패키징은 대상 OS/CPU를 명시하고 배포·서명·데이터 삭제 옵션을 일반 빌드 인수로 받지 않는다", () => {
  assert.deepEqual(packageOptions([], "darwin", "arm64"), {
    platform: "darwin",
    arch: "arm64",
    target: "dmg",
  });
  assert.deepEqual(packageOptions(["--x64"], "win32", "arm64"), {
    platform: "win32",
    arch: "x64",
    target: "nsis",
  });
  assert.deepEqual(packageOptions(["--", "--dir"], "linux", "x64"), {
    platform: "linux",
    arch: "x64",
    target: "dir",
  });
  for (const args of [
    ["--publish", "always"],
    ["--config"],
    ["--x64", "--arm64"],
    ["--dir", "--dir"],
  ])
    assert.throws(() => packageOptions(args, "darwin", "arm64"), /사용법/);
  assert.throws(() => packageOptions([], "linux", "x64"), /대상 OS/);
  assert.throws(() => packageOptions([], "win32", "ia32"), /CPU/);
  assert.equal(desktopConfig.asar, true);
  assert.equal(desktopConfig.electronFuses.runAsNode, false);
  assert.equal(desktopConfig.publish, null);
  assert.equal(desktopConfig.mac.notarize, false);
  assert.equal(desktopConfig.mac.identity, "-");
  assert.equal(desktopConfig.nsis.deleteAppDataOnUninstall, false);
  assert.equal(desktopConfig.nsis.allowElevation, false);
  assert.equal(desktopConfig.nsis.include, "apps/desktop/installer.nsh");
});

test("패키징 공간 검사는 부족/미확인 공간에서 중단하고 설치 종료 검사는 강제 종료를 사용하지 않는다", async () => {
  for (const bavail of [0, 1, -1, NaN])
    assert.throws(
      () => checkPackageSpace({ bavail, bsize: 4096 }, "검사 경로"),
      /최소 2 GiB/,
    );
  assert.equal(
    checkPackageSpace({ bavail: 524288, bsize: 4096 }, "검사 경로"),
    2 * 1024 ** 3,
  );
  const guard = await readFile(
    new URL("../installer.nsh", import.meta.url),
    "utf8",
  );
  assert.match(guard, /!macro customCheckAppRunning/);
  assert.match(guard, /\$R0 != 603/);
  assert.match(guard, /SetErrorLevel 1618\s+Quit/);
  assert.doesNotMatch(
    guard,
    /_KillProcess|_CloseProcess|taskkill|Stop-Process|ExecWait|RMDir|Delete /i,
  );
});
