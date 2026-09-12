import { build, Platform, Arch } from "electron-builder";
import { mkdir, mkdtemp, readFile, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDesktop } from "./verify-desktop.mjs";

export const projectDir = fileURLToPath(new URL("../", import.meta.url));
const desktop = JSON.parse(
  await readFile(join(projectDir, "apps/desktop/package.json"), "utf8"),
);

// 개발용 패키지. 공개 배포/외부 인증서 서명/자동 업데이트는 별도 출시 절차에서 다룬다.
export const desktopConfig = {
  appId: "dev.otter.desktop.v2",
  productName: "Otter Preview",
  executableName: "Otter",
  electronVersion: desktop.devDependencies.electron,
  asar: true,
  npmRebuild: false,
  publish: null,
  extraMetadata: {
    main: "apps/desktop/src/main.mjs",
    description: "IDE without code — AI 직원과 프로젝트를 관리하는 작업공간",
  },
  files: [
    "apps/desktop/src/*.mjs",
    "apps/desktop/src/preload.cjs",
    "apps/desktop/src-tauri/icons/32x32.png",
    "apps/worker/src/*.mjs",
    "apps/web/dist/index.html",
    "apps/web/dist/assets/**",
    "!**/*.map",
    "!**/node_modules/**",
  ],
  artifactName: "Otter-${version}-preview-${os}-${arch}.${ext}",
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    target: "dmg",
    icon: "apps/desktop/src-tauri/icons/icon.icns",
    category: "public.app-category.developer-tools",
    identity: "-",
    notarize: false,
  },
  win: {
    target: "nsis",
    icon: "apps/desktop/src-tauri/icons/icon.ico",
  },
  nsis: {
    include: "apps/desktop/installer.nsh",
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  },
  linux: {
    target: "dir",
    icon: "apps/desktop/src-tauri/icons/icon.png",
    category: "Development",
  },
};

export function packageOptions(
  args,
  platform = process.platform,
  arch = process.arch,
) {
  const selected = args.filter((arg) => arg !== "--");
  if (
    selected.some((arg) => !["--dir", "--x64", "--arm64"].includes(arg)) ||
    new Set(selected).size !== selected.length ||
    (selected.includes("--x64") && selected.includes("--arm64"))
  )
    throw new Error("사용법: pnpm desktop:package [--dir] [--x64 | --arm64]");
  const targetArch = selected.includes("--x64")
    ? "x64"
    : selected.includes("--arm64")
      ? "arm64"
      : arch;
  if (
    !["darwin", "win32", "linux"].includes(platform) ||
    !["x64", "arm64"].includes(targetArch)
  )
    throw new Error("이 OS/CPU의 패키징은 아직 지원하지 않습니다.");
  if (platform === "linux" && !selected.includes("--dir"))
    throw new Error(
      "Linux에서는 --dir로 패키지 내용만 검사합니다. DMG/EXE 설치 파일은 대상 OS에서 만드세요.",
    );
  return {
    platform,
    arch: targetArch,
    target: selected.includes("--dir")
      ? "dir"
      : platform === "darwin"
        ? "dmg"
        : "nsis",
  };
}

export function checkPackageSpace(stats, location) {
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(available) || available < 2 * 1024 ** 3)
    throw new Error(
      `패키징 공간이 부족하거나 확인되지 않았습니다: ${location}. 최소 2 GiB의 여유 공간을 확보한 뒤 다시 실행하세요. 기존 패키지나 사용자 파일은 자동 삭제하지 않습니다.`,
    );
  return available;
}

export async function packageDesktop(args) {
  const options = packageOptions(args);
  // 압축 해제/설치 파일 생성의 여유 공간이다. 전체 디스크 고갈 방지를 보장하는 예약은 아니다.
  for (const directory of new Set([projectDir, tmpdir()]))
    checkPackageSpace(await statfs(directory), directory);
  const outputRoot = join(projectDir, "artifacts/desktop");
  await mkdir(outputRoot, { recursive: true });
  const output = await mkdtemp(join(outputRoot, "v2-preview-"));
  // 개인 인증서가 있는 개발 PC에서도 이 명령은 외부 서명 계정을 사용하지 않는다.
  for (const key of Object.keys(process.env))
    if (/^(?:WIN_)?CSC_/.test(key)) delete process.env[key];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const platform = {
    darwin: Platform.MAC,
    win32: Platform.WINDOWS,
    linux: Platform.LINUX,
  }[options.platform];
  let appDirectory;
  await build({
    projectDir,
    targets: platform.createTarget(options.target, Arch[options.arch]),
    publish: "never",
    config: {
      ...desktopConfig,
      directories: { output },
      afterPack: (context) => {
        appDirectory =
          options.platform === "darwin"
            ? join(
                context.appOutDir,
                context.packager.appInfo.productFilename + ".app",
              )
            : context.appOutDir;
      },
    },
  });
  const verified = await verifyDesktop(appDirectory);
  console.log(`앱 파일 ${verified.files}개·버전·실행 제한 검사 통과`);
  console.log(
    `개발용 패키지 생성: ${output}\n설치·실제 실행 검증 및 공개 배포용 서명/공증은 별도입니다.`,
  );
  return output;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await packageDesktop(process.argv.slice(2));
