import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError } from "./store.mjs";

export function codexSettings(store) {
  return store.metadata("codexExecutable") || { path: "", revision: null };
}

export function configuredCodex(
  store,
  options,
  create = (options) => new Codex(options),
) {
  return create({ ...options, command: codexSettings(store).path || "codex" });
}

export async function saveCodexSettings(store, input, busy) {
  const check = () => {
    if (busy())
      throw new DomainError(
        "Codex 실행 또는 진단이 진행 중입니다. 종료를 확인한 뒤 변경해 주세요.",
        409,
      );
    if (input.revision !== codexSettings(store).revision)
      throw new DomainError(
        "실행 파일 설정이 변경됐습니다. 현재 설정을 다시 불러와 주세요.",
        409,
      );
  };
  check();
  if (input.confirm !== true)
    throw new DomainError("실행 파일 사용에 동의해 주세요.");
  if (
    typeof input.path !== "string" ||
    input.path.length > 4096 ||
    /[\0\r\n]/.test(input.path)
  )
    throw new DomainError("실행 파일 경로가 올바르지 않습니다.");
  let path = input.path.trim();
  if (path) {
    if (!isAbsolute(path))
      throw new DomainError(
        "실행 파일의 절대 경로를 입력해 주세요. 인수는 입력하지 않습니다.",
      );
    if (process.platform === "win32" && !path.toLowerCase().endsWith(".exe"))
      throw new DomainError(
        "Windows에서는 Codex의 실제 .exe 파일을 선택해 주세요. .cmd/.bat 파일을 셸로 실행하지 않습니다.",
      );
    try {
      path = await realpath(path);
      if (!(await stat(path)).isFile()) throw new Error();
      await access(
        path,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
    } catch {
      throw new DomainError(
        "이 실행 환경에서 실행 가능한 파일을 찾지 못했습니다. 파일 위치와 권한을 확인해 주세요.",
      );
    }
  }
  return store.transaction(() => {
    check();
    const settings = { path, revision: randomUUID() };
    store.metadata("codexExecutable", settings);
    return settings;
  });
}

// App Server JSONL: 클라이언트 요청과 서버의 승인 요청은 서로 다른 ID 공간이다.
export class Codex extends EventEmitter {
  constructor({
    command = "codex",
    args = ["app-server"],
    cwd,
    timeout = 30000,
  } = {}) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.timeout = timeout;
    this.closed = false;
    this.process = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => this.process.once("close", resolve));
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("Codex 프로토콜 응답을 읽을 수 없습니다."));
        return;
      }
      if (message.method)
        this.emit(
          message.id === undefined ? "notification" : "request",
          message,
        );
      else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            Object.assign(
              new Error(message.error.message || "Codex 요청 실패"),
              { rpcRejected: true },
            ),
          );
        else pending.resolve(message.result);
      }
    });
    // stderr에는 인증 정보나 개인 경로가 포함될 수 있어 UI/영구 로그로 복사하지 않는다.
    this.process.stderr.on("data", () => {});
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("error", (error) =>
      this.fail(
        new Error(
          error.code === "ENOENT"
            ? "Codex CLI가 없습니다. 실행 환경에 Codex를 설치하고 로그인해 주세요."
            : "Codex를 시작하지 못했습니다.",
        ),
      ),
    );
    this.process.on("exit", () =>
      this.fail(new Error("Codex 실행부와 연결이 종료되었습니다.")),
    );
  }
  send(message) {
    if (this.closed) throw new Error("Codex 연결이 종료되었습니다.");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params = {}, timeout = this.timeout) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex 응답 확인 시간 초과: ${method}. 실행을 자동 재시도하지 않습니다.`,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async initialize(experimentalApi = false) {
    const result = await this.request("initialize", {
      clientInfo: { name: "otter", title: "Otter", version: "0.2.0" },
      capabilities: { experimentalApi },
    });
    this.send({ method: "initialized" });
    return result;
  }
  reply(id, result) {
    this.send({ id, result });
  }
  refuse(id) {
    this.send({
      id,
      error: {
        code: -32601,
        message:
          "Otter에서 아직 지원하지 않는 요청입니다. 작업을 중단하고 사용자에게 보고하세요.",
      },
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error);
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.process.stdin.end();
      this.process.kill();
      this.fail(new Error("Codex 연결을 종료했습니다."));
      let timer;
      try {
        await Promise.race([
          this.exited,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Codex 프로세스의 종료를 확인하지 못했습니다. 실행 자리를 유지합니다.",
                  ),
                ),
              15000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })().catch((error) => {
      this.closePromise = null;
      throw error;
    });
    return this.closePromise;
  }
}
