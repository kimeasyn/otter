import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";
import { Runner } from "../src/runner.mjs";
import { git } from "../src/git.mjs";

class ScriptedCodex extends EventEmitter {
  replies = new Map();
  async initialize() {}
  async request(method, params) {
    if (method === "turn/steer") {
      this.steered = params;
      return { turnId: this.turnId };
    }
    if (["thread/start", "thread/resume"].includes(method)) {
      this.threadId = params.threadId || randomUUID();
      this.resume = method === "thread/resume";
      return { thread: { id: this.threadId } };
    }
    if (method === "turn/start") {
      this.turnId = randomUUID();
      this.input = params.input;
      this.started = true;
      return { turn: { id: this.turnId } };
    }
    if (method === "turn/interrupt")
      this.emit("notification", {
        method: "turn/completed",
        params: { turn: { status: "interrupted" } },
      });
  }
  reply(id, result) {
    this.replies.set(id, result);
  }
  refuse() {
    throw new Error("Unexpected refusal");
  }
  close() {}
  tool(name, args) {
    const id = randomUUID();
    this.emit("request", {
      id,
      method: "item/tool/call",
      params: {
        threadId: this.threadId,
        turnId: this.turnId,
        tool: name,
        arguments: args,
      },
    });
    const result = this.replies.get(id);
    assert.ok(result);
    return {
      success: result.success,
      value: JSON.parse(
        result.success
          ? result.contentItems[0].text
          : JSON.stringify(result.contentItems[0].text),
      ),
    };
  }
  complete(text = "합성 실행의 보고") {
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
    if (Date.now() > end) throw new Error("조건 시간 초과");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "otter-cowork-"));
  const store = new Store();
  const company = new Company(store);
  const clients = [];
  const runner = new Runner(store, directory, () => {
    const client = new ScriptedCodex();
    clients.push(client);
    return client;
  });
  store.settings({ concurrency: 1 });
  const org = company.createCompany({
    name: "한 사람이 운영하는 회사",
    mode: "group",
  });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  const team = ["PM", "개발자", "리뷰어"].map((role) =>
    company.assign(
      project.id,
      company.createEmployee({ name: role, role, instructions: "합성 검사" })
        .id,
    ),
  );
  const root = company.requestTask({
    projectId: project.id,
    assignmentId: team[0].id,
    prompt: "계획부터 리뷰까지 진행",
    mode: "delegate",
  });
  runner.pump();
  await until(() => clients[0]?.started);
  return {
    directory,
    store,
    company,
    runner,
    clients,
    project,
    team,
    root,
    close: async () => {
      await runner.close();
      store.close();
    },
  };
}
test("작업 중인 동료에게 메시지를 전달하되 새 실행을 중복 생성하지 않는다", async () => {
  const w = await workspace();
  try {
    w.store.settings({ concurrency: 2 });
    w.clients[0].tool("otter_delegate", {
      key: "build",
      assignmentId: w.team[1].id,
      prompt: "작업 진행",
      dependsOn: [],
    });
    await until(() => w.clients[1]?.started);
    const message = w.clients[0].tool("otter_message", {
      recipientAssignmentId: w.team[1].id,
      text: "반드시 실제 파일을 확인하세요.",
    });
    assert.equal(message.success, true);
    await until(
      () => w.store.get("messages", message.value.id).delivery === "delivered",
    );
    assert.match(w.clients[1].steered.input[0].text, /실제 파일/);
    assert.equal(w.store.all("tasks", w.project.id).length, 2);
    await w.runner.cancel(w.root.id);
    await until(() => !w.runner.active.size);
    assert.ok(
      w.store
        .all("tasks", w.project.id)
        .every((t) => t.status === "interrupted"),
    );
  } finally {
    await w.close();
  }
});

