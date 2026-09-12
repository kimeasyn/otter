import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, isAbsolute, delimiter, win32 } from "node:path";
import { homedir } from "node:os";

export function codeCandidates(platform = process.platform, env = process.env) {
  if (platform === "darwin")
    return [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      join(
        homedir(),
        "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      ),
      "/usr/local/bin/code",
    ];
  if (platform === "win32")
    return [
      ...(env.LOCALAPPDATA
        ? [win32.join(env.LOCALAPPDATA, "Programs/Microsoft VS Code/Code.exe")]
        : []),
      ...[env.ProgramFiles, env.ProgramW6432]
        .filter(Boolean)
        .map((root) => win32.join(root, "Microsoft VS Code/Code.exe")),
    ];
  return (env.PATH || "/usr/bin:/usr/local/bin:/snap/bin")
    .split(delimiter)
    .filter(isAbsolute)
    .map((root) => join(root, "code"));
}
export async function findCode(preferred) {
  for (const path of preferred ? [preferred] : codeCandidates()) {
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(
        path,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return path;
    } catch {
      /* 다음 설치 위치를 확인한다. */
    }
  }
  return null;
}
// 경로·인자는 셸 문자열로 합치지 않는다. 외부 IDE의 수명은 Otter 작업 수명과 별개다.
export async function launchCode(executable, args, cwd, launch = spawn) {
  if (!isAbsolute(executable))
    throw new Error("IDE 실행 파일의 절대 경로가 필요합니다.");
  return new Promise((resolve, reject) => {
    const child = launch(executable, args, {
      cwd,
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () =>
      reject(
        new Error(
          "VS Code 실행 요청을 전달하지 못했습니다. 실행 파일 위치를 다시 선택해 주세요.",
        ),
      ),
    );
    child.once("spawn", () => {
      child.unref();
      resolve({ launched: true });
    });
  });
}
