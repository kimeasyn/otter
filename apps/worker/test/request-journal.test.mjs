import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { startServer } from "../src/server.mjs";
import { Remote } from "../src/remote.mjs";
import { Company } from "../src/company.mjs";
import { Store, DomainError } from "../src/store.mjs";
import { RequestJournal } from "../src/request-journal.mjs";

test("원격 요청은 앱 재시작 후 조회로 복구하며 미접수만 동일 ID로 전달하고 원본/대상을 유지한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-request-recovery-"));
  const options = {
    directory: join(root, "controller"),
    port: 0,
    makeRemote: (environment) =>
      new Remote(environment, {
        launch: (_command, _args, settings) =>
          spawn(
            process.execPath,
            [new URL("../src/remote-bootstrap.mjs", import.meta.url).pathname],
            settings,
          ),
      }),
  };
  let app = await startServer(options);
  const request = async (
    path,
    data,
    environment = "local",
    key = randomUUID(),
  ) => {
    const response = await fetch(app.origin + "/api/" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + app.token,
        "X-Otter-Environment": environment,
        "Idempotency-Key": key,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  let environment;
  try {
    const company = new Company(app.store).createCompany({
      name: "복구 회사",
      mode: "single",
    });
    environment = app.environments.add({
      name: "원격 복구",
      kind: "ssh",
      host: "test.invalid",
      directory: join(root, "remote"),
      slots: 1,
    });
    await app.environments.connect(environment.id);
    const original = app.environments.forward.bind(app.environments);
    app.environments.forward = async (...args) => {
      await original(...args);
      throw new DomainError("합성 응답 유실", 504);
    };
    const id = randomUUID();
    const input = {
      companyId: company.id,
      create: true,
      parent: root,
      folder: "first",
    };
    assert.equal(
      (await request("projects", input, environment.id, id)).status,
      504,
    );
    assert.equal(
      (await request("projects", input, environment.id)).data.pending,
      true,
      "새 요청 ID로 중복 생성하지 않는다",
    );
    const listing = (await request("request-journal")).data;
    assert.equal(listing.length, 1);
    assert.equal(listing[0].id, id);
    assert.equal(listing[0].status, "pending");
    assert.equal((await request(`request-journal/${id}/ack`, {})).status, 409);
    const oldOrigin = app.origin;
    await app.close();
    app = await startServer(options);
    assert.equal((await request("request-journal")).data[0].id, id);
    await app.environments.connect(environment.id);
    const client = app.environments.client(environment.id);
    const before = (await client.request("GET", "/api/state")).data.projects
      .length;
    const recovered = await request(`request-journal/${id}/check`, {});
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.status, "confirmed");
    assert.equal(recovered.data.result.status, 201);
    assert.equal(
      (await request(`requests/${id}`, undefined, environment.id)).data.result
        .data.id,
      recovered.data.result.data.id,
    );
    assert.deepEqual(
      (await request(`requests/${id}`)).data,
      { state: "missing" },
      "원격 처리 기록을 로컬 기록으로 오인하지 않는다",
    );
    assert.equal(
      (await request("projects", input, environment.id)).data.pending,
      true,
      "앱에 전달되지 않은 완료 응답도 확인 전에는 새 ID로 중복 실행하지 않는다",
    );
    assert.equal(
      (await client.request("GET", "/api/state")).data.projects.length,
      before,
    );
    assert.equal(
      app.store.metadata("projectClaim:" + company.id),
      null,
      "조회 복구로 단일 회사의 미확인 변경 잠금도 해제한다",
    );
    await request(`request-journal/${id}/ack`, {});
    assert.deepEqual((await request("request-journal")).data, []);
    const saved = JSON.parse(
      app.store.db
        .prepare("SELECT data FROM request_journal WHERE id=?")
        .get(id).data,
    );
    assert.equal(saved.input, null);
    assert.equal(saved.result, null);
    assert.equal(
      (await request("projects", input, environment.id, id)).data.id,
      recovered.data.result.data.id,
    );
    assert.equal(
      (
        await request(
          "projects",
          { ...input, folder: "changed" },
          environment.id,
          id,
        )
      ).status,
      409,
    );
    const group = new Company(app.store).createCompany({
      name: "두번째 회사",
      mode: "group",
    });
    const nextId = randomUUID();
    const next = {
      companyId: group.id,
      create: true,
      parent: root,
      folder: "second",
    };
    const forwarding = app.environments.forward.bind(app.environments);
    app.environments.forward = async () => {
      throw new DomainError("전달 전 연결 실패", 504);
    };
    await request("projects", next, environment.id, nextId);
    app.environments.forward = forwarding;
    assert.equal(
      (await request(`request-journal/${nextId}/check`, {})).data.observation,
      "missing",
    );
    assert.equal(
      (await request(`request-journal/${nextId}/retry`, {})).status,
      400,
    );
    const retried = await request(`request-journal/${nextId}/retry`, {
      confirm: true,
    });
    assert.equal(retried.data.status, "confirmed");
    assert.equal(
      (await client.request("GET", "/api/state")).data.projects.length,
      before + 1,
    );
    await request(`request-journal/${nextId}/retry`, { confirm: true });
    assert.equal(
      (await client.request("GET", "/api/state")).data.projects.length,
      before + 1,
    );
    const connection = JSON.parse(
      await readFile(join(root, "remote", "connection.json"), "utf8"),
    );
    assert.equal(
      (await fetch(`${connection.origin}/api/requests/${id}`)).status,
      401,
    );
    assert.ok(
      oldOrigin && app.origin,
      "요청 기록은 브라우저 origin이 아닌 실행부 DB에 남는다",
    );
  } finally {
    if (environment)
      await app.environments.stop(environment.id).catch(() => {});
    await app.close();
  }
});