test("PM은 슬롯을 양보하고 실제 Git 파일을 개발자 → 리뷰어 → PM으로 인계한다", async () => {
  const w = await workspace();
  try {
    const pm = w.clients[0];
    const assignment = {
      key: "build",
      assignmentId: w.team[1].id,
      prompt: "api.js 작성",
      dependsOn: [],
    };
    const a = pm.tool("otter_delegate", assignment);
    assert.equal(a.success, true);
    const again = pm.tool("otter_delegate", assignment);
    assert.equal(again.value.taskId, a.value.taskId);
    const invalid = pm.tool("otter_delegate", {
      ...assignment,
      key: "invalid",
      dependsOn: [w.root.id],
    });
    assert.equal(invalid.success, false);
    const b = pm.tool("otter_delegate", {
      key: "review",
      assignmentId: w.team[2].id,
      prompt: "api.js 실제 결과 리뷰",
      dependsOn: [a.value.taskId],
    });
    assert.equal(b.success, true);
    assert.equal(w.store.all("tasks", w.project.id).length, 3);
    pm.complete("개발 및 리뷰를 배정했습니다.");
    await until(() => w.clients[1]?.started);
    assert.equal(w.store.get("tasks", w.root.id).status, "coordinating");
    assert.equal(w.store.get("tasks", b.value.taskId).status, "queued");
    const aPath = w.store.get("tasks", a.value.taskId).worktree.path;
    await writeFile(join(aPath, "api.js"), "export const answer = 42;\n");
    w.clients[1].complete("api.js의 실제 구현을 인계합니다.");
    await until(() => w.clients[2]?.started);
    const bPath = w.store.get("tasks", b.value.taskId).worktree.path;
    assert.equal(
      await readFile(join(bPath, "api.js"), "utf8"),
      "export const answer = 42;\n",
    );
    await writeFile(
      join(bPath, "review.md"),
      "api.js 확인 완료. 합성 검사임.\n",
    );
    w.clients[2].complete("선행 업무 파일을 확인했습니다.");
    await until(() => w.clients[3]?.started);
    assert.equal(w.clients[3].resume, true);
    assert.equal(w.clients[3].threadId, pm.threadId);
    const pmPath = w.store.get("tasks", w.root.id).worktree.path;
    assert.equal(
      await readFile(join(pmPath, "api.js"), "utf8"),
      "export const answer = 42;\n",
    );
    assert.match(
      await readFile(join(pmPath, "review.md"), "utf8"),
      /확인 완료/,
    );
    assert.match(w.clients[3].input[0].text, /선행 업무 파일을 확인했습니다/);
    w.clients[3].complete("최종 결과와 실제 인계가 확인되었습니다.");
    await until(() => w.store.get("tasks", w.root.id).status === "review");
    assert.equal(
      w.store.all("messages", w.project.id).filter((m) => m.kind === "handoff")
        .length,
      2,
    );
    assert.equal(w.runner.active.size, 0);
    w.company.continueTask(w.root.id, {
      prompt: "같은 업무에서 설명을 보완해 주세요.",
    });
    w.runner.pump();
    await until(() => w.clients[4]?.started);
    assert.equal(w.clients[4].threadId, pm.threadId);
    assert.equal(w.store.get("tasks", w.root.id).worktree.path, pmPath);
    w.clients[4].complete();
    await until(() => w.store.get("tasks", w.root.id).status === "review");
  } finally {
    await w.close();
  }
});
test("충돌은 격리된 브랜치에 보존하고 사용자의 해결 뒤 같은 PM 대화를 재개한다", async () => {
  const w = await workspace();
  try {
    const a = w.clients[0].tool("otter_delegate", {
      key: "a",
      assignmentId: w.team[1].id,
      prompt: "공통 파일 A 변경",
      dependsOn: [],
    }).value;
    const b = w.clients[0].tool("otter_delegate", {
      key: "b",
      assignmentId: w.team[2].id,
      prompt: "공통 파일 B 변경",
      dependsOn: [],
    }).value;
    w.clients[0].complete();
    await until(() => w.clients[1]?.started);
    await writeFile(
      join(w.store.get("tasks", a.taskId).worktree.path, "shared.txt"),
      "A\n",
    );
    w.clients[1].complete();
    await until(() => w.clients[2]?.started);
    await writeFile(
      join(w.store.get("tasks", b.taskId).worktree.path, "shared.txt"),
      "B\n",
    );
    w.clients[2].complete();
    await until(() => w.store.get("tasks", w.root.id).status === "blocked");
    const parent = w.store.get("tasks", w.root.id);
    assert.match(
      await readFile(join(parent.worktree.path, "shared.txt"), "utf8"),
      /<<<<<<< HEAD/,
    );
    await assert.rejects(readFile(join(w.project.root, "shared.txt")), {
      code: "ENOENT",
    });
    // 미해결 충돌을 단순 완료 보고로 덮어쓰지 않는다.
    w.company.continueTask(parent.id, { prompt: "충돌을 확인해 주세요." });
    w.runner.pump();
    await until(() => w.clients[3]?.started);
    w.clients[3].complete();
    await until(() => w.store.get("tasks", parent.id).status === "blocked");
    assert.ok(await git(parent.worktree.path, ["ls-files", "--unmerged"]));
    await writeFile(
      join(parent.worktree.path, "shared.txt"),
      "A와 B를 함께 보존\n",
    );
    await git(parent.worktree.path, ["add", "shared.txt"]);
    w.company.continueTask(parent.id, {
      prompt: "충돌을 해결했으니 검토를 계속해 주세요.",
    });
    w.runner.pump();
    await until(() => w.clients[4]?.started);
    w.clients[4].complete();
    await until(() => w.store.get("tasks", parent.id).status === "review");
    assert.equal(w.store.get("tasks", parent.id).integrationConflict, null);
    assert.equal(
      await readFile(join(parent.worktree.path, "shared.txt"), "utf8"),
      "A와 B를 함께 보존\n",
    );
  } finally {
    await w.close();
  }
});
test("새 직원 제안 승인 및 문서 차이 검토는 실행부 밖에서 강제된다", async () => {
  const w = await workspace();
  try {
    const proposed = w.clients[0].tool("otter_propose_employee", {
      name: "QA 김검증",
      role: "테스트",
      model: "",
      instructions: "실제 결과만 보고",
      skills: "",
      reason: "프로젝트에 테스트 담당이 필요합니다.",
    });
    assert.equal(proposed.success, true);
    assert.equal(w.store.all("employees").length, 3);
    w.clients[0].complete("채용 승인을 기다립니다.");
    await until(
      () => w.store.get("tasks", w.root.id).status === "coordinating",
    );
    assert.equal(w.runner.active.size, 0);
    w.runner.approve(proposed.value.proposalId, { decision: "accept" });
    assert.equal(w.store.all("employees").length, 4);
    assert.throws(
      () => w.runner.approve(proposed.value.proposalId, { decision: "accept" }),
      /이미 처리/,
    );
    await until(() => w.clients[1]?.started);
    assert.match(w.clients[1].input[0].text, /QA 김검증/);
    const doc = w.store.all("documents", w.project.id)[0];
    const proposal = w.clients[1].tool("otter_propose_document", {
      documentId: doc.id,
      revision: doc.revision,
      content: "제안한 내용",
      reason: "목표 구체화",
    });
    assert.equal(proposal.success, true);
    assert.equal(w.store.get("documents", doc.id).content, "");
    w.company.editDocument(doc.id, { ...doc, content: "사용자의 동시 수정" });
    assert.throws(
      () => w.runner.approve(proposal.value.proposalId, { decision: "accept" }),
      /다른 변경/,
    );
    assert.equal(
      w.store.get("documents", doc.id).content,
      "사용자의 동시 수정",
    );
    assert.equal(
      w.store.get("approvals", proposal.value.proposalId).status,
      "pending",
    );
    w.runner.approve(proposal.value.proposalId, { decision: "decline" });
    const other = await w.company.addProject({
      companyId: w.project.companyId,
      create: true,
      parent: w.directory,
      folder: "private",
    });
    const privateDoc = w.store.all("documents", other.id)[0];
    assert.equal(
      w.clients[1].tool("otter_propose_document", {
        documentId: privateDoc.id,
        revision: 1,
        content: "누출 시도",
        reason: "거부되어야 함",
      }).success,
      false,
    );
    const outsider = w.company.assign(other.id, w.store.all("employees")[0].id);
    assert.equal(
      w.clients[1].tool("otter_message", {
        recipientAssignmentId: outsider.id,
        text: "다른 프로젝트로 전송 금지",
      }).success,
      false,
    );
  } finally {
    await w.close();
  }
});
