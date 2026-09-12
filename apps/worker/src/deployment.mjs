import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { DomainError, required } from "./store.mjs";
import { completionPolicy } from "./verification.mjs";
import { editorTarget } from "./editor.mjs";
import { git } from "./git.mjs";

const conflict = (message) => new DomainError(message, 409);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function processGroupState(record) {
  const tracked = record.process;
  if (tracked?.groupId == null) return "unsupported";
  // 한번 부재를 확인한 그룹 번호를 재사용된 다른 프로세스에 다시 연결하지 않는다.
  if (tracked.groupState === "absent") return "absent";
  if (
    process.platform === "win32" ||
    !Number.isSafeInteger(tracked.groupId) ||
    tracked.groupId <= 1
  )
    return "unknown";
  try {
    process.kill(-tracked.groupId, 0);
    return "present";
  } catch (error) {
    return error.code === "ESRCH" ? "absent" : "unknown";
  }
}

export async function deploymentCommand(input) {
  const command = completionPolicy({
    completion: "manual",
    checks: [input],
    confirm: true,
  }).checks[0];
  if (!isAbsolute(command.command[0]))
    throw new DomainError(
      "배포 실행 파일은 절대 경로로 지정해 주세요. 셸 명령문이 아니라 실행 파일과 인수를 나눠 입력합니다.",
    );
  const executable = await realpath(command.command[0]).catch(() => {
    throw conflict("배포 실행 파일을 찾지 못했습니다.");
  });
  if (!(await stat(executable)).isFile())
    throw conflict("배포 실행 파일을 확인해 주세요.");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(executable)) digest.update(chunk);
  return {
    ...command,
    executable,
    executableHash: digest.digest("hex"),
    processTracking:
      process.platform === "win32" ? "parent-only" : "posix-group",
  };
}

