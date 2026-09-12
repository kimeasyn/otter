import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";
import { Cowork } from "../src/cowork.mjs";
import { Knowledge } from "../src/knowledge.mjs";
import { startServer } from "../src/server.mjs";
import { Remote } from "../src/remote.mjs";

test("공유 지식은 별도 승인·같은 회사·선택 적용을 요구하며 본문 사본과 기존 실행을 덮어쓰지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-knowledge-"));
  const store = new Store();
  const otherStore = new Store();
  const company = new Company(store),
    cowork = new Cowork(company),
    knowledge = new Knowledge(store);
  try {
    const org = company.createCompany({
      name: "함께 쓰는 회사",
      mode: "group",
    });
    const other = company.createCompany({ name: "다른 회사", mode: "group" });
    const source = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "source",
      idea: "공유하면 안 되는 프로젝트 자료",
    });
    const target = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "target",
    });
    const forbidden = await company.addProject({
      companyId: other.id,
      create: true,
      parent: directory,
      folder: "forbidden",
    });
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "지침",
    });
    const assignment = company.assign(source.id, employee.id);
    const targetAssignment = company.assign(target.id, employee.id);
    const task = company.requestTask({
      projectId: source.id,
      assignmentId: assignment.id,
      prompt: "비공개 대화는 공유하지 말고 원칙만 제안",
    });
    const oldTask = company.requestTask({
      projectId: target.id,
      assignmentId: targetAssignment.id,
      prompt: "공유 지식 적용 전 업무",
    });
    const input = {
      title: "중복 실행 방지",
      content: "변경 요청에는 안정적인 요청 ID를 사용한다.",
      reason: "연결 단절 후 같은 작업을 두 번 실행하지 않기 위해",
      sourcePath: source.root,
      privateConversation: task.prompt,
    };
    const proposal = cowork.handle(task, "otter_propose_knowledge", input);
    assert.equal(store.all("knowledge").length, 0);
    assert.throws(
      () => cowork.resolve(proposal.proposalId, { decision: "accept" }),
      /공유 범위/,
    );
    assert.equal(store.get("approvals", proposal.proposalId).status, "pending");
    cowork.resolve(proposal.proposalId, { decision: "decline" });
    assert.equal(store.all("knowledge").length, 0);
    const approved = cowork.handle(task, "otter_propose_knowledge", input);
    const result = cowork.resolve(approved.proposalId, {
      decision: "accept",
      shareConfirmed: true,
    });
    const item = store.get("knowledge", result.knowledgeId);
    assert.equal(item.sourceApprovalId, approved.proposalId);
    assert.equal(item.content, input.content);
    assert.equal(JSON.stringify(item).includes(source.root), false);
    assert.equal(JSON.stringify(item).includes(task.prompt), false);
    assert.equal(
      JSON.stringify(item).includes("공유하면 안 되는 프로젝트 자료"),
      false,
    );
    assert.equal(
      store.all("documents", target.id).length,
      3,
      "공유 승인만으로 다른 프로젝트에 적용하지 않는다",
    );
    const applying = {
      knowledgeId: item.id,
      revision: item.revision,
      confirm: true,
    };
    assert.throws(() => knowledge.apply(forbidden.id, applying), /같은 회사/);
    assert.throws(
      () => knowledge.apply(target.id, { ...applying, confirm: false }),
      /현재 본문/,
    );
    const copy = knowledge.apply(target.id, applying);
    assert.equal(copy.content, input.content);
    assert.equal(knowledge.apply(target.id, applying).id, copy.id);
    const next = company.requestTask({
      projectId: target.id,
      assignmentId: targetAssignment.id,
      prompt: "적용 이후 업무",
    });
    assert.ok(!oldTask.documents.some((d) => d.kind === "knowledge"));
    assert.equal(
      next.documents.find((d) => d.kind === "knowledge").content,
      input.content,
    );
    company.editDocument(copy.id, {
      ...copy,
      content: "대상 프로젝트에서만 조정한 내용",
    });
    assert.equal(
      knowledge.apply(target.id, applying).content,
      "대상 프로젝트에서만 조정한 내용",
    );
    assert.equal(store.get("knowledge", item.id).content, input.content);
    assert.equal(
      next.documents.find((d) => d.kind === "knowledge").content,
      input.content,
      "이미 요청한 실행 스냅샷 유지",
    );
    new Company(otherStore).importSettings({ company: org });
    const imported = new Knowledge(otherStore).importApproved({
      ...item,
      sourcePath: source.root,
      privateConversation: task.prompt,
    });
    assert.equal(imported.sourcePath, undefined);
    assert.equal(imported.privateConversation, undefined);
    assert.throws(
      () =>
        new Knowledge(otherStore).importApproved({
          ...item,
          revision: 2,
          content: "승인 없이 수정",
        }),
      /덮어쓸 수 없/,
    );
    const withdrawn = knowledge.withdraw(item.id, {
      revision: item.revision,
      confirm: true,
    });
    assert.throws(() => knowledge.apply(target.id, applying), /공유 상태/);
    assert.equal(
      store.get("documents", copy.id).content,
      "대상 프로젝트에서만 조정한 내용",
    );
    new Knowledge(otherStore).importApproved(withdrawn);
    new Knowledge(otherStore).importApproved(item);
    assert.equal(
      otherStore.get("knowledge", item.id).status,
      "withdrawn",
      "오래된 원격 상태가 공유 중지를 되돌리지 않는다",
    );
    assert.throws(
      () =>
        cowork.handle(task, "otter_propose_knowledge", {
          ...input,
          content: "sk-" + "x".repeat(30),
        }),
      /자격 증명/,
    );
    assert.equal(store.all("knowledge").length, 1);
  } finally {
    store.close();
    otherStore.close();
  }
});

