import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate, setTimeout } from "node:timers/promises";
import { mkdtemp, access, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDesktop } from "../src/desktop.mjs";
import { startServer } from "../../worker/src/server.mjs";
import { Store } from "../../worker/src/store.mjs";

const event = () => ({
  prevented: false,
  preventDefault() {
    this.prevented = true;
  },
});
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await setTimeout(5);
  }
  assert.ok(predicate(), "예상한 데스크톱 상태 전환이 완료되지 않음");
}

// Electron 창/다이얼로그만 대체한다. 제품의 시작·메뉴·이벤트·종료 흐름을 그대로 실행한다.
async function harness(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "otter-desktop-lifecycle-"));
  const windows = [],
    messages = [],
    errors = [];
  const handlers = new Map();
  let menu;
  const app = Object.assign(new EventEmitter(), {
    commandLine: { getSwitchValue: () => directory },
    setName() {},
    setPath() {},
    setAppUserModelId() {},
    getPath: () => directory,
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    quitCount: 0,
    quit() {
      const request = event();
      this.emit("before-quit", request);
      if (!request.prevented) {
        this.quitCount++;
        for (const window of windows) window.close();
      }
    },
  });
  class BrowserWindow extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.visible = false;
      this.destroyed = false;
      this.loads = [];
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: (handler) => {
          this.openHandler = handler;
        },
        session: {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
        },
      });
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {
      assert.equal(this.destroyed, false);
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    setTitle(value) {
      assert.equal(this.destroyed, false);
      this.title = value;
    }
    setProgressBar() {
      assert.equal(this.destroyed, false);
    }
    close() {
      const request = event();
      this.emit("close", request);
      if (!request.prevented) this.destroyed = true;
    }
    async loadURL(url) {
      this.loads.push(url);
      this.webContents.mainFrame = { url };
      await options.load?.(this.loads.length);
      this.emit("ready-to-show");
    }
  }
  class Tray extends EventEmitter {
    constructor() {
      super();
      if (options.trayError) throw new Error("private-startup-error");
    }
    setToolTip() {}
    setContextMenu() {}
    destroy() {}
  }
  const electron = {
    app,
    BrowserWindow,
    Tray,
    nativeImage: { createFromPath: () => ({}) },
    Menu: {
      buildFromTemplate: (value) => value,
      setApplicationMenu: (value) => {
        menu = value;
      },
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {
      showSaveDialog: async (...args) =>
        options.save ? options.save(args.at(-1)) : { canceled: true },
      showErrorBox: (title, message) => errors.push({ title, message }),
      async showMessageBox(...args) {
        const request = args.at(-1);
        messages.push(request);
        return options.message
          ? options.message(request)
          : { response: request.cancelId };
      },
    },
  };
  const worker = {
    origin: "http://127.0.0.1:43219",
    runner: { active: new Map() },
    store: { projectLocks: new Set() },
    environments: { list: () => [] },
    closed: 0,
    async close() {
      this.closed++;
      await options.close?.();
    },
  };
  return {
    directory,
    electron,
    app,
    worker,
    windows,
    messages,
    errors,
    handlers,
    backup: () =>
      menu[0].submenu.find((item) => item.label === "로컬 기록 백업…").click(),
    open: () =>
      menu[0].submenu.find((item) => item.label === "사무실 열기").click(),
  };
}

test("손상된 기록으로 시작할 수 없으면 원본 위치와 안전한 안내만 표시하고 잠금을 남기지 않는다", async () => {
  const h = await harness();
  const source = "private-broken-database";
  await startDesktop(h.electron, async (options) => {
    await mkdir(options.directory, { recursive: true });
    await writeFile(join(options.directory, "otter.db"), source);
    return startServer({
      ...options,
      makeCodex: () => {
        throw new Error("모델 실행 금지");
      },
    });
  });
  await until(() => h.app.quitCount === 1);
  assert.equal(h.windows.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /작업 기록을 읽거나 초기화/);
  assert.ok(h.errors[0].message.includes(join(h.directory, "v2")));
  assert.doesNotMatch(h.errors[0].message, /private-broken-database/);
  assert.equal(
    await readFile(join(h.directory, "v2", "otter.db"), "utf8"),
    source,
  );
  await assert.rejects(access(join(h.directory, "v2", "worker.lock")), {
    code: "ENOENT",
  });
});

