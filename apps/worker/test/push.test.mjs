import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startServer } from "../src/server.mjs";
import { Company } from "../src/company.mjs";
import { git, checkpoint } from "../src/git.mjs";
import { ProjectPush, safePushURL } from "../src/push.mjs";
import { GitRecovery } from "../src/git-recovery.mjs";

test("명시 승인한 단일 원격 브랜치만 전송하고 기존 이력·태그·다른 대상과 중복 요청을 보호한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-push-"));
  const app = await startServer({
    directory: join(directory, "worker"),
    port: 0,
  });
  app.runner.pump = () => {};
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "전송 회사", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "원본",
    });
    const destination = join(directory, "푸시 대상.git");
    const fetchOnly = join(directory, "조회 대상.git");
    await git(directory, ["init", "--bare", destination]);
    await git(directory, ["init", "--bare", fetchOnly]);
    await git(project.root, ["remote", "add", "origin", fetchOnly]);
    await git(project.root, [
      "remote",
      "set-url",
      "--push",
      "origin",
      destination,
    ]);
    await writeFile(join(project.root, "결과.txt"), "첫 결과");
    const first = await checkpoint({ path: project.root }, "첫 결과");
    await git(project.root, ["tag", "local-tag"]);
    await git(project.root, ["branch", "local-only"]);
    await git(project.root, ["config", "remote.origin.mirror", "true"]);
    await git(project.root, ["config", "push.followTags", "true"]);
    await git(project.root, [
      "config",
      "push.pushOption",
      "do-not-send-this-option",
    ]);
    const hooks = join(directory, "hooks");
    await mkdir(hooks);
    await writeFile(
      join(hooks, "pre-push"),
      "#!/bin/sh\nprintf ran > hook-ran.txt\nexit 1\n",
      { mode: 0o700 },
    );
    await git(project.root, ["config", "core.hooksPath", hooks]);
    const push = new ProjectPush(app.store, app.runner);
    assert.equal((await push.options(project.id)).remotes[0].url, destination);
    const input = { remote: "origin", branch: "main" };
    let preview = await push.preview(project.id, input);
    assert.equal(preview.expected, "");
    assert.equal(preview.count, 1);
    assert.equal(await git(destination, ["show-ref"]).catch(() => ""), "");
    await assert.rejects(
      push.apply(project.id, {
        ...input,
        approval: preview.approval,
        confirm: true,
      }),
      /자동화/,
    );
    const url = `${app.origin}/api/projects/${project.id}/push`;
    assert.equal((await fetch(url)).status, 401);
    const headers = {
      Authorization: `Bearer ${app.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    };
    const body = JSON.stringify({
      ...input,
      approval: preview.approval,
      confirm: true,
      confirmAutomation: true,
    });
    const post = () => fetch(url, { method: "POST", headers, body });
    const response = await post();
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.commit, first);
    assert.equal(
      await git(destination, ["show-ref"]),
      `${first} refs/heads/main`,
    );
    assert.equal(await git(fetchOnly, ["show-ref"]).catch(() => ""), "");
    await assert.rejects(readFile(join(project.root, "hook-ran.txt")), {
      code: "ENOENT",
    });
    assert.deepEqual(await (await post()).json(), result);
    assert.equal(app.store.all("reports", project.id).length, 1);
    assert.equal((await push.preview(project.id, input)).alreadyPushed, true);
    await writeFile(join(project.root, "결과.txt"), "두 번째 결과");
    await assert.rejects(push.preview(project.id, input), /커밋하지 않은/);
    const second = await checkpoint({ path: project.root }, "추가 결과");
    await assert.rejects(
      push.apply(project.id, {
        ...input,
        approval: preview.approval,
        confirm: true,
        confirmAutomation: true,
      }),
      /바뀌었습니다/,
    );
    preview = await push.preview(project.id, input);
    assert.equal(preview.expected, first);
    await push.apply(project.id, {
      ...input,
      approval: preview.approval,
      confirm: true,
      confirmAutomation: true,
    });
    assert.equal(
      await git(destination, ["rev-parse", "refs/heads/main"]),
      second,
    );
    assert.equal(await git(project.root, ["status", "--porcelain"]), "");
    assert.equal(app.store.projectLocks.size, 0);

    // 원격에서 다른 사람이 만든 새 이력이 있으면 덮어쓰지 않는다.
    const outsider = join(directory, "outside");
    await git(directory, ["clone", destination, outsider]);
    await git(outsider, ["checkout", "main"]);
    await writeFile(join(outsider, "동료.txt"), "다른 사람 작업");
    const external = await checkpoint({ path: outsider }, "동료 작업");
    await git(outsider, ["push", "origin", "HEAD:refs/heads/main"]);
    await assert.rejects(push.preview(project.id, input), /원격의 변경/);
    assert.equal(
      await git(destination, ["rev-parse", "refs/heads/main"]),
      external,
    );
    await git(project.root, ["fetch", destination, "refs/heads/main"]);
    await assert.rejects(push.preview(project.id, input), /원격의 변경/);
    assert.match(app.store.all("reports", project.id).at(-1).text, /CI\/CD/);
  } finally {
    await app.close();
  }
});

test("자격 증명/도우미/다중 주소를 거부하고 전송 중 원격 변경은 lease로 보존한다", async () => {
  for (const url of [
    "https://secret@host/repo",
    "https://user:token@host/repo",
    "https://host/repo?token=secret",
    "ext::sh -c anything",
    "http://host/repo",
    "file://otherhost/repo",
    "/tmp/repo.git ",
  ])
    assert.throws(() => safePushURL(url));
  for (const url of [
    "git@github.com:org/repo.git",
    "ssh://git@host/repo",
    "https://host/repo.git",
    "/tmp/repo.git",
  ])
    assert.equal(safePushURL(url), url);
  const directory = await mkdtemp(join(tmpdir(), "otter-push-race-"));
  const app = await startServer({
    directory: join(directory, "worker"),
    port: 0,
  });
  app.runner.pump = () => {};
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "경쟁 검사", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "repo",
    });
    const destination = join(directory, "remote.git");
    await git(directory, ["init", "--bare", destination]);
    await git(project.root, ["remote", "add", "origin", destination]);
    await writeFile(join(project.root, "file.txt"), "one");
    const first = await checkpoint({ path: project.root }, "one");
    await writeFile(join(project.root, "file.txt"), "two");
    await checkpoint({ path: project.root }, "two");
    const push = new ProjectPush(app.store, app.runner);
    const input = { remote: "origin", branch: "main" };
    const middle = join(directory, "middle.git");
    const final = join(directory, "final.git");
    await git(project.root, [
      "config",
      `url.${middle}.pushInsteadOf`,
      destination,
    ]);
    await git(project.root, ["config", `url.${final}.pushInsteadOf`, middle]);
    assert.match((await push.options(project.id)).remotes[0].error, /재작성/);
    await git(project.root, [
      "config",
      "--unset",
      `url.${middle}.pushInsteadOf`,
    ]);
    await git(project.root, [
      "config",
      "--unset",
      `url.${final}.pushInsteadOf`,
    ]);
    await git(project.root, [
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://user:fixture-secret@invalid.test/repo",
    ]);
    assert.equal(
      JSON.stringify(await push.options(project.id)).includes("fixture-secret"),
      false,
    );
    await git(project.root, [
      "remote",
      "set-url",
      "--push",
      "origin",
      destination,
    ]);
    const preview = await push.preview(project.id, input);
    const realPreview = push.preview.bind(push);
    push.preview = async (...args) => {
      const value = await realPreview(...args);
      await git(project.root, ["push", "origin", `${first}:refs/heads/main`]);
      return value;
    };
    await assert.rejects(
      push.apply(project.id, {
        ...input,
        approval: preview.approval,
        confirm: true,
        confirmAutomation: true,
      }),
      /확정하지 못했습니다/,
    );
    assert.equal(
      await git(destination, ["rev-parse", "refs/heads/main"]),
      first,
    );
    assert.equal(
      app.store.get("projects", project.id).push.status,
      "unconfirmed",
    );
    assert.equal(app.store.projectLocks.size, 0);
    await assert.rejects(push.preview(project.id, input), /이전 푸시/);
    const recovery = new GitRecovery(app.store, app.runner);
    assert.equal(app.store.get("projects", project.id).push.rejected, true);
    const observation = await recovery.observe("push", project.id);
    assert.equal(observation.outcome, "not-applied");
    await recovery.resolve("push", project.id, {
      confirm: true,
      approval: observation.approval,
    });
    assert.equal(
      app.store.get("projects", project.id).push.status,
      "not-pushed",
    );
    assert.equal(
      await git(destination, ["rev-parse", "refs/heads/main"]),
      first,
    );
    await git(project.root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      destination,
    ]);
    await git(project.root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      join(directory, "other.git"),
    ]);
    const options = await push.options(project.id);
    assert.match(options.remotes[0].error, /여러 푸시 주소/);
    assert.equal(options.remotes[0].url, undefined);
  } finally {
    await app.close();
  }
});
