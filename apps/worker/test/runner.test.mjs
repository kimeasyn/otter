import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  writeFile,
  readFile,
  access,
  mkdir,
  symlink,
  rename,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";
import { Runner } from "../src/runner.mjs";
import {
  approvalReview,
  localApprovalEnvironment,
} from "../src/approval-review.mjs";
import { git } from "../src/git.mjs";

class TestCodex extends EventEmitter {
  replies = [];
  async initialize() {}
  async request(method) {
    if (["thread/start", "thread/resume"].includes(method))
      return { thread: { id: "test-thread" } };
    if (method === "turn/start") {
      this.started = true;
      return { turn: { id: "test-turn" } };
    }
    if (method === "turn/interrupt")
      this.emit("notification", {
        method: "turn/completed",
        params: { turn: { status: "interrupted" } },
      });
  }
  reply(id, result) {
    this.replies.push({ id, result });
  }
  refuse(id) {
    this.replies.push({ id, refused: true });
  }
  close() {}
  fail(info = { httpConnectionFailed: { httpStatusCode: 503 } }) {
    this.emit("notification", {
      method: "turn/completed",
      params: {
        turn: {
          id: "test-turn",
          status: "failed",
          error: { message: "합성 제공자 오류", codexErrorInfo: info },
        },
      },
    });
  }
  complete() {
    this.emit("notification", {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          text: "합성 테스트 보고입니다. 실제 모델 실행이 아닙니다.",
        },
      },
    });
    this.emit("notification", {
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
  }
}
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("테스트 조건 시간 초과");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test("사용자 추가 지시는 같은 실행에만 전달하고 거절·불확정·중단·재시작에서 중복 실행하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-steering-"));
  const store = new Store(),
    company = new Company(store);
  let mode = "accept",
    pendingReject;
  const methods = [],
    clients = [];
  const runner = new Runner(store, directory, () => {
    const client = new TestCodex();
    const original = client.request.bind(client);
    client.request = async (method, input) => {
      methods.push({ method, input });
      if (method !== "turn/steer") return original(method, input);
      if (mode === "reject")
        throw Object.assign(new Error("합성 거절"), { rpcRejected: true });
      if (mode === "unknown") throw new Error("합성 연결 단절");
      if (mode === "hold")
        return new Promise((_, reject) => {
          pendingReject = reject;
        });
      return { turnId: input.expectedTurnId };
    };
    client.close = () => {
      pendingReject?.(new Error("합성 연결 종료"));
      pendingReject = null;
    };
    clients.push(client);
    return client;
  });
  try {
    const org = company.createCompany({ name: "추가 지시", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "합성 검사",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "원래 요청",
      channel: "project",
    });
    await assert.rejects(
      runner.steer(task.id, { prompt: "대기 중 요청" }),
      /현재 추가 지시/,
    );
    runner.pump();
    await until(() => store.get("tasks", task.id).providerTurnId);
    const current = store.get("tasks", task.id);
    const input = {
      prompt: "테스트부터 해줘",
      generation: current.generation,
      turnId: current.providerTurnId,
    };
    await assert.rejects(
      runner.steer(task.id, { ...input, turnId: "다른 실행" }),
      /실행이 변경/,
    );
    await assert.rejects(
      runner.steer(task.id, { ...input, generation: current.generation + 1 }),
      /실행이 변경/,
    );
    await assert.rejects(
      runner.steer(task.id, { ...input, prompt: " " }),
      /추가 지시/,
    );
    assert.equal(store.all("messages").length, 1);
    const message = await runner.steer(task.id, {
      ...input,
      assignmentId: "다른 직원",
      projectId: "다른 프로젝트",
      channel: "direct",
    });
    assert.equal(message.delivery, "delivered");
    assert.equal(message.projectId, project.id);
    assert.equal(message.assignmentId, assignment.id);
    assert.equal(message.taskId, task.id);
    assert.equal(message.channel, "project");
    assert.deepEqual(store.get("tasks", task.id), current);
    assert.equal(store.all("tasks").length, 1);
    assert.deepEqual(methods.at(-1).input, {
      threadId: current.providerThreadId,
      expectedTurnId: current.providerTurnId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
    });
    mode = "reject";
    assert.equal(
      (await runner.steer(task.id, { ...input, prompt: "거절 검사" })).delivery,
      "rejected",
    );
    mode = "unknown";
    assert.equal(
      (await runner.steer(task.id, { ...input, prompt: "불확정 검사" }))
        .delivery,
      "unconfirmed",
    );
    const calls = methods.length;
    await assert.rejects(runner.steer(task.id, input), /전달 여부가 미확인/);
    assert.equal(methods.length, calls);
    clients[0].fail();
    await until(() => !runner.active.has(task.id));
    assert.equal(store.get("tasks", task.id).status, "failed");
    assert.equal(store.get("tasks", task.id).retryCount, 0);
    // 명시적 후속 실행에도 미확정 추가 지시를 프로젝트 수신함으로 자동 재전송하지 않는다.
    company.continueTask(task.id, {
      prompt: "결과를 확인했으니 다음 검토를 해줘",
    });
    runner.pump();
    await until(
      () => clients.length === 2 && store.get("tasks", task.id).providerTurnId,
    );
    assert.ok(
      !JSON.stringify(
        methods.filter((m) => m.method === "turn/start").at(-1).input,
      ).includes("불확정 검사"),
    );
    const resumed = store.get("tasks", task.id);
    mode = "hold";
    const pending = runner.steer(task.id, {
      ...input,
      generation: resumed.generation,
    });
    await until(() => pendingReject);
    await assert.rejects(
      runner.steer(task.id, { ...input, generation: resumed.generation }),
      /앞선 추가 지시/,
    );
    await runner.close();
    assert.equal((await pending).delivery, "unconfirmed");
    assert.equal(runner.active.size, 0);
    assert.equal(methods.filter((m) => m.method === "turn/start").length, 2);
    const crash = store.insert("messages", {
      projectId: project.id,
      taskId: task.id,
      kind: "steering",
      delivery: "sending",
      text: "재시작 검사",
    });
    const recovered = new Runner(store, directory, () => {
      throw new Error("재시작 자동 실행 금지");
    });
    assert.equal(store.get("messages", crash.id).delivery, "unconfirmed");
    await recovered.close();
    console.log(
      JSON.stringify({
        directory,
        sameRun: true,
        noReplay: true,
        closeSettled: true,
      }),
    );
  } finally {
    await runner.close();
    store.close();
  }
});