test("원격 접수 중·다른 실행부는 재실행하지 않고 늦은 응답이 확인한 요청 본문을 되살리지 않는다", async () => {
  const store = new Store();
  const workerId = randomUUID();
  const environment = store.insert("environments", { name: "원격", workerId });
  const client = {
    health: { workerId },
    request: async () => ({ status: 200, data: { state: "pending" } }),
  };
  let delivered = 0;
  const manager = {
    client: () => client,
    projectOperation: async (_p, _i, _e, _k, action) => action(),
    forward: async () => {
      delivered++;
      throw new DomainError("응답 유실", 504);
    },
    refresh: async () => {},
  };
  const journal = new RequestJournal(store, manager);
  try {
    const id = randomUUID();
    await assert.rejects(
      journal.submit(environment.id, "/api/tasks", { prompt: "원래 요청" }, id),
    );
    await journal.check(id);
    await assert.rejects(journal.retry(id, { confirm: true }), /이미 접수/);
    assert.equal(delivered, 1);
    client.health.workerId = randomUUID();
    await assert.rejects(journal.check(id), /다른 실행부/);
    assert.equal(delivered, 1);
    client.health.workerId = workerId;
    const stale = journal.get(id);
    journal.save({
      ...stale,
      status: "confirmed",
      result: { status: 200, data: { id: "result" } },
    });
    journal.acknowledge(id);
    journal.save({
      ...stale,
      status: "confirmed",
      result: { status: 200, data: { id: "result" } },
    });
    assert.equal(journal.get(id).input, null);
    assert.equal(journal.get(id).result, null);
    assert.deepEqual(journal.list(), []);
    store.receipt("pending-receipt", "hash");
    assert.deepEqual(store.requestResult("pending-receipt"), {
      state: "pending",
    });
    assert.deepEqual(store.requestResult("absent-receipt"), {
      state: "missing",
    });
  } finally {
    store.close();
  }
});