test("화면 로드 실패·렌더러 종료는 사용자 선택으로 화면만 복구하고 업무와 창 닫기 동작을 유지한다", async () => {
  const decision = Promise.withResolvers();
  const reloading = Promise.withResolvers();
  let prompts = 0,
    starts = 0;
  const h = await harness({
    load: async (count) => {
      if (count === 1) throw new Error("private-load-error");
      if (count === 3) await reloading.promise;
    },
    message: async () => (++prompts === 1 ? { response: 0 } : decision.promise),
  });
  await startDesktop(h.electron, async () => {
    starts++;
    return h.worker;
  });
  const window = h.windows[0];
  await until(() => window.loads.length === 2);
  assert.equal(h.worker.closed, 0);
  assert.equal(window.config.webPreferences.sandbox, true);
  assert.equal(window.config.webPreferences.nodeIntegration, false);
  assert.deepEqual(window.openHandler(), { action: "deny" });
  const navigation = event();
  window.webContents.emit(
    "will-navigate",
    navigation,
    "https://outside.invalid",
  );
  assert.equal(navigation.prevented, true);
  window.webContents.emit("render-process-gone");
  window.webContents.emit("render-process-gone");
  assert.equal(prompts, 2, "중복 복구 창을 열지 않는다");
  decision.resolve({ response: 1 });
  await until(() => !window.visible);
  h.open();
  await until(() => window.loads.length === 3);
  h.open();
  assert.equal(
    window.loads.length,
    3,
    "진행 중인 화면 로드를 중복 시작하지 않는다",
  );
  reloading.resolve();
  await setImmediate();
  assert.equal(starts, 1, "화면 복구로 새 실행부를 만들지 않는다");
  assert.equal(h.worker.closed, 0);
  window.close();
  assert.equal(window.visible, false);
  assert.equal(window.destroyed, false);
  h.open();
  assert.equal(window.visible, true);
  assert.equal(
    window.loads.length,
    3,
    "정상 창을 열 때는 다시 로드하지 않는다",
  );
  assert.doesNotMatch(JSON.stringify(h.messages), /private-/);
  h.app.quit();
  await until(() => h.app.quitCount === 1);
  assert.equal(h.worker.closed, 1);
});

test("시작 도중 종료는 늦게 생성된 실행부의 종료를 기다리며 중복 종료를 합친다", async () => {
  const starting = Promise.withResolvers(),
    closing = Promise.withResolvers();
  const h = await harness({ close: () => closing.promise });
  const boot = startDesktop(h.electron, () => starting.promise);
  h.app.quit();
  h.app.quit();
  assert.equal(h.app.quitCount, 0);
  starting.resolve(h.worker);
  await boot;
  await until(() => h.worker.closed === 1);
  assert.equal(h.app.quitCount, 0);
  assert.equal(h.windows.length, 0, "종료 중 새 창을 열지 않는다");
  closing.resolve();
  await until(() => h.app.quitCount === 1);
});

test("활성 업무 종료는 취소할 수 있고 파괴된 창에도 정상 종료 확인을 마친다", async () => {
  let response = 0;
  const h = await harness({ message: async () => ({ response }) });
  h.worker.runner.active.set("running", {});
  await startDesktop(h.electron, async () => h.worker);
  h.app.quit();
  await until(() => h.messages.length === 1);
  await setImmediate();
  assert.equal(h.worker.closed, 0);
  assert.equal(h.app.quitCount, 0);
  h.windows[0].destroyed = true;
  response = 1;
  h.app.quit();
  await until(() => h.app.quitCount === 1);
  assert.equal(h.worker.closed, 1);
});

test("시작 실패도 실제 실행부를 정리하며 종료 실패 시 DB·잠금을 유지하고 명시적 재시도 후 해제한다", async () => {
  const retry = Promise.withResolvers();
  const h = await harness({ trayError: true, message: () => retry.promise });
  let worker,
    closes = 0;
  await startDesktop(h.electron, async (options) => {
    worker = await startServer({
      ...options,
      makeCodex: () => {
        throw new Error("모델 실행 금지");
      },
    });
    const close = worker.environments.close.bind(worker.environments);
    worker.environments.close = async () => {
      if (++closes === 1) throw new Error("private-close-error");
      return close();
    };
    return worker;
  });
  try {
    await until(() =>
      h.messages.some((message) => message.title === "종료 확인"),
    );
    await setImmediate();
    assert.equal(h.app.quitCount, 0);
    const lock = join(h.directory, "v2/worker.lock");
    await access(lock);
    assert.equal(worker.store.all("tasks").length, 0);
    const health = await fetch(worker.origin + "/api/health", {
      headers: { Authorization: `Bearer ${worker.token}` },
    });
    assert.equal((await health.json()).stopping, true);
    assert.equal((await fetch(worker.origin + "/api/state")).status, 503);
    assert.doesNotMatch(JSON.stringify([h.errors, h.messages]), /private-/);
    h.app.quit();
    assert.equal(
      closes,
      1,
      "종료 실패 안내 중에는 중복 종료를 시작하지 않는다",
    );
    retry.resolve({ response: 1 });
    await until(() => h.app.quitCount === 1);
    assert.equal(closes, 2);
    await assert.rejects(access(lock), { code: "ENOENT" });
  } finally {
    retry.resolve({ response: 0 });
    await worker.close();
  }
});

