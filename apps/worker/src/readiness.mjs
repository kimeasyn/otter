import { mkdtemp, rmdir } from "node:fs/promises";
import { join, win32 } from "node:path";
import { Codex } from "./codex.mjs";
import { DomainError } from "./store.mjs";

// Electron의 process.execPath는 Node가 아니라 앱 실행 파일이다. OS 기본 명령으로 진단한다.
export function readinessCommand(
  platform = process.platform,
  env = process.env,
) {
  if (platform !== "win32") return ["/bin/echo", "OTTER_SANDBOX_OK"];
  if (!env.SystemRoot || !win32.isAbsolute(env.SystemRoot))
    throw new Error("Windows 시스템 경로를 확인하지 못했습니다.");
  return [
    win32.join(env.SystemRoot, "System32", "cmd.exe"),
    "/d",
    "/c",
    "echo OTTER_SANDBOX_OK",
  ];
}

// 환경 단위의 고정 진단만 실행한다. 프로젝트 설정/모델 접근/전체 격리 보장은 별도 검증이다.
export class CodexReadiness {
  constructor(directory, makeCodex = (options) => new Codex(options)) {
    this.directory = directory;
    this.makeCodex = makeCodex;
  }
  check() {
    if (this.modelsPending)
      throw new DomainError(
        "모델 목록 조회 중입니다. 잠시 후 다시 확인해 주세요.",
        409,
      );
    if (!this.pending)
      this.pending = this.run().finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async closeClient() {
    if (!this.client) return;
    try {
      await this.client.close();
      this.client = null;
    } catch {
      throw new DomainError(
        "진단 프로세스 종료를 확인하지 못했습니다. 새 검사는 시작하지 않습니다. 실행 환경을 확인한 뒤 다시 시도해 주세요.",
        503,
      );
    }
  }
  async close() {
    await this.pending?.catch(() => {});
    await this.modelsPending?.catch(() => {});
    await this.closeClient();
  }
  models() {
    if (this.pending)
      throw new DomainError(
        "실행 준비 검사 중입니다. 잠시 후 다시 조회해 주세요.",
        409,
      );
    if (!this.modelsPending)
      this.modelsPending = this.readModels().finally(() => {
        this.modelsPending = null;
      });
    return this.modelsPending;
  }
  async readModels() {
    await this.closeClient();
    const cwd = await mkdtemp(join(this.directory, "codex-models-"));
    try {
      this.client = this.makeCodex({ cwd, timeout: 10000 });
      this.client.on("request", (request) => this.client.refuse(request.id));
      await this.client.initialize();
      const models = new Map();
      const cursors = new Set();
      const deadline = Date.now() + 15000;
      let cursor;
      for (let page = 0; page < 10; page++) {
        if (Date.now() >= deadline) throw new Error("timeout");
        const result = await this.client.request(
          "model/list",
          {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          },
          Math.min(10000, deadline - Date.now()),
        );
        if (!Array.isArray(result?.data) || result.data.length > 100)
          throw new Error("invalid models");
        for (const item of result.data) {
          if (
            !item ||
            typeof item.model !== "string" ||
            !item.model.trim() ||
            item.model.length > 120 ||
            /[\x00-\x1f]/.test(item.model)
          )
            throw new Error("invalid model");
          if (item.hidden === true) continue;
          models.set(item.model, {
            model: item.model,
            displayName:
              typeof item.displayName === "string"
                ? item.displayName.slice(0, 200)
                : item.model,
            isDefault: item.isDefault === true,
          });
        }
        if (result.nextCursor == null)
          return {
            models: [...models.values()],
            checkedAt: new Date().toISOString(),
          };
        if (
          typeof result.nextCursor !== "string" ||
          !result.nextCursor ||
          result.nextCursor.length > 4096 ||
          cursors.has(result.nextCursor)
        )
          throw new Error("invalid cursor");
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      throw new Error("too many models");
    } catch {
      throw new DomainError(
        "모델 목록을 조회하지 못했습니다. 이 실행 환경의 Codex 설치·로그인·버전·네트워크를 확인해 주세요. 기존 모델 값은 유지되며 직접 입력할 수 있습니다.",
        503,
      );
    } finally {
      await this.closeClient();
      await rmdir(cwd).catch(() => {});
    }
  }
  async run() {
    await this.closeClient();
    const cwd = await mkdtemp(join(this.directory, "codex-check-"));
    const checks = [
      {
        name: "Codex 연결",
        status: "unknown",
        message: "확인하지 못했습니다.",
      },
      { name: "계정 설정", status: "unknown", message: "확인하지 못했습니다." },
      {
        name: "샌드박스 실행",
        status: "unknown",
        message: "확인하지 못했습니다.",
      },
    ];
    try {
      try {
        this.client = this.makeCodex({ cwd, timeout: 10000 });
        this.client.on("request", (request) => this.client.refuse(request.id));
        await this.client.initialize();
        Object.assign(checks[0], {
          status: "passed",
          message: "이 실행 환경의 Codex App Server에 연결했습니다.",
        });
      } catch {
        Object.assign(checks[0], {
          status: "failed",
          message:
            "Codex에 연결하지 못했습니다. 아래 실행 파일 설정에서 이 환경의 설치 경로를 확인해 주세요. 파일이 없으면 먼저 해당 환경에 Codex를 설치해야 합니다.",
        });
        return { checkedAt: new Date().toISOString(), checks };
      }
      try {
        const result = await this.client.request("account/read", {
          refreshToken: false,
        });
        const type = result?.account?.type;
        const known = ["chatgpt", "apiKey"].includes(type);
        Object.assign(checks[1], {
          status: known
            ? "passed"
            : result?.requiresOpenaiAuth === true && !result.account
              ? "failed"
              : "unknown",
          message: known
            ? type === "chatgpt"
              ? "ChatGPT 로그인 정보가 있습니다. 세션 유효성·잔여 사용량·모델 접근은 검사하지 않았습니다."
              : "API 키 설정이 있습니다. 구독과 별도 과금될 수 있으며 키 유효성·잔액은 검사하지 않았습니다."
            : result?.requiresOpenaiAuth === true && !result.account
              ? "이 환경의 터미널에서 codex login을 완료한 뒤 다시 확인해 주세요. 로컬 로그인은 SSH/WSL에 복사되지 않습니다."
              : "현재 제공자의 인증 가능 여부는 확인하지 못했습니다. 해당 환경의 Codex 제공자 설정을 확인해 주세요.",
        });
      } catch {
        checks[1].message =
          "계정 상태를 읽지 못했습니다. 이 환경의 Codex 로그인 상태와 버전을 확인해 주세요.";
      }
      try {
        const result = await this.client.request(
          "command/exec",
          {
            command: readinessCommand(),
            cwd,
            processId: "otter-readiness",
            timeoutMs: 10000,
            outputBytesCap: 1024,
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess: false,
              excludeSlashTmp: true,
              excludeTmpdirEnvVar: true,
            },
          },
          15000,
        );
        const passed =
          result?.exitCode === 0 &&
          /^OTTER_SANDBOX_OK\r?\n?$/.test(result.stdout);
        Object.assign(checks[2], {
          status: passed ? "passed" : "failed",
          message: passed
            ? "네트워크를 허용하지 않은 샌드박스에서 OS 기본 명령을 실행했습니다. 프로젝트별 도구·권한 검사는 별도입니다."
            : /bwrap:.*(?:failed|operation not permitted)/i.test(
                  result?.stderr || "",
                )
              ? "Linux 샌드박스 초기화가 운영 환경에서 거부되었습니다. 호스트/컨테이너의 격리 지원을 확인하거나 다른 실행 환경을 사용해 주세요. 보안을 해제해 우회하지 않습니다."
              : "샌드박스 명령을 정상 실행하지 못했습니다. 이 환경의 Codex 샌드박스 설정·OS 지원·실행 정책을 확인해 주세요.",
        });
      } catch {
        Object.assign(checks[2], {
          status: "failed",
          message:
            "샌드박스 실행 결과를 확인하지 못했습니다. Codex 버전과 실행 정책을 확인해 주세요. 자동 재시도하지 않습니다.",
        });
      }
      return { checkedAt: new Date().toISOString(), checks };
    } finally {
      await this.closeClient();
      // 비어 있는 진단 폴더만 정리한다. 예상치 못한 파일은 재귀 삭제하지 않는다.
      await rmdir(cwd).catch(() => {});
    }
  }
}