test("로컬 요청은 화면/실행부 재시작 뒤에도 조회·같은 ID 재전달로 중복 없이 복구한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-local-recovery-"));
  const options = {
    directory: join(root, "worker"),
    port: 0,
    makeCodex: () => {
      throw new Error("이 검사는 모델을 실행하지 않는다");
    },
  };
  let app = await startServer(options);
  app.runner.pump = () => {};
  const request = async (path, input, key = randomUUID()) => {
    const response = await fetch(`${app.origin}/api/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${app.token}`, "Idempotency-Key": key },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return {
      status: response.status,
      receipt: response.headers.get("X-Otter-Receipt"),
      data: await response.json(),
    };
  };
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "로컬 회사", mode: "group" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: root,
      folder: "repo",
    });
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "범위 안에서만 작업",
    });
    const assignment = company.assign(project.id, employee.id);
    const input = {
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "같은 업무를 두 번 만들지 마",
    };
    const id = randomUUID();
    const original = await request("tasks", input, id);
    assert.equal(original.status, 201);
    assert.equal(original.receipt, id);
    assert.equal((await request("tasks", input, id)).data.id, original.data.id);
    assert.equal((await request("tasks", input)).data.pending, true);
    assert.equal(
      (await request("tasks", { ...input, prompt: "바뀐 내용" }, id)).status,
      409,
    );
    assert.equal(app.store.all("tasks").length, 1);
    assert.equal((await fetch(`${app.origin}/api/requests/${id}`)).status, 401);
    assert.equal(
      (
        await fetch(`${app.origin}/api/requests/${id}`, {
          headers: {
            Authorization: `Bearer ${app.token}`,
            Origin: "https://other.invalid",
          },
        })
      ).status,
      403,
    );

    // 실제 업무 실행 여부가 아닌 접수 기록 복구만 검사한다. 재시작 시 큐 실행은 발생하지 않는다.
    app.store.update("tasks", original.data.id, { status: "blocked" });
    const pendingId = randomUUID();
    const pendingInput = { name: "접수 후 결과가 없는 회사", mode: "group" };
    new RequestJournal(app.store, app.environments).beginLocal(
      "/api/companies",
      pendingInput,
      pendingId,
    );
    await app.close();
    app = await startServer(options);
    app.runner.pump = () => {};
    assert.equal((await request("tasks", input)).data.pending, true);
    const result = (await request(`requests/${id}`)).data;
    assert.equal(result.state, "completed");
    assert.equal(result.result.data.id, original.data.id);
    const recovered = (await request(`request-journal/${id}/check`, {})).data;
    assert.equal(recovered.environmentId, "local");
    assert.equal(recovered.result.data.id, original.data.id);
    assert.equal(app.store.all("tasks").length, 1);
    assert.equal((await request(`request-journal/${id}/ack`, {})).status, 200);
    assert.equal((await request("tasks", input, id)).data.id, original.data.id);
    const saved = new RequestJournal(app.store, app.environments).get(id);
    assert.equal(saved.status, "acknowledged");
    assert.equal(saved.input, null);
    assert.equal(
      saved.result,
      null,
      "늦은 원 응답이 확인 처리한 사본을 되살리지 않는다",
    );
    const next = await request("tasks", input);
    assert.equal(next.status, 201);
    assert.notEqual(next.data.id, original.data.id);
    assert.equal(app.store.all("tasks").length, 2);
    const incomplete = (await request(`request-journal/${pendingId}/check`, {}))
      .data;
    assert.equal(incomplete.observation, "pending");
    assert.equal(
      (await request(`request-journal/${pendingId}/retry`, { confirm: true }))
        .status,
      409,
    );
    assert.equal(
      (await request(`request-journal/${pendingId}/ack`, {})).status,
      409,
    );
    assert.equal(
      (await request("companies", pendingInput, pendingId)).data.pending,
      true,
    );
    assert.equal((await request("companies", pendingInput)).data.pending, true);
    assert.equal(app.store.all("companies").length, 1);
    const journal = new RequestJournal(app.store, app.environments);
    const oldWorker = app.store.metadata("workerId");
    app.store.metadata("workerId", randomUUID());
    await assert.rejects(journal.check(pendingId), /원래 로컬 실행부/);
    app.store.metadata("workerId", oldWorker);
    const collision = randomUUID();
    app.store.receipt(collision, "다른 기존 요청");
    assert.throws(
      () =>
        journal.beginLocal(
          "/api/companies",
          { name: "다른 회사", mode: "group" },
          collision,
        ),
      /같은 요청 ID/,
    );
    assert.throws(
      () => journal.get(collision),
      /찾을 수 없습니다/,
      "접수와 전달 기록을 같은 트랜잭션으로 준비한다",
    );
    const missing = randomUUID();
    assert.deepEqual((await request(`requests/${missing}`)).data, {
      state: "missing",
    });
    app.runner.pump = () => {
      throw new Error("업무 접수 후 큐 호출 오류");
    };
    const partialId = randomUUID();
    const partial = { ...input, prompt: "부분 처리 오류 검사" };
    assert.equal((await request("tasks", partial, partialId)).status, 500);
    assert.equal((await request("tasks", partial, partialId)).status, 500);
    assert.equal((await request("tasks", partial)).data.pending, true);
    assert.equal(
      app.store.all("tasks").length,
      3,
      "500 응답을 새 실행으로 오인하지 않는다",
    );
    assert.equal(
      (await request(`request-journal/${partialId}/check`, {})).data.result
        .status,
      500,
    );
  } finally {
    await app.close();
  }
});
