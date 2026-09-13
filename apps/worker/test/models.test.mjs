import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexReadiness } from "../src/readiness.mjs";
import { startServer } from "../src/server.mjs";

function fixture(pages) {
  const calls = [];
  const client = new EventEmitter();
  client.initialize = async () => calls.push("initialize");
  client.close = async () => calls.push("close");
  client.refuse = () => calls.push("refuse");
  client.request = async (method, params) => {
    assert.equal(
      method,
      "model/list",
      "모델 실행·명령·로그인·설정 변경은 하지 않는다",
    );
    assert.equal(params.includeHidden, false);
    calls.push(params);
    return pages.shift();
  };
  return { client, calls };
}

test("모델 조회는 페이지를 합치고 숨김·중복·민감 필드를 제외하며 실패 응답은 노출하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-models-test-"));
  const { client, calls } = fixture([
    {
      data: [
        {
          model: "one",
          displayName: "첫 모델",
          isDefault: true,
          private: "secret",
        },
      ],
      nextCursor: "next",
    },
    {
      data: [
        { model: "one" },
        { model: "hidden", hidden: true },
        { model: "two" },
      ],
      nextCursor: null,
    },
  ]);
  const service = new CodexReadiness(directory, () => client);
  const pending = service.models();
  assert.equal(service.models(), pending);
  assert.throws(() => service.check(), /조회 중/);
  const result = await pending;
  assert.deepEqual(
    result.models.map((m) => m.model),
    ["one", "two"],
  );
  assert.equal(calls[2].cursor, "next");
  assert.equal(calls.at(-1), "close");
  assert.ok(!JSON.stringify(result).includes("secret"));
  for (const pages of [
    [{}],
    [{ data: [{ model: "" }] }],
    [
      { data: [], nextCursor: "loop" },
      { data: [], nextCursor: "loop" },
    ],
  ]) {
    const broken = fixture(pages);
    await assert.rejects(
      new CodexReadiness(directory, () => broken.client).models(),
      /조회하지 못했습니다/,
    );
    assert.equal(broken.calls.at(-1), "close");
  }
  const empty = await new CodexReadiness(
    directory,
    () => fixture([{ data: [], nextCursor: null }]).client,
  ).models();
  assert.deepEqual(empty.models, []);
});

test("인증된 모델 조회만 선택 환경으로 전달하고 업무·접수 기록·로컬 대체 실행을 만들지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-models-http-"));
  let localCalls = 0;
  const app = await startServer({
    directory,
    port: 0,
    makeCodex: () => {
      localCalls++;
      return fixture([{ data: [{ model: "local-model" }] }]).client;
    },
  });
  try {
    const headers = { Authorization: `Bearer ${app.token}` };
    assert.equal((await fetch(app.origin + "/api/codex-models")).status, 401);
    const env = app.environments.add({
      name: "원격",
      kind: "ssh",
      host: "test.invalid",
      slots: 1,
    });
    app.store.update("environments", env.id, { workerId: "test-worker" });
    app.environments.clients.set(env.id, {
      health: { workerId: "test-worker" },
      disconnect() {},
      async request(method, path) {
        assert.equal(method, "GET");
        assert.equal(path, "/api/codex-models");
        return { status: 200, data: { models: [{ model: "remote-model" }] } };
      },
    });
    const remote = await fetch(app.origin + "/api/codex-models", {
      headers: { ...headers, "X-Otter-Environment": env.id },
    });
    assert.equal(remote.status, 200);
    assert.equal((await remote.json()).models[0].model, "remote-model");
    assert.equal(localCalls, 0);
    app.environments.clients.delete(env.id);
    assert.notEqual(
      (
        await fetch(app.origin + "/api/codex-models", {
          headers: { ...headers, "X-Otter-Environment": env.id },
        })
      ).status,
      200,
    );
    assert.equal(localCalls, 0);
    assert.equal(
      (
        await (
          await fetch(app.origin + "/api/codex-models", { headers })
        ).json()
      ).models[0].model,
      "local-model",
    );
    assert.equal(localCalls, 1);
    assert.equal(app.store.all("tasks").length, 0);
  } finally {
    await app.close();
  }
});
