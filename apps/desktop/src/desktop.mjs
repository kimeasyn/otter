import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { startServer } from "../../worker/src/server.mjs";
import { editorRequest } from "../../worker/src/editor.mjs";
import { findCode, launchCode } from "./ide.mjs";
import { saveRecordBackup } from "./backup.mjs";

// 실제 데스크톱 진입 흐름을 네이티브 어댑터 대역으로도 검사한다.
export async function startDesktop(
  { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain },
  startWorker = startServer,
) {
  let window;
  let tray;
  let worker;
  let quitting = false;
  let confirming = false;
  let stopping = false;
  let startup;
  let startupFailed = false;
  let recovering = false;
  let backupBusy = false;
  let backupPending;
  const failedWindows = new WeakSet();
  const loadingWindows = new WeakSet();
  // 개발 실행/설치 파일 이름이 달라도 작업 기록 위치는 동일하게 유지한다.
  app.setName("Otter");
  const requestedProfile = app.commandLine.getSwitchValue("user-data-dir");
  const userData = requestedProfile
    ? resolve(requestedProfile)
    : join(app.getPath("appData"), "Otter");
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  if (process.platform === "win32")
    app.setAppUserModelId("dev.otter.desktop.v2");
  const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
  const iconPath = fileURLToPath(
    new URL("../src-tauri/icons/32x32.png", import.meta.url),
  );
  const usableWindow = () =>
    window && !window.isDestroyed() ? window : undefined;
  const showScreenFailure = async (target) => {
    if (target.isDestroyed()) return;
    failedWindows.add(target);
    if (quitting || confirming || recovering) return;
    recovering = true;
    let response = 1;
    try {
      target.show();
      ({ response } = await dialog.showMessageBox(target, {
        type: "warning",
        title: "사무실 화면 연결 확인",
        message: "사무실 화면을 표시하지 못했습니다.",
        detail:
          "실행부의 업무를 중단하거나 요청을 다시 보내지 않습니다. 화면만 다시 불러와 저장된 상태를 확인할 수 있습니다. 저장하지 않은 입력은 복구되지 않을 수 있습니다.",
        buttons: ["화면 다시 불러오기", "백그라운드 유지", "Otter 완전 종료"],
        defaultId: 1,
        cancelId: 1,
      }));
    } catch {
      dialog.showErrorBox(
        "화면 복구 확인",
        "화면을 복구하지 못했습니다. Otter 메뉴에서 사무실을 다시 열거나 완전 종료를 선택해 주세요. 업무를 자동 재실행하지 않습니다.",
      );
    } finally {
      recovering = false;
    }
    if (quitting || confirming || target.isDestroyed()) return;
    if (response === 0) loadWindow(target);
    else if (response === 2) app.quit();
    else target.hide();
  };
  const loadWindow = async (target) => {
    if (
      confirming ||
      quitting ||
      target.isDestroyed() ||
      loadingWindows.has(target)
    )
      return;
    loadingWindows.add(target);
    let failed = false;
    try {
      await target.loadURL(worker.origin);
      failedWindows.delete(target);
    } catch {
      failed = true;
    } finally {
      loadingWindows.delete(target);
    }
    if (failed) await showScreenFailure(target);
  };
  const createWindow = () => {
    if (!worker || confirming || quitting || startupFailed) return;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      if (failedWindows.has(window)) loadWindow(window);
      return;
    }
    window = new BrowserWindow({
      width: 1440,
      height: 950,
      minWidth: 840,
      minHeight: 620,
      title: "Otter",
      backgroundColor: "#f7f8fc",
      show: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== worker.origin) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    const target = window;
    target.webContents.on("render-process-gone", () => {
      void showScreenFailure(target);
    });
    target.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        target.hide();
      }
    });
    target.once("ready-to-show", () => {
      if (!confirming && !quitting && !target.isDestroyed()) target.show();
    });
    loadWindow(target);
  };
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on("second-instance", () => {
      if (startupFailed) app.quit();
      else createWindow();
    });
    app.on("window-all-closed", () => {});
    app.on("activate", () => {
      if (worker) createWindow();
    });
    app.on("before-quit", (event) => {
      if (quitting) return;
      event.preventDefault();
      if (confirming) return;
      confirming = true;
      void (async () => {
        // 시작 도중 종료해도 뒤늦게 생성된 실행부를 남겨 두지 않는다.
        await startup?.catch(() => {});
        await backupPending?.catch(() => {});
        const active = worker?.runner.active.size || 0;
        const changing = worker?.store.projectLocks.size || 0;
        const wsl =
          worker?.environments
            ?.list()
            .filter(
              (environment) =>
                environment.kind === "wsl" && environment.allocated,
            ).length || 0;
        if (!stopping && (active || wsl || changing)) {
          const answer = await dialog.showMessageBox({
            type: "warning",
            title: "Otter 완전 종료",
            message: `로컬 업무 ${active}개 실행 중 · 프로젝트 변경 ${changing}개 처리 중 · WSL 실행 환경 ${wsl}개 등록`,
            detail:
              "완전 종료하면 새 요청을 차단하고 처리 중인 병합·푸시·배포 명령의 결과 기록을 기다린 뒤 로컬·WSL 실행을 중단합니다. SSH 서버의 업무는 계속됩니다. 창만 닫으면 모든 실행을 유지합니다.",
            buttons: ["계속 작업하기", "로컬 작업 중단 후 종료"],
            defaultId: 0,
            cancelId: 0,
          });
          if (answer.response !== 1) {
            confirming = false;
            createWindow();
            return;
          }
        }
        usableWindow()?.setTitle("Otter — 작업 기록을 저장하고 종료하는 중");
        usableWindow()?.setProgressBar(2);
        stopping = true;
        await worker?.close();
        quitting = true;
        tray?.destroy();
        app.quit();
      })().catch(async (error) => {
        usableWindow()?.setTitle("Otter — 종료 확인 필요");
        usableWindow()?.setProgressBar(-1);
        let retry = false;
        try {
          const answer = await dialog.showMessageBox({
            type: "warning",
            title: "종료 확인",
            message: "실행부 종료를 확인하지 못했습니다.",
            detail:
              error?.code === "OTTER_DEPLOYMENT_GROUP_PENDING"
                ? error.message
                : "앱을 강제 종료하거나 기록과 잠금을 삭제하지 않습니다. 실행부 상태를 확인한 뒤 종료를 다시 시도해 주세요. 종료 도중 실패한 실행부는 새 요청을 차단합니다.",
            buttons: ["상태 유지", "종료 다시 확인"],
            defaultId: 0,
            cancelId: 0,
          });
          retry = answer.response === 1;
        } catch {
          dialog.showErrorBox(
            "종료 확인",
            "앱을 강제 종료하지 않았습니다. 상태를 확인한 뒤 Otter 완전 종료를 다시 선택해 주세요.",
          );
        } finally {
          confirming = false;
        }
        if (retry) app.quit();
      });
    });
    startup = (async () => {
      await app.whenReady();
      worker = await startWorker({
        directory: join(app.getPath("userData"), "v2"),
        port: 0,
      });
      const assertSender = (event) => {
        if (confirming || stopping || quitting)
          throw new Error(
            "종료를 확인하는 중입니다. 새 요청은 잠시 기다려 주세요.",
          );
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          new URL(event.senderFrame.url).origin !== worker.origin
        )
          throw new Error("허용되지 않은 요청");
      };
      ipcMain.handle("otter:pick-folder", async (event) => {
        assertSender(event);
        const result = await dialog.showOpenDialog(window, {
          title: "프로젝트 폴더 선택",
          properties: ["openDirectory"],
        });
        return result.canceled ? null : result.filePaths[0];
      });
      const backupRecords = async (event) => {
        const check = () => {
          if (event) assertSender(event);
          else if (confirming || stopping || quitting || !usableWindow())
            throw new Error(
              "사무실을 연 상태에서 종료 전에 백업을 시작해 주세요.",
            );
        };
        check();
        if (backupBusy) throw new Error("기록 백업이 이미 진행 중입니다.");
        backupBusy = true;
        try {
          const consent = await dialog.showMessageBox(usableWindow(), {
            type: "warning",
            title: "로컬 Otter 기록 백업",
            message: "이 PC의 Otter 기록을 암호화되지 않은 파일로 저장합니다.",
            detail:
              "회사·직원·지침·대화·보고·설정과 원격 조회 캐시를 포함합니다. 기록에 기밀 정보가 있을 수 있으므로 개인이 보호하는 위치에 저장하세요. 실제 프로젝트/직원 작업 파일, 원격 실행부 원본 DB, 계정 인증 파일, 저장하지 않은 입력은 포함하지 않습니다. 자동 복원·업무 재개 기능은 아직 제공하지 않습니다.",
            buttons: ["취소", "범위를 확인하고 저장 위치 선택"],
            defaultId: 0,
            cancelId: 0,
          });
          check();
          if (consent.response !== 1) return { saved: false };
          const selected = await dialog.showSaveDialog(usableWindow(), {
            title: "로컬 기록 백업 저장",
            defaultPath: `otter-records-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
            filters: [{ name: "Otter 기록 백업", extensions: ["sqlite"] }],
          });
          check();
          if (selected.canceled || !selected.filePath) return { saved: false };
          backupPending = saveRecordBackup(worker.store, selected.filePath);
          const result = await backupPending;
          if (!event && !confirming && !stopping && !quitting && usableWindow())
            await dialog.showMessageBox(usableWindow(), {
              type: "info",
              title: "기록 백업 저장",
              message: "로컬 기록 사본을 저장하고 검증했습니다.",
              detail: result.path,
              buttons: ["확인"],
            });
          return result;
        } finally {
          backupBusy = false;
          backupPending = null;
        }
      };
      ipcMain.handle("otter:backup-records", (event) => backupRecords(event));
      ipcMain.handle("otter:pick-codex", async (event) => {
        assertSender(event);
        const result = await dialog.showOpenDialog(window, {
          title: "Codex 실행 파일 선택",
          properties: ["openFile"],
          ...(process.platform === "win32"
            ? { filters: [{ name: "Codex 실행 파일", extensions: ["exe"] }] }
            : {}),
        });
        return result.canceled ? null : result.filePaths[0];
      });
      ipcMain.handle("otter:open-editor", async (event, input) => {
        assertSender(event);
        const target = await editorRequest(worker, input);
        let executable =
          input.chooseExecutable === true
            ? null
            : await findCode(worker.store.metadata("editorExecutable"));
        if (!executable) {
          const selected = await dialog.showOpenDialog(window, {
            title: "VS Code 실행 파일 선택",
            properties: ["openFile"],
            ...(process.platform === "win32"
              ? {
                  filters: [{ name: "VS Code 실행 파일", extensions: ["exe"] }],
                }
              : {}),
          });
          if (selected.canceled) return { launched: false };
          const path = selected.filePaths[0];
          executable = await findCode(
            process.platform === "darwin" && path.endsWith(".app")
              ? join(path, "Contents/Resources/app/bin/code")
              : path,
          );
          if (!executable)
            throw new Error("실행 가능한 VS Code 파일을 선택해 주세요.");
          worker.store.metadata("editorExecutable", executable);
        }
        const answer = await dialog.showMessageBox(window, {
          type: target.active ? "warning" : "question",
          title: "외부 IDE에서 열기",
          message: `${target.environmentName} · ${target.projectName}\n${target.taskId ? "직원 작업 폴더" : "프로젝트 원본"} · ${target.branch || "분리된 HEAD"}`,
          detail: `${target.path}\n\n실행 파일: ${executable}\n${target.args.includes("--remote") ? `IDE 접속: ${target.args[2]}\nIDE의 SSH/WSL 설정과 설치 상태는 별도로 확인해야 합니다.\n` : ""}외부 IDE의 편집은 실제 파일에 반영됩니다. 직원 실행을 자동으로 멈추거나 변경을 병합하지 않습니다.${target.active ? "\n현재 실행이 있어 같은 파일을 동시에 수정하면 충돌할 수 있습니다." : ""}`,
          buttons: ["취소", "VS Code 열기"],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response !== 1) return { launched: false };
        const current = await editorRequest(worker, input);
        if (
          current.path !== target.path ||
          current.branch !== target.branch ||
          current.active !== target.active ||
          JSON.stringify(current.args) !== JSON.stringify(target.args)
        )
          throw new Error(
            "확인하는 동안 작업 대상이 변경되었습니다. 다시 확인해 주세요.",
          );
        return launchCode(executable, current.args, app.getPath("userData"));
      });
      const menu = Menu.buildFromTemplate([
        {
          label: "Otter",
          submenu: [
            { label: "사무실 열기", click: createWindow },
            {
              label: "로컬 기록 백업…",
              click: () => {
                void backupRecords().catch((error) =>
                  dialog.showErrorBox("기록 백업", error.message),
                );
              },
            },
            { type: "separator" },
            { label: "Otter 완전 종료", click: () => app.quit() },
          ],
        },
        {
          label: "편집",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "보기",
          submenu: [
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
          ],
        },
      ]);
      Menu.setApplicationMenu(menu);
      tray = new Tray(nativeImage.createFromPath(iconPath));
      tray.setToolTip("Otter — AI 직원 작업공간");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "사무실 열기", click: createWindow },
          { type: "separator" },
          { label: "완전 종료", click: () => app.quit() },
        ]),
      );
      tray.on("click", createWindow);
      createWindow();
    })();
    try {
      await startup;
    } catch (error) {
      startupFailed = true;
      dialog.showErrorBox(
        "Otter를 시작하지 못했습니다",
        ["OTTER_DATA_UNAVAILABLE", "OTTER_RECORD_BACKUP"].includes(error?.code)
          ? `${error.message}\n\n기록 위치: ${join(app.getPath("userData"), "v2")}`
          : "설치 파일·데이터 폴더 권한·기존 실행 여부를 확인해 주세요. 기존 기록이나 실행부 잠금을 삭제하지 않습니다. 생성된 실행부가 있으면 종료 확인 절차를 거칩니다.",
      );
      app.quit();
    }
  }
}
