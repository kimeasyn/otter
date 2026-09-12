// 작은 NSIS 검사 파일만 컴파일한다. 앱 설치 파일 생성이나 EXE 실행은 하지 않는다.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, statfs } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopConfig, projectDir } from "./package-desktop.mjs";

const stats = await statfs(tmpdir());
assert.ok(
  stats.bavail * stats.bsize > 256 * 1024 ** 2,
  "NSIS 검사에도 최소 256 MiB 여유 공간이 필요합니다.",
);
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { getMakeNsisPath, getNsisPluginsPath } = libRequire(
  "app-builder-lib/out/toolsets/windows",
);
const templates = join(
  dirname(libRequire.resolve("app-builder-lib/package.json")),
  "templates/nsis",
);
const compiler = await getMakeNsisPath(desktopConfig.toolsets?.nsis);
const plugins = await getNsisPluginsPath(desktopConfig.toolsets?.nsis);
const directory = await mkdtemp(join(tmpdir(), "otter-installer-guard-"));
const exec = promisify(execFile);
const options = {
  env: { ...process.env, ...compiler.env },
  maxBuffer: 8 * 1024 ** 2,
};
// electron-builder도 설치/제거 스크립트를 별도로 컴파일한다.
// -PPO에서는 플러그인 탐색이 생략되므로 실제 컴파일 로그의 명령을 검사한다.
for (const mode of ["install", "uninstall"]) {
  const executable = join(directory, `${mode}.exe`);
  const harness = join(directory, `${mode}.nsi`);
  await writeFile(
    harness,
    `
Unicode true
!include "LogicLib.nsh"
!addincludedir "${templates}/include"
!addplugindir /x86-unicode "${plugins}/x86-unicode"
!include "${join(projectDir, desktopConfig.nsis.include)}"
!include "allowOnlyOneInstallerInstance.nsh"
!define APP_EXECUTABLE_FILENAME "Otter.exe"
Name "Otter installer guard syntax check"
OutFile "${executable}"
RequestExecutionLevel user
Section
  ${mode === "install" ? "!insertmacro CHECK_APP_RUNNING" : ""}
  WriteUninstaller "$EXEDIR\\guard-uninstall.exe"
SectionEnd
Section "uninstall"
  ${mode === "uninstall" ? "!insertmacro CHECK_APP_RUNNING" : ""}
SectionEnd
`,
  );
  const { stdout } = await exec(compiler.path, ["-V4", harness], options);
  assert.doesNotMatch(
    stdout,
    /taskkill|Stop-Process|Plugin command: _(?:Kill|Close)Process/i,
  );
  assert.match(stdout, /Plugin command: _FindProcess Otter\.exe/);
  assert.match(stdout, /SetErrorLevel: 1618/);
  assert.equal((await readFile(executable)).subarray(0, 2).toString(), "MZ");
}
console.log(
  JSON.stringify({
    directory,
    guardIncluded: desktopConfig.nsis.include,
    installerAndUninstallerCompiled: true,
    defaultKillPathExcluded: true,
    executed: false,
  }),
);