test("정상 중단은 재시작 뒤 동의한 동일 업무로 재개하고 원본 파일·대화·채널을 유지하며 변경 브랜치와 미확인 종료를 거절한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-resume-"));
  const database = join(directory, "records.db");
  let store = new Store(database),
    company = new Company(store);
  const clients = [],
    methods = [];
  const makeCodex = () => {
    const client = new TestCodex(),
      calls = [];
    const request = client.request.bind(client);
    client.request = async (method, input) => {
      calls.push({ method, input });
      return request(method, input);
    };
    clients.push(client);
    methods.push(calls);
    return client;
  };
  let runner = new Runner(store, directory, makeCodex);
  try {
    const org = company.createCompany({ name: "재개 검사", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "검사 자료",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "기존 작업",
      channel: "project",
    });
    runner.pump();
    await until(() => clients[0]?.started);
    const original = store.get("tasks", task.id);
    const file = join(original.worktree.path, "partial.txt");
    await writeFile(file, "아직 커밋하지 않은 작업");
    await runner.close();
    assert.equal(store.get("tasks", task.id).interruptionConfirmed, true);
    store.close();
    store = new Store(database);
    company = new Company(store);
    runner = new Runner(store, directory, makeCodex);
    const stopped = store.get("tasks", task.id);
    runner.pump();
    assert.equal(
      runner.active.size,
      0,
      "재시작만으로 중단 업무를 재개하지 않는다",
    );
    for (const input of [
      { prompt: "재개" },
      { prompt: "재개", confirmResume: true, revision: stopped.revision - 1 },
    ])
      assert.throws(() => company.continueTask(task.id, input), /재개에 동의/);
    assert.equal(store.all("messages", project.id).length, 1);
    company.continueTask(task.id, {
      prompt: "기존 파일을 확인하고 이어가",
      confirmResume: true,
      revision: stopped.revision,
    });
    assert.throws(() =>
      company.continueTask(task.id, {
        prompt: "중복",
        confirmResume: true,
        revision: stopped.revision,
      }),
    );
    runner.pump();
    await until(() => clients[1]?.started);
    assert.deepEqual(store.get("tasks", task.id).worktree, original.worktree);
    assert.equal(store.get("tasks", task.id).generation, 2);
    assert.equal(
      store.get("tasks", task.id).resumedFrom.revision,
      stopped.revision,
    );
    assert.ok(
      methods[1].some(
        (call) =>
          call.method === "thread/resume" &&
          call.input.threadId === original.providerThreadId,
      ),
    );
    assert.equal(store.all("messages", project.id).at(-1).channel, "project");
    assert.equal(await readFile(file, "utf8"), "아직 커밋하지 않은 작업");
    await runner.cancel(task.id);
    await until(() => !runner.active.has(task.id));
    await git(original.worktree.path, ["checkout", "-b", "manual-branch"]);
    company.continueTask(task.id, {
      prompt: "경로 검사",
      confirmResume: true,
      revision: store.get("tasks", task.id).revision,
    });
    runner.pump();
    await until(() => !runner.active.has(task.id));
    assert.equal(store.get("tasks", task.id).status, "blocked");
    assert.match(
      store.get("tasks", task.id).error,
      /작업 브랜치가 바뀌었습니다/,
    );
    assert.equal(clients.length, 2);
    assert.equal(await readFile(file, "utf8"), "아직 커밋하지 않은 작업");
    await runner.close();
    store.update("tasks", task.id, {
      status: "running",
      interruptionConfirmed: true,
    });
    runner = new Runner(store, directory, makeCodex);
    assert.equal(store.get("tasks", task.id).interruptionConfirmed, false);
    assert.throws(
      () =>
        company.continueTask(task.id, {
          prompt: "종료 불명 재개",
          confirmResume: true,
          revision: store.get("tasks", task.id).revision,
        }),
      /종료 확인 기록/,
    );
    store.update("tasks", task.id, {
      status: "blocked",
      executionUnconfirmed: true,
    });
    assert.throws(
      () => company.continueTask(task.id, { prompt: "다시 요청" }),
      /종료가 확인되지/,
    );
    // 새 작업의 Git 준비 중 종료도 완료될 때까지 기다리고 경로를 보존한다.
    const preparing = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "준비 중 중단",
    });
    runner.pump();
    await runner.close();
    const early = store.get("tasks", preparing.id);
    assert.equal(early.status, "interrupted");
    assert.equal(early.interruptionConfirmed, true);
    await access(early.worktree.path);
    assert.equal(
      clients.length,
      2,
      "Git 준비 중 취소했으므로 새 제공자를 시작하지 않는다",
    );
    store.update("tasks", preparing.id, { mode: "delegate" });
    const child = company.requestTask(
      {
        projectId: project.id,
        assignmentId: assignment.id,
        prompt: "PM 하위 업무",
      },
      { parentTaskId: preparing.id },
    );
    store.update("tasks", child.id, {
      status: "interrupted",
      interruptionConfirmed: false,
    });
    const resume = {
      prompt: "팀 상태 확인 후 진행",
      confirmResume: true,
      revision: store.get("tasks", preparing.id).revision,
    };
    assert.throws(
      () => company.continueTask(preparing.id, resume),
      /팀의 업무/,
    );
    store.update("tasks", child.id, { interruptionConfirmed: true });
    assert.throws(
      () =>
        company.continueTask(child.id, {
          ...resume,
          revision: store.get("tasks", child.id).revision,
        }),
      /상위 PM/,
    );
    company.continueTask(preparing.id, resume);
    assert.equal(
      store.get("tasks", child.id).status,
      "interrupted",
      "부모 재개로 하위 업무를 자동 재실행하지 않는다",
    );
    console.log(
      JSON.stringify({
        directory,
        sameWorktree: true,
        originalFilePreserved: true,
        explicitResume: true,
        changedBranchBlocked: true,
        preparationClosed: true,
      }),
    );
  } finally {
    await runner.close();
    store.close();
  }
});
test("권한 승인 범위·현재 턴·명시 확인·요청 중복·서버 만료를 강제한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-permission-review-"));
  const store = new Store();
  const company = new Company(store);
  const client = new TestCodex();
  const runner = new Runner(store, directory, () => client);
  try {
    const org = company.createCompany({ name: "승인 검사", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const employee = company.createEmployee({
      name: "개발",
      role: "개발",
      instructions: "승인 검사",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "실행 범위 검사",
    });
    runner.pump();
    await until(() => client.started);
    const run = runner.active.get(task.id);
    const profile = {
      network: { enabled: true },
      fileSystem: {
        read: [directory],
        entries: [
          { access: "write", path: { type: "path", path: project.root } },
        ],
      },
    };
    const params = {
      threadId: run.threadId,
      turnId: run.turnId,
      itemId: "permission-1",
      cwd: project.root,
      permissions: profile,
    };
    const request = {
      id: 101,
      method: "item/permissions/requestApproval",
      params,
    };
    client.emit("request", {
      ...request,
      params: { ...params, threadId: "another-thread" },
    });
    assert.equal(client.replies.at(-1).refused, true);
    assert.equal(store.all("approvals").length, 0);
    client.emit("request", request);
    client.emit("request", request);
    assert.equal(store.all("approvals").length, 1);
    const approval = store.all("approvals")[0];
    assert.equal(approval.review.canAccept, true);
    assert.match(approval.review.details.join("\n"), /네트워크 접근 허용/);
    assert.match(approval.review.warning, /현재 턴/);
    assert.throws(
      () => runner.approve(approval.id, { decision: "accept" }),
      /범위/,
    );
    assert.throws(
      () =>
        runner.approve(approval.id, {
          decision: "accept",
          scopeConfirmed: true,
          scope: "session",
          permissions: { network: { enabled: true } },
        }),
      /바꿀 수 없습니다/,
    );
    assert.equal(client.replies.length, 1);
    runner.approve(approval.id, { decision: "accept", scopeConfirmed: true });
    assert.deepEqual(client.replies.at(-1), {
      id: 101,
      result: { permissions: profile, scope: "turn" },
    });
    assert.deepEqual(store.get("approvals", approval.id).resolvedScope, {
      permissions: profile,
      scope: "turn",
    });
    assert.throws(
      () =>
        runner.approve(approval.id, {
          decision: "accept",
          scopeConfirmed: true,
        }),
      /이미 처리/,
    );

    client.emit("request", { ...request, id: 102 });
    let next = store.all("approvals").find((a) => a.requestId === 102);
    runner.approve(next.id, { decision: "decline" });
    assert.deepEqual(client.replies.at(-1).result, {
      permissions: {},
      scope: "turn",
    });
    client.emit("request", { ...request, id: 103 });
    next = store.all("approvals").find((a) => a.requestId === 103);
    client.emit("notification", {
      method: "serverRequest/resolved",
      params: { threadId: run.threadId, requestId: 103 },
    });
    assert.equal(store.get("approvals", next.id).status, "expired");
    assert.throws(
      () =>
        runner.approve(next.id, { decision: "accept", scopeConfirmed: true }),
      /이미 처리/,
    );
    client.emit("request", { ...request, id: 104 });
    next = store.all("approvals").find((a) => a.requestId === 104);
    run.turnId = "next-turn";
    assert.throws(
      () =>
        runner.approve(next.id, { decision: "accept", scopeConfirmed: true }),
      /종료된 턴/,
    );
    run.turnId = params.turnId;
    client.emit("request", {
      ...request,
      id: 104,
      params: { ...params, permissions: { network: { enabled: false } } },
    });
    assert.equal(store.get("approvals", next.id).status, "expired");
    assert.equal(client.replies.at(-1).refused, true);
    client.emit("request", {
      ...request,
      id: 105,
      params: {
        ...params,
        permissions: { network: { enabled: true, futureScope: "all" } },
      },
    });
    next = store.all("approvals").find((a) => a.requestId === 105);
    assert.equal(next.review.canAccept, false);
    assert.throws(
      () =>
        runner.approve(next.id, { decision: "accept", scopeConfirmed: true }),
      /안전하게/,
    );
    runner.approve(next.id, { decision: "decline" });
  } finally {
    await runner.close();
    store.close();
  }
});

