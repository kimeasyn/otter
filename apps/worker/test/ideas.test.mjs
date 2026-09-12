import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";
import { Runner } from "../src/runner.mjs";
import { Ideas } from "../src/ideas.mjs";
import { git } from "../src/git.mjs";

class InterviewCodex extends EventEmitter {
  replies = [];
  async initialize() {}
  async request(method, params) {
    if (method === "thread/start" || method === "thread/resume") {
      this.thread = params;
      return { thread: { id: "interview-thread" } };
    }
    if (method === "turn/start") {
      this.turn = params;
      return { turn: { id: "interview-turn" } };
    }
  }
  reply(id, result) {
    this.replies.push({ id, result });
  }
  refuse(id) {
    this.replies.push({ id, refused: true });
  }
  close() {}
  tool(name, args) {
    this.emit("request", {
      id: this.replies.length + 1,
      method: "item/tool/call",
      params: {
        threadId: "interview-thread",
        turnId: "interview-turn",
        tool: name,
        arguments: args,
      },
    });
    return this.replies.at(-1).result;
  }
  complete(text) {
    this.emit("notification", {
      method: "item/completed",
      params: { item: { type: "agentMessage", text } },
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
    if (Date.now() > end) throw Error("검사 조건 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("아이디어 인터뷰 → 문서/채용 승인 → 저장 위치 확정 → 격리된 개발, 기록과 경계 보존", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-idea-test-"));
  const store = new Store();
  const company = new Company(store);
  const clients = [];
  const runner = new Runner(store, directory, () => {
    const client = new InterviewCodex();
    clients.push(client);
    return client;
  });
  const ideas = new Ideas(company, runner, directory);
  try {
    const org = company.createCompany({
      name: "아이디어 회사",
      mode: "single",
    });
    const input = {
      companyId: org.id,
      name: "작은 서비스",
      idea: "할 일 목록을 만들고 싶다",
      pm: {
        name: "정리 PM",
        model: "",
        instructions: "질문한 뒤 명확한 문서를 제안한다",
      },
    };
    await assert.rejects(ideas.create(input), /PM/);
    assert.equal(store.all("employees").length, 0);
    const project = await ideas.create({ ...input, confirmPM: true });
    assert.equal(project.stage, "idea");
    assert.deepEqual(
      await readdir(project.root),
      [],
      "인터뷰 전에 개발 저장소를 만들지 않는다",
    );
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: project.pmAssignmentId,
      prompt: "요구사항을 정리하자",
      mode: "delegate",
    });
    assert.equal(
      task.mode,
      "interview",
      "API로 개발 위임을 요청해도 인터뷰 경계를 유지한다",
    );
    runner.pump();
    await until(() => clients[0]?.turn);
    const client = clients[0];
    assert.equal(client.thread.sandbox, undefined);
    assert.equal(client.thread.permissions, `otter-interview-${task.id}`);
    assert.equal(client.thread.approvalPolicy, "never");
    assert.equal(client.turn.permissions, client.thread.permissions);
    assert.deepEqual(
      client.thread.config[`permissions.${client.thread.permissions}`],
      {
        filesystem: {
          ":root": "deny",
          ":minimal": "read",
          [project.root]: "read",
        },
        network: { enabled: false },
      },
    );
    assert.ok(
      !client.thread.dynamicTools.some((t) => t.name === "otter_delegate"),
    );
    assert.equal(client.tool("otter_delegate", {}).success, false);
    client.emit("request", {
      id: 77,
      method: "item/fileChange/requestApproval",
      params: {},
    });
    assert.deepEqual(client.replies.at(-1).result, { decision: "decline" });
    assert.equal(store.all("approvals").length, 0);
    client.emit("request", {
      id: 78,
      method: "item/permissions/requestApproval",
      params: { permissions: { network: { enabled: true } } },
    });
    assert.deepEqual(client.replies.at(-1).result, {
      permissions: {},
      scope: "turn",
    });
    assert.equal(store.all("approvals").length, 0);
    for (const doc of store.all("documents", project.id)) {
      assert.equal(
        client.tool("otter_propose_document", {
          documentId: doc.id,
          revision: doc.revision,
          content: `${doc.title}: 승인할 합성 요구사항`,
          reason: "인터뷰 정리",
        }).success,
        true,
      );
    }
    assert.equal(
      client.tool("otter_propose_employee", {
        name: "개발자",
        role: "개발·테스트",
        model: "",
        instructions: "승인한 요구사항만 구현한다",
        skills: "",
        reason: "실제 개발과 검증을 담당할 직원이 필요",
      }).success,
      true,
    );
    assert.equal(store.all("employees").length, 1, "승인 전 채용하지 않는다");
    await assert.rejects(
      ideas.activate(project.id, { revision: project.revision, confirm: true }),
      /인터뷰/,
    );
    client.complete(
      "문서와 필요한 직원을 제안했습니다. 검토해 주세요. (합성 제공자)",
    );
    await until(() => !runner.active.size);
    assert.equal(store.get("tasks", task.id).status, "coordinating");
    assert.equal(store.get("tasks", task.id).resultCommit, undefined);
    for (const approval of store.all("approvals"))
      runner.approve(approval.id, { decision: "accept" });
    await until(() => clients[1]?.turn);
    assert.equal(
      clients[1].thread.threadId,
      "interview-thread",
      "같은 인터뷰 대화를 재개한다",
    );
    clients[1].complete(
      "문서와 팀이 준비되었습니다. 저장 위치를 선택해 주세요. (합성 제공자)",
    );
    await until(() => !runner.active.size);
    const assignment = store
      .all("assignments", project.id)
      .find((a) => a.id !== project.pmAssignmentId);
    assert.throws(
      () =>
        company.requestTask({
          projectId: project.id,
          assignmentId: assignment.id,
          prompt: "구현",
        }),
      /PM/,
    );
    const activate = {
      revision: project.revision,
      confirm: true,
      parent: directory,
      folder: "service",
      documents: Object.fromEntries(
        store.all("documents", project.id).map((d) => [d.id, d.revision]),
      ),
      team: Object.fromEntries(
        store.all("assignments", project.id).map((a) => [a.id, a.revision]),
      ),
    };
    await assert.rejects(
      ideas.activate(project.id, { ...activate, documents: {} }),
      /문서가 바뀌/,
    );
    await assert.rejects(
      ideas.activate(project.id, { ...activate, team: {} }),
      /팀 구성이 바뀌/,
    );
    assert.ok(!(await readdir(directory)).includes("service"));
    await mkdir(join(directory, "existing"));
    await writeFile(
      join(directory, "existing", "keep.txt"),
      "기존 사용자 작업",
    );
    await assert.rejects(
      ideas.activate(project.id, { ...activate, folder: "existing" }),
      /이미 있습니다/,
    );
    assert.equal(
      await readFile(join(directory, "existing", "keep.txt"), "utf8"),
      "기존 사용자 작업",
    );
    assert.equal(store.get("projects", project.id).stage, "idea");
    const pending = ideas.activate(project.id, activate);
    assert.throws(
      () =>
        company.requestTask({
          projectId: project.id,
          assignmentId: project.pmAssignmentId,
          prompt: "다시 질문",
        }),
      /프로젝트를 변경하는 중/,
    );
    await assert.rejects(
      ideas.activate(project.id, activate),
      /프로젝트를 변경하는 중/,
    );
    const active = await pending;
    assert.equal(active.stage, "development");
    assert.equal(active.id, project.id);
    assert.equal(active.interviewRoot, project.root);
    assert.equal(
      store.db.prepare("SELECT root FROM projects WHERE id=?").get(project.id)
        .root,
      active.root,
    );
    assert.equal(await git(active.root, ["branch", "--show-current"]), "main");
    assert.deepEqual(await readdir(project.root), []);
    assert.ok(
      store
        .all("messages", project.id)
        .some((m) => m.text.includes("저장 위치를 선택")),
    );
    assert.throws(
      () => company.continueTask(task.id, { prompt: "개발 시작" }),
      /새 업무/,
    );
    const development = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "hello.txt 작성",
    });
    assert.equal(development.mode, "direct");
    assert.ok(
      development.documents.every((d) => d.content.includes("합성 요구사항")),
    );
    runner.pump();
    await until(() => clients[2]?.turn);
    assert.equal(clients[2].thread.sandbox, "workspace-write");
    const worktree = store.get("tasks", development.id).worktree;
    await writeFile(join(worktree.path, "hello.txt"), "hello\n");
    clients[2].complete(
      "합성 제공자가 hello.txt를 작성했습니다. 실제 모델 검사가 아닙니다.",
    );
    await until(() => !runner.active.size);
    const result = store.get("tasks", development.id);
    assert.equal(result.status, "review");
    assert.equal(
      await git(active.root, ["show", `${result.resultCommit}:hello.txt`]),
      "hello",
    );
    await assert.rejects(readFile(join(active.root, "hello.txt")), {
      code: "ENOENT",
    });
    await assert.rejects(ideas.activate(project.id, activate), /최신 아이디어/);
  } finally {
    await runner.close();
    store.close();
  }
});
