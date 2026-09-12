import { join } from "node:path";
import { DomainError, choice, required } from "./store.mjs";
import { isolatedWorktree, git } from "./git.mjs";

export function completionPolicy(input) {
  const completion = choice(
    input.completion,
    ["manual", "verified"],
    "완료 방식",
  );
  if (!Array.isArray(input.checks) || input.checks.length > 8)
    throw new DomainError("검증 명령은 최대 8개입니다.");
  const checks = input.checks.map((check) => {
    if (
      !check ||
      typeof check !== "object" ||
      !Array.isArray(check.command) ||
      !check.command.length ||
      check.command.length > 64
    )
      throw new DomainError("실행 파일과 인수를 확인해 주세요.");
    const command = check.command.map((arg) => {
      if (typeof arg !== "string" || arg.length > 2000 || arg.includes("\0"))
        throw new DomainError(
          "명령 인수는 NUL 문자 없이 2,000자 이하여야 합니다.",
        );
      return arg;
    });
    required(command[0], "실행 파일", 2000);
    if (
      !Number.isInteger(check.timeoutSeconds) ||
      check.timeoutSeconds < 1 ||
      check.timeoutSeconds > 600
    )
      throw new DomainError("검증 제한 시간은 1~600초입니다.");
    return {
      name: required(check.name, "검증 이름", 120),
      command,
      timeoutSeconds: check.timeoutSeconds,
    };
  });
  if (completion === "verified" && !checks.length)
    throw new DomainError("자동 완료에는 검증 명령이 하나 이상 필요합니다.");
  if (checks.length && input.confirm !== true)
    throw new DomainError("검증 명령의 실행 범위와 자동 실행에 동의해 주세요.");
  return { completion, checks };
}

// 생성 모델의 보고와 분리된 명령 실행이다. 테스트의 의미/커버리지까지 보증하지 않는다.
export async function verifyTask(task, run, store, directory, makeCodex) {
  const result = {
    status: "running",
    commit: task.resultCommit,
    checks: (task.checks || []).map((check) => ({
      ...check,
      status: "pending",
    })),
    startedAt: new Date().toISOString(),
  };
  const save = () =>
    store.update("tasks", task.id, { verification: structuredClone(result) });
  save();
  try {
    if (!task.resultCommit || !task.checks?.length)
      throw new Error("검증할 커밋 또는 승인된 검증 명령이 없습니다.");
    const project = store.get("projects", task.projectId);
    const key = `verify-${task.id}-${task.generation || 1}`;
    const worktree = await isolatedWorktree(
      project.root,
      join(directory, "verification", key),
      key,
      task.resultCommit,
    );
    result.path = worktree.path;
    if (run.cancelled) throw new Error("사용자가 검증을 중단했습니다.");
    const client = makeCodex({ cwd: worktree.path });
    run.verifier = client;
    client.on("request", (message) => client.refuse(message.id));
    await client.initialize();
    for (const [index, entry] of result.checks.entries()) {
      if (run.cancelled) throw new Error("사용자가 검증을 중단했습니다.");
      entry.status = "running";
      entry.startedAt = new Date().toISOString();
      save();
      run.verificationProcess = `${task.id}-${index}`;
      try {
        const response = await client.request(
          "command/exec",
          {
            command: entry.command,
            processId: run.verificationProcess,
            cwd: worktree.path,
            timeoutMs: entry.timeoutSeconds * 1000,
            outputBytesCap: 16384,
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [worktree.path],
              networkAccess: false,
              excludeSlashTmp: true,
              excludeTmpdirEnvVar: true,
            },
          },
          (entry.timeoutSeconds + 15) * 1000,
        );
        if (!Number.isInteger(response?.exitCode))
          throw new Error("검증 명령의 종료 코드를 확인하지 못했습니다.");
        run.verificationProcess = null;
        entry.exitCode = response.exitCode;
        entry.status = response.exitCode === 0 ? "passed" : "failed";
        if (
          response.exitCode !== 0 &&
          /bwrap:.*(?:failed|operation not permitted)/i.test(
            response.stderr || "",
          )
        ) {
          entry.status = "error";
          entry.note =
            "실행 환경의 샌드박스 초기화가 차단됐습니다. 보호를 끄지 않고 실행 환경을 확인해 주세요.";
        }
        // 명령 출력에는 자격 증명이 섞일 수 있어 대화/보고로 자동 복사하지 않는다.
      } catch {
        entry.status = "error";
        throw new Error(
          "검증 실행을 확인하지 못했습니다. CLI·샌드박스·제한 시간을 확인해 주세요.",
        );
      } finally {
        entry.finishedAt = new Date().toISOString();
        save();
      }
      if (entry.status !== "passed")
        throw new Error(
          `검증 실패: ${entry.name} (종료 코드 ${entry.exitCode})${entry.note ? " · " + entry.note : ""}`,
        );
    }
    if (
      (await git(worktree.path, [
        "diff",
        "--name-only",
        task.resultCommit,
        "--",
      ])) ||
      (await git(worktree.path, ["rev-parse", "HEAD"])) !== task.resultCommit
    )
      throw new Error(
        "검증 중 추적 파일이나 커밋이 변경됐습니다. 원래 결과를 통과로 처리하지 않습니다.",
      );
    if (
      (await git(task.worktree.path, ["rev-parse", "HEAD"])) !==
        task.resultCommit ||
      (await git(task.worktree.path, ["status", "--porcelain"]))
    )
      throw new Error(
        "검증 중 원래 작업 결과가 변경됐습니다. 사용자 확인이 필요합니다.",
      );
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
  } finally {
    // 종료 미확인은 호출자가 실행 자리를 유지한다. 성공 기록도 아직 확정하지 않는다.
    await stopVerification(run);
  }
  if (run.cancelled) {
    result.status = "interrupted";
    result.error = "사용자가 검증을 중단했습니다.";
  }
  result.finishedAt = new Date().toISOString();
  save();
  return result;
}

export async function stopVerification(run) {
  if (!run.verifier) return;
  if (run.verificationProcess && !run.verifier.closed) {
    // 종료 요청 자체는 성공 증거가 아니다. 원 명령의 응답과 프로세스 close도 확인한다.
    await run.verifier
      .request("command/exec/terminate", { processId: run.verificationProcess })
      .catch(() => {});
  }
  await run.verifier.close();
}