test("종료 실패에서 상태 유지를 선택해도 네이티브 추가 요청을 막고 종료 재확인은 허용한다", async () => {
  let closes = 0;
  const h = await harness({
    close: async () => {
      if (++closes === 1)
        throw Object.assign(
          new Error("배포 프로세스 그룹 12345의 종료를 확인하지 못했습니다."),
          { code: "OTTER_DEPLOYMENT_GROUP_PENDING" },
        );
    },
    message: async () => ({ response: 0 }),
  });
  await startDesktop(h.electron, async () => h.worker);
  h.app.quit();
  await until(() => h.messages.length === 1);
  await setImmediate();
  assert.equal(h.app.quitCount, 0);
  assert.match(h.messages[0].detail, /배포 프로세스 그룹 12345/);
  for (const name of [
    "otter:pick-folder",
    "otter:pick-codex",
    "otter:open-editor",
    "otter:backup-records",
  ])
    await assert.rejects(h.handlers.get(name)({}), /종료를 확인하는 중/);
  h.app.quit();
  await until(() => h.app.quitCount === 1);
  assert.equal(closes, 2);
});

test("기록 백업은 올바른 창의 범위 확인·저장 선택을 요구하며 취소·중복·종료 후 요청을 거절한다", async () => {
  let decision = { response: 0 },
    saves = 0;
  const h = await harness({
    message: () => decision,
    save: async () => {
      saves++;
      return { canceled: true };
    },
  });
  await startDesktop(h.electron, async () => h.worker);
  const sender = h.windows[0].webContents;
  const request = { sender, senderFrame: sender.mainFrame };
  const backup = h.handlers.get("otter:backup-records");
  for (const invalid of [{}, { sender, senderFrame: { url: h.worker.origin } }])
    await assert.rejects(backup(invalid), /허용되지 않은/);
  sender.mainFrame.url = "https://outside.invalid";
  await assert.rejects(backup(request), /허용되지 않은/);
  sender.mainFrame.url = h.worker.origin;
  assert.equal(h.messages.length, 0);
  assert.deepEqual(await backup(request), { saved: false });
  assert.equal(saves, 0);
  assert.match(h.messages[0].message, /암호화되지 않은/);
  assert.match(h.messages[0].detail, /원격 실행부 원본 DB/);
  decision = { response: 1 };
  assert.deepEqual(await backup(request), { saved: false });
  assert.equal(saves, 1);
  const pending = Promise.withResolvers();
  decision = pending.promise;
  const saving = backup(request);
  await assert.rejects(backup(request), /이미 진행 중/);
  const rejected = assert.rejects(saving, /종료를 확인하는 중/);
  h.app.quit();
  await until(() => h.app.quitCount === 1);
  pending.resolve({ response: 1 });
  await rejected;
  assert.equal(saves, 1, "종료 후 저장 대화상자를 열지 않는다");
});

for (const entry of ["메뉴", "IPC"])
  test(`${entry}의 실제 SQLite 백업 중 완전 종료는 저장·검증이 끝난 뒤에만 원본 DB를 닫는다`, async () => {
    let destination;
    const h = await harness({
      message: async () => ({ response: 1 }),
      save: async () => ({ canceled: false, filePath: destination }),
    });
    destination = join(h.directory, "records.sqlite");
    const store = new Store(join(h.directory, "source.db"));
    store.insert("companies", { name: "종료와 백업 경합" });
    let triggered = false,
      savedBeforeClose = false;
    h.worker.store = {
      projectLocks: store.projectLocks,
      get db() {
        // 백업의 실제 DB 접근 시 종료 요청: 복사가 끝났다고 추정하지 않는다.
        if (!triggered) {
          triggered = true;
          h.app.quit();
        }
        return store.db;
      },
    };
    h.worker.close = async () => {
      await access(destination);
      savedBeforeClose = true;
      store.close();
    };
    try {
      await startDesktop(h.electron, async () => h.worker);
      if (entry === "메뉴") h.backup();
      else {
        const sender = h.windows[0].webContents;
        const result = await h.handlers.get("otter:backup-records")({
          sender,
          senderFrame: sender.mainFrame,
        });
        assert.equal(result.saved, true);
      }
      await until(() => h.app.quitCount === 1);
      assert.equal(triggered, true);
      assert.equal(savedBeforeClose, true);
      assert.equal(store.db.isOpen, false);
      assert.equal(h.errors.length, 0);
      assert.equal(
        h.messages.length,
        1,
        "종료 중 추가 완료 대화상자를 열지 않는다",
      );
      assert.throws(() => new Store(destination), {
        code: "OTTER_RECORD_BACKUP",
      });
    } finally {
      store.close();
    }
  });