test("원격 승인 본문만 회사 라이브러리에 전달하고 로컬↔원격 선택 적용·회사 경계·중복 방지를 유지한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-knowledge-remote-"));
  const gateway = await startServer({
    directory: join(root, "local"),
    port: 0,
    makeRemote: (environment) =>
      new Remote(environment, {
        launch: (_command, _args, options) =>
          spawn(
            process.execPath,
            [new URL("../src/remote-bootstrap.mjs", import.meta.url).pathname],
            options,
          ),
      }),
  });
  let environment;
  const request = async (path, input, env = "local", key = randomUUID()) => {
    const response = await fetch(gateway.origin + "/api/" + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + gateway.token,
        "X-Otter-Environment": env,
        "Idempotency-Key": key,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    environment = (
      await request("environments", {
        name: "공유 검사 원격",
        kind: "ssh",
        host: "test.invalid",
        directory: join(root, "remote"),
        slots: 1,
      })
    ).data;
    assert.equal(
      (await request(`environments/${environment.id}/connect`, {})).status,
      200,
    );
    const org = (
      await request("companies", { name: "같은 회사", mode: "group" })
    ).data;
    const other = (
      await request("companies", { name: "공유하지 않을 회사", mode: "group" })
    ).data;
    const project = async (folder, companyId, env = "local") => {
      const response = await request(
        "projects",
        { companyId, create: true, parent: root, folder },
        env,
      );
      assert.equal(response.status, 201);
      return response.data;
    };
    const remoteSource = await project("remote-source", org.id, environment.id);
    const localTarget = await project("local-target", org.id);
    const remoteTarget = await project("remote-target", org.id, environment.id);
    const forbidden = await project("forbidden", other.id, environment.id);
    const before = (await request("state?projectId=" + remoteSource.id)).data;
    const doc = before.documents[0];
    await request(
      `documents/${doc.id}/edit`,
      { ...doc, content: "원격 프로젝트의 비공개 정보" },
      environment.id,
    );
    const excerpt = {
      title: "연결 복구 원칙",
      content: "확인되지 않은 요청은 자동으로 재실행하지 않는다.",
      reason: "중복 변경 방지",
      confirm: true,
    };
    const key = randomUUID();
    const refresh = gateway.environments.refresh.bind(gateway.environments);
    gateway.environments.refresh = async () => {
      throw new Error("공유 성공 후 상태 조회 연결 유실");
    };
    const published = await request(
      `projects/${remoteSource.id}/knowledge-publish`,
      excerpt,
      environment.id,
      key,
    );
    gateway.environments.refresh = refresh;
    assert.equal(published.status, 200, JSON.stringify(published.data));
    const item = published.data;
    assert.equal(
      (
        await request(
          `projects/${remoteSource.id}/knowledge-publish`,
          excerpt,
          environment.id,
          key,
        )
      ).data.id,
      item.id,
    );
    assert.equal(gateway.store.all("knowledge").length, 1);
    assert.equal(
      gateway.store
        .all("documents")
        .some((d) => d.content === "원격 프로젝트의 비공개 정보"),
      false,
    );
    assert.equal(
      JSON.stringify(gateway.store.all("knowledge")).includes("비공개 정보"),
      false,
    );
    const apply = {
      knowledgeId: item.id,
      revision: item.revision,
      confirm: true,
    };
    assert.equal(
      (await request(`projects/${localTarget.id}/knowledge-apply`, apply))
        .status,
      200,
    );
    const applied = await request(
      `projects/${remoteTarget.id}/knowledge-apply`,
      apply,
      environment.id,
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    // 새 요청 ID로 반복하기 전에는 이미 받은 응답을 확인 처리한다.
    assert.equal(
      (
        await request(
          `projects/${remoteTarget.id}/knowledge-apply`,
          apply,
          environment.id,
        )
      ).status,
      409,
    );
    const receipt = (await request("request-journal")).data.find(
      (item) =>
        item.path === `/api/projects/${remoteTarget.id}/knowledge-apply`,
    );
    assert.equal(
      (await request(`request-journal/${receipt.id}/ack`, {})).status,
      200,
    );
    assert.equal(
      (
        await request(
          `projects/${remoteTarget.id}/knowledge-apply`,
          apply,
          environment.id,
        )
      ).data.id,
      applied.data.id,
    );
    assert.equal(
      (
        await request(
          `projects/${forbidden.id}/knowledge-apply`,
          apply,
          environment.id,
        )
      ).status,
      403,
    );
    const local = await request(
      `projects/${localTarget.id}/knowledge-publish`,
      { ...excerpt, title: "로컬에서 정리한 원칙" },
    );
    assert.equal(
      (
        await request(
          `projects/${remoteTarget.id}/knowledge-apply`,
          { knowledgeId: local.data.id, revision: 1, confirm: true },
          environment.id,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`knowledge/${item.id}/withdraw`, {
          revision: 1,
          confirm: true,
        })
      ).status,
      200,
    );
    await request("state?projectId=" + remoteSource.id);
    assert.equal(gateway.store.get("knowledge", item.id).status, "withdrawn");
    assert.equal(
      (
        await request(
          `projects/${remoteTarget.id}/knowledge-apply`,
          apply,
          environment.id,
        )
      ).status,
      409,
    );
    const after = (await request("state?projectId=" + remoteTarget.id)).data;
    assert.equal(
      after.documents.filter((d) => d.knowledgeSource?.id === item.id).length,
      1,
    );
    assert.equal(
      after.documents.find((d) => d.knowledgeSource?.id === item.id).content,
      excerpt.content,
    );
    assert.ok(!after.messages.length);
  } finally {
    try {
      if (environment) await gateway.environments.stop(environment.id);
    } finally {
      await gateway.close();
    }
  }
});