test("명령·네트워크·파일 접근 범위를 설명하고 해석하지 못한 권한과 영구 승인만 있는 요청은 차단한다", () => {
  const command = "item/commandExecution/requestApproval";
  let review = approvalReview(command, {
    command: "npm install",
    cwd: "/tmp/project",
    additionalPermissions: {
      network: { enabled: true },
      fileSystem: {
        entries: [
          {
            access: "read",
            path: { type: "special", value: { kind: "root" } },
          },
          {
            access: "write",
            path: { type: "glob_pattern", pattern: "/tmp/project/**" },
          },
        ],
      },
    },
  });
  assert.equal(review.canAccept, true);
  assert.match(review.details.join("\n"), /전체 파일 시스템/);
  assert.match(review.details.join("\n"), /쓰기·삭제: 파일 패턴/);
  review = approvalReview(command, {
    networkApprovalContext: { host: "example.invalid:443", protocol: "https" },
  });
  assert.equal(review.canAccept, true);
  assert.match(review.details[0], /example.invalid:443/);
  assert.match(review.warning, /여러 네트워크 요청/);
  for (const params of [
    { command: "run", cwd: "/tmp", environmentId: "unmapped-environment" },
    { command: "unknown cwd" },
    {
      command: "run",
      cwd: "/tmp",
      availableDecisions: ["acceptForSession", "decline"],
    },
    {
      command: "run",
      cwd: "/tmp",
      additionalPermissions: { fileSystem: { read: ["relative/path"] } },
    },
    {
      command: "run",
      cwd: "/tmp",
      additionalPermissions: {
        fileSystem: {
          entries: [
            {
              access: "write",
              path: {
                type: "special",
                value: { kind: "unknown", path: "future" },
              },
            },
          ],
        },
      },
    },
  ])
    assert.equal(approvalReview(command, params).canAccept, false);
  assert.equal(
    approvalReview("item/fileChange/requestApproval", {}).canAccept,
    false,
  );
});
test("확인된 Codex local 환경만 작업 폴더에 연결하고 승인 직전 경로 변경도 차단한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-local-approval-"));
  const store = new Store();
  const company = new Company(store);
  const client = new TestCodex();
  const originalRequest = client.request.bind(client);
  let cwd;
  client.request = async (method, params) =>
    method === "environment/info"
      ? { cwd: pathToFileURL(cwd).href }
      : originalRequest(method, params);
  const runner = new Runner(store, directory, (options) => {
    cwd = options.cwd;
    return client;
  });
  try {
    const org = company.createCompany({ name: "환경 확인", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const employee = company.createEmployee({
      name: "개발",
      role: "개발",
      instructions: "범위 확인",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "승인 검사",
    });
    runner.pump();
    await until(() => client.started);
    const run = runner.active.get(task.id);
    const method = "item/commandExecution/requestApproval";
    const params = {
      threadId: run.threadId,
      turnId: run.turnId,
      itemId: "local-command",
      environmentId: "local",
      cwd,
      command: "pwd",
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["pwd"] } },
        "cancel",
      ],
    };
    assert.ok(run.approvalEnvironment);
    assert.equal(
      localApprovalEnvironment({ cwd: pathToFileURL(project.root).href }, cwd),
      null,
    );
    assert.equal(
      localApprovalEnvironment({ cwd: "https://example.invalid" }, cwd),
      null,
    );
    assert.equal(localApprovalEnvironment(null, cwd), null);
    assert.equal(approvalReview(method, params).canAccept, false);
    for (const change of [
      { environmentId: "remote" },
      { environmentId: "" },
      { cwd: project.root },
      { cwd: undefined },
      { cwd: join(cwd, "missing") },
      { availableDecisions: ["acceptForSession", "cancel"] },
    ])
      assert.equal(
        approvalReview(
          method,
          { ...params, ...change },
          run.approvalEnvironment,
        ).canAccept,
        false,
      );
    const sub = join(cwd, "sub");
    await mkdir(sub);
    client.emit("request", {
      id: 201,
      method,
      params: { ...params, cwd: sub },
    });
    const approval = store.all("approvals").at(-1);
    assert.equal(approval.review.canAccept, true);
    assert.equal(client.replies.length, 0);
    assert.throws(
      () => runner.approve(approval.id, { decision: "accept" }),
      /범위/,
    );
    await rename(sub, join(cwd, "preserved-sub"));
    await symlink(project.root, sub, "dir");
    assert.throws(
      () =>
        runner.approve(approval.id, {
          decision: "accept",
          scopeConfirmed: true,
        }),
      /안전하게/,
    );
    assert.equal(client.replies.length, 0);
    runner.approve(approval.id, { decision: "cancel" });
    client.emit("request", { id: 202, method, params });
    const valid = store.all("approvals").at(-1);
    assert.equal(valid.review.canAccept, true);
    runner.approve(valid.id, { decision: "accept", scopeConfirmed: true });
    assert.deepEqual(client.replies.at(-1), {
      id: 202,
      result: { decision: "accept" },
    });
    assert.throws(
      () =>
        runner.approve(valid.id, { decision: "accept", scopeConfirmed: true }),
      /이미 처리/,
    );
    assert.equal(store.all("tasks").length, 1);
  } finally {
    await runner.close();
    store.close();
  }
});