export class Deployment {
  constructor(store, runner) {
    Object.assign(this, { store, runner });
    this.running = new Map();
    for (const project of store.all("projects"))
      if (project.deployment?.status === "running")
        this.finish(project.id, {
          ...project.deployment,
          status: "unconfirmed",
          message:
            "실행부가 재시작됐습니다. 배포 명령과 외부 서비스 상태를 확인해 주세요. 재실행하지 않았습니다.",
        });
  }
  async preview(id, input) {
    const project = this.store.get("projects", id);
    if (this.runner.stopping || this.stopping)
      throw conflict("종료 중에는 배포를 시작하지 않습니다.");
    if (this.store.hasUnconfirmedOperation(id))
      throw conflict("미확인 Git/배포 결과를 먼저 확인해 주세요.");
    const target = await editorTarget(this.store, this.runner, id);
    if (!project.branch || target.branch !== project.branch)
      throw conflict("등록 당시 원본 브랜치에서 배포해 주세요.");
    if (
      target.active ||
      this.store
        .all("tasks", id)
        .some((t) =>
          ["queued", "running", "waiting", "coordinating"].includes(t.status),
        )
    )
      throw conflict("프로젝트 업무가 끝난 뒤 배포해 주세요.");
    // PATH 재검색 대신 확인한 실행 파일을 사용한다. 실제 실행 직전에도 내용을 대조한다.
    const command = await deploymentCommand(input);
    const runGit = (args) =>
      git(target.path, [
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ]);
    if (await runGit(["status", "--porcelain", "--untracked-files=all"]))
      throw conflict(
        "원본에 커밋하지 않은 변경이 있습니다. 배포할 결과를 먼저 정리해 주세요.",
      );
    const commit = await runGit(["rev-parse", "HEAD"]);
    const preview = {
      projectId: id,
      revision: project.revision,
      path: target.path,
      branch: target.branch,
      commit,
      ...command,
      previous: project.deployment?.id || null,
    };
    return { ...preview, approval: hash(JSON.stringify(preview)) };
  }
  async start(id, input, context = {}) {
    if (input.confirm !== true || input.confirmAccess !== true)
      throw conflict(
        "명령·커밋과 실행 계정의 파일/네트워크 접근·외부 변경·비용 영향을 확인하고 승인해 주세요.",
      );
    if (this.store.projectLocks.has(id) && !context.lockHeld)
      throw conflict("프로젝트 변경이 끝난 뒤 배포해 주세요.");
    if (!context.lockHeld) this.store.projectLocks.add(id);
    let started = false;
    try {
      const preview = await this.preview(id, input);
      context.authorize?.(preview);
      if (preview.approval !== input.approval)
        throw conflict(
          "확인 후 명령·파일·커밋·프로젝트가 변경됐습니다. 다시 확인해 주세요.",
        );
      if (preview.previous && input.confirmRepeat !== true)
        throw conflict(
          "이전 배포의 외부 효과와 중복 실행 가능성을 확인해 주세요.",
        );
      if (this.runner.stopping || this.stopping)
        throw conflict("종료 중에는 배포를 시작하지 않습니다.");
      const record = {
        ...preview,
        id: randomUUID(),
        status: "running",
        startedAt: new Date().toISOString(),
        process: { pid: null, closed: false },
        ...(context.policyId
          ? { policyId: context.policyId, taskId: context.taskId }
          : {}),
      };
      // 외부 효과가 일어나기 전에 승인과 시작 기록을 저장한다.
      this.store.update("projects", id, { deployment: record });
      const execution = this.execute(id, record).finally(() => {
        this.running.delete(id);
        if (!context.lockHeld) this.store.projectLocks.delete(id);
        queueMicrotask(() => this.runner.pump());
      });
      this.running.set(id, execution);
      started = true;
      return { id: record.id, status: "running" };
    } finally {
      if (!started && !context.lockHeld) this.store.projectLocks.delete(id);
    }
  }
  async execute(id, record) {
    let child;
    try {
      // 배포는 사용자가 명시적으로 승인한 호스트 명령이다. 에이전트 샌드박스로 표시하지 않는다.
      // 출력에는 인증 정보가 포함될 수 있어 UI/보고/서버 로그에 자동 복사하지 않는다.
      child = spawn(record.executable, record.command.slice(1), {
        cwd: record.path,
        shell: false,
        windowsHide: true,
        detached: record.processTracking === "posix-group",
        stdio: ["ignore", "ignore", "ignore"],
      });
      let timedOut = false;
      let recordingFailed = false;
      const timer = setTimeout(() => {
        timedOut = true;
        record.timedOut = true;
        record.message =
          "제한 시간이 지나 원 명령의 종료를 요청합니다. 실제 종료 전에는 새 실행과 앱 종료를 기다립니다. 외부 처리 취소를 의미하지 않습니다.";
        try {
          this.store.update("projects", id, { deployment: record });
        } catch {
          recordingFailed = true;
        }
        try {
          child.kill("SIGTERM");
        } catch {
          /* 종료 요청 실패도 close 전까지 실행 자리를 유지한다. */
        }
      }, record.timeoutSeconds * 1000);
      const terminal = await new Promise((resolve) => {
        let failed = false;
        child.once("error", () => {
          failed = true;
        });
        child.once("close", (code, signal) =>
          resolve({ code, signal, failed }),
        );
        record.process.pid = child.pid || null;
        record.process.groupId =
          record.processTracking === "posix-group" ? child.pid || null : null;
        try {
          this.store.update("projects", id, { deployment: record });
        } catch {
          recordingFailed = true;
          child.kill("SIGTERM");
        }
      }).finally(() => clearTimeout(timer));
      record.process = { ...record.process, closed: true, ...terminal };
      const groupState = processGroupState(record);
      record.process.groupState = groupState;
      record.process.groupCheckedAt = new Date().toISOString();
      const succeeded =
        !recordingFailed &&
        !timedOut &&
        !terminal.failed &&
        terminal.code === 0 &&
        ["absent", "unsupported"].includes(groupState);
      this.finish(id, {
        ...record,
        status: succeeded ? "succeeded" : "unconfirmed",
        timedOut,
        message: succeeded
          ? "배포 명령이 종료 코드 0으로 끝났습니다. 서비스 상태와 외부 비동기 작업의 성공은 배포 서비스에서 별도로 확인하세요."
          : ["present", "unknown"].includes(groupState)
            ? `상위 배포 명령은 종료됐지만 프로세스 그룹 ${record.process.groupId}의 종료를 확인하지 못했습니다. 후속 프로세스와 외부 서비스 상태를 확인해 주세요. 자동 재실행하거나 남은 프로세스를 임의로 종료하지 않았습니다.`
            : "배포 명령이 정상 완료되지 않았습니다. 일부 외부 변경이 발생했을 수 있습니다. 명령/후속 프로세스와 서비스 상태를 확인하세요. 자동 재시도하지 않습니다.",
      });
    } catch {
      // 시작/기록 실패에서도 실행 부재를 추정하거나 재실행하지 않는다.
      this.finish(id, {
        ...record,
        process: child ? record.process : { pid: null, closed: true },
        status: "unconfirmed",
        message:
          "배포 실행 결과를 확정하지 못했습니다. 실행 환경과 외부 서비스에서 상태를 확인해 주세요.",
      });
    }
  }
  finish(id, record) {
    this.store.transaction(() => {
      this.store.update("projects", id, {
        deployment: { ...record, finishedAt: new Date().toISOString() },
      });
      this.store.insert("reports", {
        projectId: id,
        kind: "deployment",
        deploymentId: record.id,
        taskId: record.taskId,
        deployment: record,
        title:
          record.status === "succeeded"
            ? "배포 명령 종료"
            : "배포 결과 확인 필요",
        text: `${record.name}\n${record.path} · ${record.branch}\n커밋: ${record.commit}\n${record.message}`,
      });
    });
  }
  acknowledge(id, input) {
    if (this.store.projectLocks.has(id))
      throw conflict("배포 명령의 종료를 기다려 주세요.");
    const project = this.store.get("projects", id);
    const record = project.deployment;
    if (
      !record ||
      record.status !== "unconfirmed" ||
      input.id !== record.id ||
      input.revision !== project.revision
    )
      throw conflict("최신 배포 기록을 다시 확인해 주세요.");
    if (!record.process?.closed) {
      if (!Number.isSafeInteger(record.process?.pid) || record.process.pid < 1)
        throw conflict(
          "원래 배포 프로세스의 종료 증거가 없습니다. 자동 해제할 수 없습니다.",
        );
      let absent = false;
      try {
        process.kill(record.process.pid, 0);
      } catch (error) {
        absent = error.code === "ESRCH";
      }
      if (!absent)
        throw conflict("원래 배포 프로세스의 종료를 확인하지 못했습니다.");
    }
    const groupState = processGroupState(record);
    if (["present", "unknown"].includes(groupState))
      throw conflict(
        `배포 프로세스 그룹 ${record.process.groupId}의 종료를 아직 확인하지 못했습니다. 후속 프로세스가 끝난 뒤 다시 확인해 주세요.`,
      );
    if (input.confirm !== true)
      throw conflict(
        "후속 프로세스 종료와 외부 서비스의 실제 상태를 확인해 주세요.",
      );
    const note = required(input.note, "외부 서비스에서 확인한 결과", 2000);
    return this.store.transaction(() => {
      const result = this.store.update(
        "projects",
        id,
        {
          deployment: {
            ...record,
            process: {
              ...record.process,
              groupState,
              groupCheckedAt: new Date().toISOString(),
            },
            status: "acknowledged",
            acknowledgedAt: new Date().toISOString(),
            note,
          },
        },
        input.revision,
      );
      this.store.insert("reports", {
        projectId: id,
        kind: "deployment",
        deploymentId: record.id,
        title: "배포 결과 사용자 확인",
        text: `${note}\n사용자가 결과를 확인한 기록입니다. Otter가 서비스 성공을 검증한 것은 아니며 재배포하지 않았습니다.`,
      });
      return result;
    });
  }
  async close() {
    if (this.closed) return;
    this.stopping = true;
    await Promise.all([...this.running.values()]);
    for (const project of this.store.all("projects")) {
      const record = project.deployment;
      if (record?.status !== "unconfirmed" || record.process?.groupId == null)
        continue;
      const groupState = processGroupState(record);
      if (groupState !== "absent") {
        const error = conflict(
          `배포 프로세스 그룹 ${record.process.groupId}의 종료를 확인하지 못했습니다. 해당 실행 환경에서 후속 프로세스가 끝났는지 확인한 뒤 종료를 다시 시도해 주세요. 기록과 잠금을 유지합니다.`,
        );
        error.code = "OTTER_DEPLOYMENT_GROUP_PENDING";
        throw error;
      }
      if (record.process.groupState !== "absent")
        this.store.update("projects", project.id, {
          deployment: {
            ...record,
            process: {
              ...record.process,
              groupState,
              groupCheckedAt: new Date().toISOString(),
            },
          },
        });
    }
    this.closed = true;
  }
}
