import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";
import { Runner } from "../src/runner.mjs";
import { git } from "../src/git.mjs";
import { completionPolicy } from "../src/verification.mjs";

const exec = promisify(execFile);
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("검증 조건 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const check = (
  code = "if(require('fs').readFileSync('hello.txt','utf8')!=='hello') process.exit(1)",
) => ({
  name: "결과 파일 검사",
  command: [process.execPath, "-e", code],
  timeoutSeconds: 5,
});

test("검증 정책은 명시적 승인·유효한 명령·시간 제한과 자동 완료의 필수 검사를 요구한다", () => {
  const input = { completion: "verified", checks: [check()], confirm: true };
  assert.deepEqual(completionPolicy(input).checks, input.checks);
  for (const invalid of [
    { confirm: false },
    { checks: [] },
    { completion: "anything" },
    { checks: [{ ...check(), command: [] }] },
    { checks: [{ ...check(), command: ["node\0"] }] },
    { checks: [{ ...check(), timeoutSeconds: 601 }] },
    { checks: Array(9).fill(check()) },
  ])
    assert.throws(() => completionPolicy({ ...input, ...invalid }));
});

test("별도 명령 결과로 자동/수동 완료를 구분하고 변경·실패·중단·종료 미확인을 통과시키지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-verification-"));
  const store = new Store();
  store.settings({ concurrency: 1 });
  const company = new Company(store);
  let behavior = "normal",
    allowClose = true,
    activeCommand,
    commands = 0;
  const calls = [];
  class Fixture extends EventEmitter {
    constructor(cwd) {
      super();
      this.cwd = cwd;
    }
    async initialize() {}
    async request(method, params) {
      calls.push({ method, params, cwd: this.cwd });
      if (method.startsWith("thread/"))
        return { thread: { id: "verification-fixture-thread" } };
      if (method === "turn/start") {
        await writeFile(join(this.cwd, "hello.txt"), "hello");
        setImmediate(() => {
          this.emit("notification", {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                text: "모두 통과했습니다 (실제 검증을 대체하지 않는 합성 직원 주장)",
              },
            },
          });
          this.emit("notification", {
            method: "turn/completed",
            params: { turn: { id: "turn", status: "completed" } },
          });
        });
        return { turn: { id: "turn" } };
      }
      if (method === "command/exec") {
        commands++;
        assert.equal(params.sandboxPolicy.networkAccess, false);
        assert.deepEqual(params.sandboxPolicy.writableRoots, [this.cwd]);
        assert.equal(params.sandboxPolicy.excludeSlashTmp, true);
        assert.ok(this.cwd.includes("verification/verify-"));
        if (behavior === "hold")
          return new Promise((resolve) => {
            activeCommand = resolve;
          });
        if (behavior === "error") throw new Error("합성 응답 유실");
        try {
          const result = await exec(
            params.command[0],
            params.command.slice(1),
            { cwd: this.cwd, timeout: params.timeoutMs },
          );
          return { exitCode: 0, ...result };
        } catch (error) {
          return {
            exitCode: typeof error.code === "number" ? error.code : 124,
            stdout: error.stdout || "",
            stderr: error.stderr || "",
          };
        }
      }
      if (method === "command/exec/terminate") {
        activeCommand?.({ exitCode: 137, stdout: "", stderr: "" });
        return {};
      }
      throw new Error("예상하지 않은 API " + method);
    }
    refuse() {}
    async close() {
      if (!allowClose && this.cwd.includes("verification/verify-"))
        throw new Error("합성 종료 미확인");
      this.closed = true;
    }
  }
  const runner = new Runner(store, directory, ({ cwd }) => new Fixture(cwd));
  try {
    const org = company.createCompany({ name: "검증 회사", mode: "group" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const employee = company.createEmployee({
      name: "개발자",
      role: "구현",
      instructions: "합성 검사",
    });
    const assignment = company.assign(project.id, employee.id);
    const configure = (completion, checks) =>
      company.configureCompletion(project.id, {
        revision: store.get("projects", project.id).revision,
        completion,
        checks,
        confirm: true,
      });
    const request = () =>
      company.requestTask({
        projectId: project.id,
        assignmentId: assignment.id,
        prompt: "결과 만들기",
      });
    assert.throws(
      () =>
        company.configureCompletion(project.id, {
          revision: 0,
          completion: "manual",
          checks: [],
        }),
      /변경|버전/,
    );
    for (const [mode, code, expected] of [
      ["verified", undefined, "completed"],
      ["manual", undefined, "review"],
      ["verified", "process.exit(1)", "blocked"],
      [
        "verified",
        "require('fs').writeFileSync('hello.txt','changed')",
        "blocked",
      ],
      ["verified", "setTimeout(()=>{},10000)", "blocked"],
    ]) {
      const policy = configure(mode, [{ ...check(code), timeoutSeconds: 1 }]);
      const task = request();
      configure("manual", []); // 실행 중 사용자 옵션 변경으로 과거 스냅샷이 바뀌지 않는다.
      runner.pump();
      await until(
        () =>
          !runner.active.has(task.id) &&
          store.get("tasks", task.id).status !== "queued",
      );
      const result = store.get("tasks", task.id);
      assert.equal(result.status, expected);
      assert.deepEqual(result.checks, policy.checks);
      assert.equal(
        await readFile(join(result.worktree.path, "hello.txt"), "utf8"),
        "hello",
      );
      assert.equal(
        await git(project.root, ["show", "HEAD:hello.txt"]).catch(
          () => "absent",
        ),
        "absent",
        "기본 브랜치로 병합하지 않는다",
      );
      const report = store.all("reports").find((r) => r.taskId === task.id);
      assert.equal(report.verificationResult.commit, result.resultCommit);
      assert.equal(
        report.verificationResult.status,
        result.verification.status,
      );
      if (mode === "manual") {
        runner.accept(task.id, { revision: result.revision, confirm: true });
        assert.equal(store.get("tasks", task.id).status, "completed");
      }
      if (expected === "completed") {
        assert.equal(result.acceptedBy, "verification");
        assert.equal(result.verification.checks[0].exitCode, 0);
      }
    }
    for (const kind of ["error", "hold", "close-fail"]) {
      behavior = kind === "close-fail" ? "normal" : kind;
      configure("verified", [check()]);
      const task = request();
      allowClose = kind !== "close-fail";
      runner.pump();
      if (kind === "hold") {
        await until(() => activeCommand);
        assert.equal(
          store.get("tasks", task.id).verification.status,
          "running",
        );
        assert.equal(runner.active.size, 1);
        await runner.cancel(task.id);
        assert.equal(store.get("tasks", task.id).status, "interrupted");
      } else {
        await until(() => store.get("tasks", task.id).status === "blocked");
        if (kind === "close-fail") {
          assert.equal(runner.active.size, 1);
          assert.equal(
            store.get("tasks", task.id).verification.status,
            "unconfirmed",
          );
          allowClose = true;
          await runner.cancel(task.id);
          assert.equal(runner.active.size, 0);
        }
      }
      assert.notEqual(
        store.get("tasks", task.id).verification.status,
        "passed",
      );
    }
    assert.ok(commands >= 8);
    behavior = "normal";
    configure("verified", [check("process.exit(1)"), check()]);
    const skipped = request();
    runner.pump();
    await until(() => store.get("tasks", skipped.id).status === "blocked");
    assert.equal(
      store.get("tasks", skipped.id).verification.checks[1].status,
      "pending",
    );
    const completed = store
      .all("tasks")
      .find((t) => t.acceptedBy === "verification");
    const continuing = company.continueTask(completed.id, {
      prompt: "새 요청은 새 검증 기준으로",
    });
    assert.equal(continuing.acceptedBy, null);
    assert.equal(continuing.verification, null);
    await runner.cancel(continuing.id);
    behavior = "hold";
    activeCommand = null;
    configure("verified", [check()]);
    const quitting = request();
    runner.pump();
    await until(() => activeCommand);
    await runner.close();
    assert.equal(store.get("tasks", quitting.id).status, "interrupted");
    assert.equal(runner.active.size, 0);
    const recovering = request();
    store.update("tasks", recovering.id, {
      status: "running",
      verification: { status: "running", checks: [] },
    });
    const recovery = new Runner(store, directory, () => {
      throw new Error("중단된 검증을 재실행하면 안 된다");
    });
    recovery.pump();
    assert.equal(store.get("tasks", recovering.id).status, "interrupted");
    assert.equal(
      store.get("tasks", recovering.id).verification.status,
      "interrupted",
    );
    await recovery.close();
    assert.ok(
      calls
        .filter((call) => call.cwd.includes("verification/verify-"))
        .every((call) => !call.method.startsWith("thread/")),
      "별도 검증은 모델/새 직원 생성이 아니다",
    );
  } finally {
    allowClose = true;
    await runner.close();
    store.close();
  }
});
