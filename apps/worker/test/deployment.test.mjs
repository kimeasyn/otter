import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.mjs";
import { Company } from "../src/company.mjs";
import { checkpoint } from "../src/git.mjs";

async function until(check) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("배포 상태 대기 시간 초과");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "otter-deploy-"));
  const directory = join(root, "worker");
  const app = await startServer({
    directory,
    port: 0,
    makeCodex: () => {
      throw new Error("모델 호출 금지");
    },
  });
  const company = new Company(app.store);
  const org = company.createCompany({ name: "배포 검사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: root,
    folder: "project",
  });
  await writeFile(join(project.root, "README.md"), "배포할 원본");
  await checkpoint({ path: project.root }, "배포 결과");
  const marker = join(root, "deployed");
  const input = {
    name: "임시 배포",
    command: [
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync(process.argv[1], 'deployed\\n')",
      marker,
    ],
    timeoutSeconds: 5,
  };
  const call = async (path, value, key = randomUUID()) => {
    const response = await fetch(
      app.origin + "/api/projects/" + project.id + "/" + path,
      {
        method: "POST",
        body: JSON.stringify(value),
        headers: {
          Authorization: `Bearer ${app.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
      },
    );
    const data = await response.json();
    const receipt = response.headers.get("X-Otter-Receipt");
    if (receipt && response.status < 500 && !data.pending) {
      const ack = await fetch(
        `${app.origin}/api/request-journal/${receipt}/ack`,
        {
          method: "POST",
          body: "{}",
          headers: { Authorization: `Bearer ${app.token}` },
        },
      );
      assert.equal(ack.status, 200);
    }
    return { status: response.status, data };
  };
  const preview = async (value = input) => {
    const result = await call("deployment-preview", value);
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  };
  return {
    root,
    directory,
    app,
    company,
    project,
    marker,
    input,
    call,
    preview,
  };
}

test("배포 명령은 최신 커밋과 명시 승인을 요구하고 같은 접수 ID로 두 번 실행하지 않는다", async () => {
  const f = await fixture();
  try {
    const secret = randomUUID();
    const secretPath = join(f.root, "test-secret");
    await writeFile(secretPath, secret);
    f.input.command[2] +=
      ";process.stdout.write(require('node:fs').readFileSync(process.argv[2]));process.stderr.write(require('node:fs').readFileSync(process.argv[2]))";
    f.input.command.push(secretPath);
    assert.equal(
      f.app.store.get("projects", f.project.id).deployment,
      undefined,
    );
    assert.equal(
      (
        await f.call("deployment-preview", {
          ...f.input,
          command: ["node", "-v"],
        })
      ).status,
      400,
    );
    const old = await f.preview();
    assert.equal(
      f.app.store.db
        .prepare(
          "SELECT count(*) AS n FROM request_journal WHERE json_extract(data,'$.path') LIKE '%/deployment-preview'",
        )
        .get().n,
      0,
    );
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
    assert.equal((await f.call("deploy", old)).status, 409);
    f.app.store.update("projects", f.project.id, { name: "변경" });
    assert.equal(
      (await f.call("deploy", { ...old, confirm: true, confirmAccess: true }))
        .status,
      409,
    );
    const approved = {
      ...(await f.preview()),
      confirm: true,
      confirmAccess: true,
    };
    const key = randomUUID();
    assert.equal((await f.call("deploy", approved, key)).status, 200);
    await until(
      () =>
        f.app.store.get("projects", f.project.id).deployment.status ===
        "succeeded",
    );
    assert.equal((await f.call("deploy", approved, key)).status, 200);
    assert.equal(await readFile(f.marker, "utf8"), "deployed\n");
    const last = f.app.store.get("projects", f.project.id).deployment;
    assert.equal(last.process.closed, true);
    assert.equal(last.process.code, 0);
    assert.match(last.message, /별도로 확인/);
    assert.equal(JSON.stringify(last).includes(secret), false);
    assert.equal(
      JSON.stringify(f.app.store.all("reports", f.project.id)).includes(secret),
      false,
    );
    assert.equal(
      f.app.store
        .all("reports", f.project.id)
        .filter((r) => r.kind === "deployment").length,
      1,
    );
    const repeated = {
      ...(await f.preview()),
      confirm: true,
      confirmAccess: true,
    };
    assert.equal((await f.call("deploy", repeated)).status, 409);
    assert.equal(await readFile(f.marker, "utf8"), "deployed\n");
    const executablePath = join(f.root, "deploy-tool");
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const executablePreview = await f.preview({
      ...f.input,
      command: [executablePath],
    });
    await writeFile(executablePath, "#!/bin/sh\nexit 1\n");
    assert.equal(
      (
        await f.call("deploy", {
          ...executablePreview,
          confirm: true,
          confirmAccess: true,
          confirmRepeat: true,
        })
      ).status,
      409,
    );
    await writeFile(join(f.project.root, "README.md"), "외부 수정");
    assert.equal((await f.call("deployment-preview", f.input)).status, 409);
  } finally {
    await f.app.close();
  }
});

test("시간 초과는 외부 효과를 되돌린 것으로 표시하지 않고 종료 및 사용자 확인 전 재실행을 막는다", async () => {
  const f = await fixture();
  try {
    const input = {
      ...f.input,
      command: [
        ...f.input.command.slice(0, 2),
        f.input.command[2] + ";setInterval(()=>{},1000)",
        f.marker,
      ],
      timeoutSeconds: 1,
    };
    const start = await f.call("deploy", {
      ...(await f.preview(input)),
      confirm: true,
      confirmAccess: true,
    });
    assert.equal(start.status, 200);
    assert.throws(() => f.company.archiveProject(f.project.id), /배포/);
    await until(
      () =>
        f.app.store.get("projects", f.project.id).deployment.status ===
        "unconfirmed",
    );
    const project = f.app.store.get("projects", f.project.id);
    assert.equal(project.deployment.timedOut, true);
    assert.equal(project.deployment.process.closed, true);
    assert.equal(await readFile(f.marker, "utf8"), "deployed\n");
    assert.equal((await f.call("deployment-preview", f.input)).status, 409);
    assert.equal(
      (
        await f.call("deployment-acknowledge", {
          id: project.deployment.id,
          revision: project.revision,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call("deployment-acknowledge", {
          id: project.deployment.id,
          revision: project.revision,
          confirm: true,
          note: "임시 파일 생성과 명령 종료를 확인했다. 외부 서비스 없음.",
        })
      ).status,
      200,
    );
    assert.equal(
      f.app.store.get("projects", f.project.id).deployment.status,
      "acknowledged",
    );
    assert.equal(await readFile(f.marker, "utf8"), "deployed\n");
    await f.preview();
  } finally {
    await f.app.close();
  }
});

test("응답 이후 배포가 진행 중이어도 앱은 결과 기록을 기다리고 재시작 기록을 자동 실행하지 않는다", async () => {
  const f = await fixture();
  let app = f.app;
  try {
    const input = {
      ...f.input,
      command: [
        process.execPath,
        "-e",
        "setTimeout(()=>require('node:fs').appendFileSync(process.argv[1], 'deployed\\n'), 300)",
        f.marker,
      ],
    };
    assert.equal(
      (
        await f.call("deploy", {
          ...(await f.preview(input)),
          confirm: true,
          confirmAccess: true,
        })
      ).status,
      200,
    );
    assert.equal(app.deployment.running.size, 1);
    await app.close();
    assert.equal(await readFile(f.marker, "utf8"), "deployed\n");
    app = await startServer({ directory: f.directory, port: 0 });
    const project = app.store.get("projects", f.project.id);
    assert.equal(project.deployment.status, "succeeded");
    app.store.update("projects", project.id, {
      deployment: { ...project.deployment, status: "running" },
    });
    await app.close();
    app = await startServer({ directory: f.directory, port: 0 });
    assert.equal(
      app.store.get("projects", project.id).deployment.status,
      "unconfirmed",
    );
    assert.equal(app.deployment.running.size, 0);
    assert.equal(await readFile(f.marker, "utf8"), "deployed\n");
    const recovered = app.store.get("projects", project.id);
    const pending = app.store.update("projects", project.id, {
      deployment: {
        ...recovered.deployment,
        process: { pid: process.pid, closed: false },
      },
    });
    assert.throws(
      () =>
        app.deployment.acknowledge(project.id, {
          id: pending.deployment.id,
          revision: pending.revision,
          confirm: true,
          note: "프로세스가 살아 있으므로 해제하면 안 됨",
        }),
      /종료를 확인하지 못했습니다/,
    );
  } finally {
    await app.close();
  }
});

test(
  "프로세스 그룹 조회 권한 오류와 잘못된 그룹 번호를 종료 증거로 취급하지 않는다",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture();
    const record = {
      ...(await f.preview()),
      id: randomUUID(),
      status: "unconfirmed",
      process: {
        pid: null,
        closed: true,
        groupId: 12345,
        groupState: "unknown",
      },
    };
    let probes = 0;
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(pid, -12345);
      assert.equal(
        signal,
        0,
        "관찰만 하며 저장된 번호로 종료 신호를 보내지 않는다",
      );
      probes++;
      throw Object.assign(new Error("검사 접근 거부"), { code: "EPERM" });
    });
    const acknowledge = (project) =>
      f.app.deployment.acknowledge(f.project.id, {
        id: record.id,
        revision: project.revision,
        confirm: true,
        note: "조회 실패를 종료로 취급하지 않는다",
      });
    try {
      const project = f.app.store.update("projects", f.project.id, {
        deployment: record,
      });
      assert.throws(() => acknowledge(project), /프로세스 그룹/);
      await assert.rejects(f.app.close(), {
        code: "OTTER_DEPLOYMENT_GROUP_PENDING",
      });
      assert.equal(probes, 2);
      for (const groupId of [1, 0, -1, 1.5]) {
        const invalid = f.app.store.update("projects", f.project.id, {
          deployment: { ...record, process: { ...record.process, groupId } },
        });
        assert.throws(() => acknowledge(invalid), /프로세스 그룹/);
      }
      assert.equal(probes, 2, "잘못된 그룹 번호는 OS 조회에 전달하지 않는다");
      const ended = f.app.store.update("projects", f.project.id, {
        deployment: {
          ...record,
          process: { ...record.process, groupState: "absent" },
        },
      });
      acknowledge(ended);
      assert.equal(
        probes,
        2,
        "이미 부재를 확인한 번호를 다시 조회해 재사용된 그룹과 연결하지 않는다",
      );
    } finally {
      // 이 검사는 실제 프로세스가 아닌 조회 오류/기록 경계용 자료만 사용한다.
      f.app.store.update("projects", f.project.id, { deployment: null });
      t.mock.restoreAll();
      await f.app.close();
    }
  },
);

test(
  "상위 명령 종료 후 남은 배포 프로세스 그룹은 완료·재실행·종료를 막고 실제 부재 후에만 해제한다",
  { skip: process.platform === "win32" },
  async () => {
    if (
      process.platform === "linux" &&
      process.env.OTTER_DEPLOY_GROUP_TEST !== "1"
    ) {
      // 검사 프로세스에만 subreaper를 둔다. 컨테이너 PID 1에 고아/좀비를 남기지 않고
      // 실제 후속 프로세스의 종료·회수를 확인한다. 제품에는 Python 의존성을 추가하지 않는다.
      const supervisor = `import ctypes, os, subprocess, sys
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError('검사 subreaper 설정 실패')
child = subprocess.Popen(sys.argv[1:])
code = 1
while True:
    try:
        pid, status = os.wait()
    except ChildProcessError:
        break
    if pid == child.pid:
        code = os.waitstatus_to_exitcode(status)
        child.returncode = code
sys.exit(code)
`;
      const groupTestEnv = { ...process.env, OTTER_DEPLOY_GROUP_TEST: "1" };
      delete groupTestEnv.NODE_TEST_CONTEXT;
      const { stdout } = await promisify(execFile)(
        "python3",
        [
          "-c",
          supervisor,
          process.execPath,
          "--test",
          "--test-name-pattern=상위 명령 종료 후 남은 배포 프로세스 그룹",
          fileURLToPath(import.meta.url),
        ],
        {
          env: groupTestEnv,
          timeout: 30000,
        },
      );
      assert.match(stdout, /OTTER_DEPLOY_GROUP_VERIFIED/);
      console.log(
        stdout
          .split("\n")
          .find((line) => line.includes("OTTER_DEPLOY_GROUP_VERIFIED")),
      );
      return;
    }
    const f = await fixture();
    let app = f.app;
    const pidFile = join(f.root, "followup.pid"),
      release = join(f.root, "release-followup");
    let record;
    const groupAbsent = () => {
      try {
        process.kill(-record.process.groupId, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    };
    try {
      const followup = `const fs=require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid));
setInterval(()=>{if(fs.existsSync(process.argv[2])) process.exit(0)},20);
setTimeout(()=>process.exit(0),15000).unref();`;
      const input = {
        ...f.input,
        command: [
          process.execPath,
          "-e",
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(followup)}, ...process.argv.slice(1)], {stdio:'ignore'}).unref()`,
          pidFile,
          release,
        ],
      };
      const preview = await f.preview(input);
      assert.equal(preview.processTracking, "posix-group");
      assert.equal(
        (
          await f.call("deploy", {
            ...preview,
            confirm: true,
            confirmAccess: true,
          })
        ).status,
        200,
      );
      await until(() =>
        readFile(pidFile).then(
          () => true,
          () => false,
        ),
      );
      await until(
        () =>
          app.store.get("projects", f.project.id).deployment.status ===
          "unconfirmed",
      );
      const project = app.store.get("projects", f.project.id);
      record = project.deployment;
      assert.equal(record.process.code, 0);
      assert.equal(record.process.closed, true);
      assert.equal(record.process.groupState, "present");
      assert.equal(record.process.groupId, record.process.pid);
      assert.notEqual(
        Number(await readFile(pidFile, "utf8")),
        record.process.pid,
      );
      assert.equal(groupAbsent(), false);
      assert.match(record.message, /상위 배포 명령은 종료됐지만/);
      assert.equal(
        app.store.all("reports", f.project.id)[0].title,
        "배포 결과 확인 필요",
      );
      assert.equal((await f.call("deployment-preview", f.input)).status, 409);
      assert.equal(
        (
          await f.call("deployment-acknowledge", {
            id: record.id,
            revision: project.revision,
            confirm: true,
            note: "상위만 종료한 상태에서는 승인할 수 없다",
          })
        ).status,
        409,
      );
      await assert.rejects(app.close(), {
        code: "OTTER_DEPLOYMENT_GROUP_PENDING",
      });
      assert.ok(await readFile(join(f.directory, "worker.lock")));
      assert.equal(
        app.store.get("projects", f.project.id).deployment.status,
        "unconfirmed",
      );
      assert.equal(
        (
          await fetch(app.origin + "/api/health", {
            headers: { Authorization: `Bearer ${app.token}` },
          })
        ).status,
        200,
      );
      await assert.rejects(
        startServer({ directory: f.directory, port: 0 }),
        /잠금/,
      );
      await writeFile(release, "검사 후속 프로세스의 정상 종료 허용");
      await until(groupAbsent);
      await app.close();
      app = await startServer({ directory: f.directory, port: 0 });
      const restored = app.store.get("projects", f.project.id);
      assert.equal(restored.deployment.process.groupState, "absent");
      assert.equal(
        restored.deployment.status,
        "unconfirmed",
        "프로세스 종료를 서비스 성공으로 바꾸지 않는다",
      );
      assert.equal(app.deployment.running.size, 0);
      app.deployment.acknowledge(f.project.id, {
        id: record.id,
        revision: restored.revision,
        confirm: true,
        note: "검사 후속 프로세스가 끝났고 외부 서비스는 사용하지 않았다",
      });
      assert.equal(
        app.store.get("projects", f.project.id).deployment.status,
        "acknowledged",
      );
      console.log(
        "OTTER_DEPLOY_GROUP_VERIFIED",
        JSON.stringify({
          root: f.root,
          groupId: record.process.groupId,
          remainingDetected: true,
          parentCode: record.process.code,
          groupAbsent: groupAbsent(),
        }),
      );
    } finally {
      await writeFile(release, "검사 정리");
      if (record?.process.groupId) await until(groupAbsent);
      await app.close();
    }
  },
);
