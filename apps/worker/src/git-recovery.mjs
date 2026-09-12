import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git } from "./git.mjs";
import { editorTarget } from "./editor.mjs";
import { ProjectPush } from "./push.mjs";
import { DomainError } from "./store.mjs";

const oid = /^[a-f0-9]{40,64}$/;
const conflict = (message) => new DomainError(message, 409);
function processState(record) {
  if (record?.closed === true) return "closed";
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1) return "unknown";
  try {
    process.kill(record.pid, 0);
    return "running";
  } catch (error) {
    return error.code === "ESRCH" ? "closed" : "unknown";
  }
}

export class GitRecovery {
  constructor(store, runner) {
    Object.assign(this, { store, runner });
  }
  available(projectId) {
    if (
      this.store.projectLocks.has(projectId) ||
      this.store
        .all("tasks", projectId)
        .some(
          (task) =>
            this.runner.active.has(task.id) ||
            task.executionUnconfirmed ||
            ["running", "waiting", "coordinating"].includes(task.status),
        )
    )
      throw conflict(
        "프로젝트 실행이 진행 중입니다. 종료가 확인된 뒤 Git 결과를 대조해 주세요.",
      );
  }
  async observe(kind, id) {
    if (!["merge", "push"].includes(kind))
      throw new DomainError("Git 작업 종류를 확인해 주세요.");
    const table = kind === "merge" ? "tasks" : "projects";
    const item = this.store.get(table, id);
    const record = item[kind];
    if (
      !record ||
      !["applying", "sending", "unconfirmed"].includes(record.status)
    )
      throw conflict("결과 확인이 필요한 Git 실행 기록이 없습니다.");
    if (!oid.test(record.commit || ""))
      throw conflict("기록한 Git 커밋을 확인하지 못했습니다.");
    const projectId = kind === "merge" ? item.projectId : id;
    this.available(projectId);
    const target = await editorTarget(this.store, this.runner, projectId);
    if (record.path && record.path !== target.path)
      throw conflict(
        "원래 실행한 저장소 경로와 다릅니다. 다른 저장소의 결과로 처리하지 않습니다.",
      );
    const run = (args) =>
      git(target.path, [
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ]);
    const ref = "refs/heads/" + record.branch;
    await run(["check-ref-format", ref]);
    const execution = processState(record.process);
    if (kind === "merge" && execution === "closed") {
      const filters = await run([
        "config",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process)$",
      ]).catch((error) => {
        if (error.code === 1) return "";
        throw error;
      });
      if (filters)
        throw conflict(
          "파일 필터 설정이 있어 작업 파일을 자동 대조하지 않습니다. 외부 IDE에서 확인해 주세요.",
        );
    }
    let actual = "",
      outcome = "unknown",
      message;
    const contains = async (head) => {
      if (head === record.commit) return true;
      if (!head) return false;
      const grafts = await readFile(
        resolve(
          target.path,
          await run(["rev-parse", "--git-path", "info/grafts"]),
        ),
        "utf8",
      ).catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (grafts.trim())
        throw conflict(
          "Git grafts 이력 설정이 있어 자동 대조하지 않습니다. 외부 IDE에서 확인해 주세요.",
        );
      return run(["merge-base", "--is-ancestor", record.commit, head]).then(
        () => true,
        (error) => {
          if (error.code === 1 || error.code === 128) return false;
          throw error;
        },
      );
    };
    if (kind === "merge") {
      actual = await run(["rev-parse", "--verify", ref]);
      const included = await contains(actual);
      if (included && execution === "closed") {
        outcome = "applied";
        message =
          "승인했던 병합 커밋이 원본 브랜치 이력에 있습니다. 파일을 다시 변경하지 않고 반영 기록을 복원할 수 있습니다. 이후 수정이나 되돌리기의 결과는 별개입니다.";
      } else if (
        execution === "closed" &&
        actual === record.base &&
        target.branch === record.branch &&
        !(await run(["status", "--porcelain", "--untracked-files=all"]))
      ) {
        const states = await Promise.all(
          ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"].map(
            (name) =>
              run(["rev-parse", "--verify", "-q", name]).then(
                () => true,
                (error) => {
                  if (error.code === 1) return false;
                  throw error;
                },
              ),
          ),
        );
        if (!states.some(Boolean)) {
          outcome = "not-applied";
          message =
            "Git 실행 종료와 변경 전 원본 상태를 확인했습니다. 미반영으로 기록한 뒤 원인을 해결하고 새로 승인할 수 있습니다.";
        }
      }
    } else {
      const push = new ProjectPush(this.store, this.runner);
      const url = await push.validateURL(target.path, record.url);
      actual = await push.remoteHead(target.path, url, ref);
      if (actual && actual !== record.commit && execution === "closed")
        await push.fetchHistory(target.path, url, actual);
      if ((await contains(actual)) && execution === "closed") {
        outcome = "applied";
        message =
          "전송하려던 커밋이 원래 원격 브랜치 이력에 있습니다. 재전송 없이 결과 기록을 복원할 수 있습니다. 이전 명령 자체의 성공과 서버 CI/CD 결과를 단정하지 않습니다.";
      } else if (
        execution === "closed" &&
        record.rejected === true &&
        actual !== record.commit
      ) {
        outcome = "not-applied";
        message =
          "대상 브랜치의 명시적 전송 거부와 Git 종료를 확인했습니다. 미전송으로 기록한 뒤 새 승인으로 진행할 수 있습니다. 서버 자동화의 부수 효과는 별도 확인하세요.";
      }
    }
    if (!message)
      message =
        execution === "running"
          ? "기록한 Git 프로세스가 아직 존재합니다. 성공/실패나 종료로 처리하지 않고 기다립니다."
          : execution === "unknown"
            ? "실행 종료 증거가 부족합니다. 현재 Git 상태만으로 실행을 재개하지 않습니다."
            : "현재 상태만으로 이전 실행 결과를 확정할 수 없습니다. 이력 변경이나 원격 처리 중일 가능성이 있어 자동 재실행하지 않습니다.";
    this.available(projectId);
    if (this.store.get(table, id).revision !== item.revision)
      throw conflict("대조 중 실행 기록이 바뀌었습니다. 다시 조회해 주세요.");
    const observation = {
      kind,
      id,
      projectId,
      revision: item.revision,
      record,
      path: target.path,
      actual,
      execution,
      outcome,
      message,
    };
    return {
      ...observation,
      approval: createHash("sha256")
        .update(JSON.stringify(observation))
        .digest("hex"),
    };
  }
  async resolve(kind, id, input) {
    if (input.confirm !== true || !/^[a-f0-9]{64}$/.test(input.approval || ""))
      throw new DomainError(
        "대조한 결과를 확인하고 기록 반영을 승인해 주세요.",
      );
    const observation = await this.observe(kind, id);
    if (observation.approval !== input.approval)
      throw conflict(
        "Git 상태나 실행 기록이 바뀌었습니다. 다시 대조해 주세요.",
      );
    if (observation.outcome === "unknown")
      throw conflict(
        "결과를 확정할 증거가 부족합니다. 미확인 상태를 유지합니다.",
      );
    const applied = observation.outcome === "applied";
    const table = kind === "merge" ? "tasks" : "projects";
    const status =
      kind === "merge"
        ? applied
          ? "merged"
          : "not-applied"
        : applied
          ? "pushed"
          : "not-pushed";
    this.store.transaction(() => {
      this.store.update(
        table,
        id,
        {
          [kind]: {
            ...observation.record,
            status,
            recoveredAt: new Date().toISOString(),
            observedCommit: observation.actual,
            observedExecution: observation.execution,
          },
        },
        observation.revision,
      );
      this.store.insert("reports", {
        projectId: observation.projectId,
        ...(kind === "merge" ? { taskId: id } : {}),
        kind,
        title: applied ? "Git 성공 기록 복원" : "Git 미반영 확인",
        text: `${observation.message}\n대상: ${observation.record.url || observation.path} / ${observation.record.branch}\n실행 커밋: ${observation.record.commit}\n관측 커밋: ${observation.actual || "브랜치 없음"}\nGit 파일 변경·병합·푸시의 자동 재실행 없이 기록만 반영했습니다.`,
      });
    });
    this.runner.pump();
    return { status, outcome: observation.outcome };
  }
}