test("제공자 종료가 확인되지 않으면 보고 완료와 실행 자리 반환을 보류한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-stop-confirm-"));
  const store = new Store();
  store.settings({ concurrency: 1 });
  const company = new Company(store);
  const clients = [];
  let allowClose = false;
  const runner = new Runner(store, directory, () => {
    const client = new TestCodex();
    client.close = async () => {
      if (!allowClose) throw new Error("프로세스 종료 미확인");
    };
    clients.push(client);
    return client;
  });
  try {
    const org = company.createCompany({ name: "종료 검사", mode: "group" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const tasks = [];
    for (const name of ["첫 직원", "대기 직원"]) {
      const employee = company.createEmployee({
        name,
        role: "개발",
        instructions: "합성 검사",
      });
      const assignment = company.assign(project.id, employee.id);
      tasks.push(
        company.requestTask({
          projectId: project.id,
          assignmentId: assignment.id,
          prompt: "합성 검사",
        }),
      );
    }
    runner.pump();
    await until(() => clients[0]?.started);
    clients[0].complete();
    await until(() => store.get("tasks", tasks[0].id).status === "blocked");
    assert.equal(runner.active.size, 1);
    assert.equal(store.all("reports").length, 0);
    assert.equal(store.get("tasks", tasks[1].id).status, "queued");
    await assert.rejects(runner.close(), /종료를 확인하지 못/);
    assert.equal(runner.active.size, 1);
    allowClose = true;
    await runner.close();
    assert.equal(runner.active.size, 0);
    assert.equal(store.get("tasks", tasks[0].id).status, "interrupted");
  } finally {
    allowClose = true;
    await runner.close();
    store.close();
  }
});
test("종료 확인 후 제한 재시도, 직원 순서, 재시작 복원, 중복 방지와 안전하지 않은 오류 제외", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-retries-"));
  const store = new Store();
  store.settings({ concurrency: 1, retries: 2 });
  const company = new Company(store);
  const clients = [];
  const makeCodex = () => {
    const client = new TestCodex();
    clients.push(client);
    return client;
  };
  let runner = new Runner(store, directory, makeCodex);
  try {
    const org = company.createCompany({ name: "재시도 검사", mode: "group" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const employee = company.createEmployee({
      name: "직원",
      role: "개발",
      instructions: "합성 검사",
    });
    const assignment = company.assign(project.id, employee.id);
    const request = () =>
      company.requestTask({
        projectId: project.id,
        assignmentId: assignment.id,
        prompt: "동일 요청",
      });
    const task = request();
    const later = request();
    runner.pump();
    await until(() => clients[0]?.started);
    const original = store.get("tasks", task.id);
    clients[0].emit("notification", {
      method: "error",
      params: {
        error: { codexErrorInfo: "serverOverloaded" },
        willRetry: true,
      },
    });
    clients[0].emit("notification", {
      method: "turn/completed",
      params: {
        turn: {
          id: "another-turn",
          status: "failed",
          error: { codexErrorInfo: "serverOverloaded" },
        },
      },
    });
    assert.equal(store.get("tasks", task.id).status, "running");
    assert.equal(store.get("tasks", task.id).retryCount, 0);
    let release;
    clients[0].close = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    clients[0].fail();
    assert.equal(runner.active.size, 1);
    assert.equal(store.get("tasks", task.id).retryCount, 0);
    await until(() => typeof release === "function");
    release();
    await until(() => store.get("tasks", task.id).retryAt);
    clients[0].fail(); // 같은 종료 이벤트가 다시 와도 예약/보고는 한 번만.
    const pending = store.get("tasks", task.id);
    assert.equal(pending.retryCount, 1);
    assert.equal(store.all("reports").length, 1);
    assert.equal(store.get("tasks", later.id).status, "queued");
    assert.equal(runner.active.size, 0);
    await runner.close();
    runner = new Runner(store, directory, makeCodex);
    runner.pump();
    await until(() => clients[1]?.started); // 실제 예약 타이머로 재개.
    assert.equal(
      store.get("tasks", task.id).providerThreadId,
      original.providerThreadId,
    );
    assert.deepEqual(store.get("tasks", task.id).worktree, original.worktree);
    assert.deepEqual(store.get("tasks", task.id).documents, original.documents);
    assert.equal(store.get("tasks", later.id).status, "queued");
    store.settings({ retries: 16 }); // 이미 받은 업무의 예산을 소급 확대하지 않는다.
    clients[1].fail();
    await until(() => store.get("tasks", task.id).retryCount === 2);
    store.update("tasks", task.id, { retryAt: new Date(0).toISOString() });
    runner.pump();
    await until(() => clients[2]?.started);
    clients[2].fail();
    await until(() => store.get("tasks", task.id).status === "failed");
    assert.equal(store.get("tasks", task.id).attempt, 3);
    assert.match(store.get("tasks", task.id).error, /한도 2회/);
    assert.equal(store.all("reports").length, 3);
    await until(() => clients[3]?.started);
    clients[3].complete();
    await until(() => store.get("tasks", later.id).status === "review");
    company.continueTask(later.id, { prompt: "새 사용자 요청" });
    assert.equal(store.get("tasks", later.id).maxRetries, 16);
    assert.equal(store.get("tasks", later.id).retryCount, 0);
    await runner.cancel(later.id);

    for (const mode of [
      "unauthorized",
      "sandboxError",
      "other",
      "401",
      "sideEffect",
      "hook",
      "malformed",
      "disconnect",
      "zero",
      "cancel",
    ]) {
      store.settings({ retries: mode === "zero" ? 0 : 2 });
      const next = request();
      runner.pump();
      await until(() => runner.active.get(next.id)?.client?.started);
      const client = runner.active.get(next.id).client;
      if (mode === "sideEffect")
        client.emit("notification", {
          method: "item/started",
          params: { item: { id: "cmd", type: "commandExecution" } },
        });
      if (mode === "disconnect")
        client.emit("disconnected", new Error("연결 유실"));
      else if (mode === "cancel") await runner.cancel(next.id);
      else {
        if (mode === "hook")
          client.emit("notification", { method: "hook/started", params: {} });
        client.fail(
          mode === "401"
            ? { httpConnectionFailed: { httpStatusCode: 401 } }
            : mode === "malformed"
              ? { httpConnectionFailed: null }
              : ["sideEffect", "zero", "hook"].includes(mode)
                ? "serverOverloaded"
                : mode,
        );
      }
      await until(() => !runner.active.has(next.id));
      const ended = store.get("tasks", next.id);
      assert.equal(ended.retryCount, 0, mode);
      assert.equal(ended.retryAt, null, mode);
      assert.equal(
        ended.status,
        ["disconnect", "cancel"].includes(mode) ? "interrupted" : "failed",
        mode,
      );
    }
    const cancelled = request();
    runner.pump();
    await until(() => runner.active.get(cancelled.id)?.client?.started);
    runner.active.get(cancelled.id).client.fail();
    await until(() => store.get("tasks", cancelled.id).retryAt);
    await runner.cancel(cancelled.id);
    runner.pump();
    assert.equal(store.get("tasks", cancelled.id).status, "interrupted");
    assert.equal(runner.active.size, 0);
    const uncertain = request();
    runner.pump();
    await until(() => runner.active.get(uncertain.id)?.client?.started);
    const held = runner.active.get(uncertain.id).client;
    held.close = async () => {
      throw new Error("종료 미확인");
    };
    held.fail();
    await until(() => store.get("tasks", uncertain.id).status === "blocked");
    assert.equal(store.get("tasks", uncertain.id).retryCount, 0);
    assert.equal(runner.active.size, 1);
    held.close = async () => {};
    await runner.close();
    const resumed = company.continueTask(task.id, {
      prompt: "오류 확인했어. 남은 작업을 이어가",
    });
    assert.equal(resumed.retryCount, 0);
    assert.equal(resumed.providerThreadId, original.providerThreadId);
    assert.deepEqual(resumed.worktree, original.worktree);
  } finally {
    await runner.close();
    store.close();
  }
});
test("실제 큐 한도, 승인 전 미응답, 한 번만 승인, 검토 완료 분리", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-queue-"));
  const store = new Store();
  const company = new Company(store);
  const clients = [];
  const runner = new Runner(store, directory, () => {
    const c = new TestCodex();
    clients.push(c);
    return c;
  });
  try {
    const org = company.createCompany({ name: "합성 테스트", mode: "group" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "project",
    });
    const tasks = [];
    for (const name of ["직원 A", "직원 B", "직원 C"]) {
      const e = company.createEmployee({
        name,
        role: "개발",
        instructions: "테스트",
      });
      const a = company.assign(project.id, e.id);
      tasks.push(
        company.requestTask({
          projectId: project.id,
          assignmentId: a.id,
          prompt: "각자 업무",
        }),
      );
    }
    runner.pump();
    await until(() => clients.length === 2 && clients.every((c) => c.started));
    assert.equal(store.get("tasks", tasks[2].id).status, "queued");
    // 첫 두 클라이언트의 작업 시작 순서는 Git I/O 완료 순서에 따라 달라질 수 있다.
    const [taskId, run] = [...runner.active.entries()].find(
      ([, run]) => run.client === clients[0],
    );
    clients[0].emit("request", {
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: {
        command: "git push origin HEAD",
        threadId: run.threadId,
        turnId: run.turnId,
      },
    });
    assert.equal(store.get("tasks", taskId).status, "waiting");
    assert.equal(clients[0].replies.length, 0);
    const approval = store.all("approvals", project.id)[0];
    runner.approve(approval.id, { decision: "decline" });
    assert.deepEqual(clients[0].replies[0], {
      id: 8,
      result: { decision: "decline" },
    });
    assert.throws(
      () => runner.approve(approval.id, { decision: "accept" }),
      /이미 처리/,
    );
    assert.equal(run.terminal, false);
    clients[0].complete();
    clients[0].complete();
    await until(() => clients.length === 3 && clients[2].started);
    assert.equal(store.get("tasks", taskId).status, "review");
    assert.equal(
      store.all("reports", project.id).filter((r) => r.taskId === taskId)
        .length,
      1,
    );
    runner.accept(taskId, {
      revision: store.get("tasks", taskId).revision,
      confirm: true,
    });
    assert.equal(store.get("tasks", taskId).status, "completed");
    const otherId = [...runner.active.keys()][0];
    await runner.cancel(otherId);
    await until(() => !runner.active.has(otherId));
    assert.equal(store.get("tasks", otherId).status, "interrupted");
  } finally {
    await runner.close();
    store.close();
  }
});
