// Opt-in isolated local SSH test. Creates only temporary keys/config/repos; no user auth files or LLM calls.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Remote, environmentInput } from "../apps/worker/src/remote.mjs";

if (!process.argv.includes("--run")) {
  console.log(
    "실행: node scripts/smoke-v2-ssh.mjs --run (OpenSSH 서버 필요, 임시 로컬 환경만 사용)",
  );
  process.exit(0);
}
const exec = promisify(execFile);
// StrictModes validates every parent of AuthorizedKeysFile; /tmp is intentionally world-writable.
const fixtures = fileURLToPath(new URL("../.otter-dev/", import.meta.url));
await mkdir(fixtures, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(fixtures, "ssh-smoke-"));
const hostKey = join(directory, "host-key");
const identityFile = join(directory, "client-key");
for (const path of [hostKey, identityFile])
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const username = userInfo().username;
const configuration = join(directory, "sshd_config");
await writeFile(
  configuration,
  [
    `ListenAddress 127.0.0.1`,
    `Port ${port}`,
    `HostKey ${hostKey}`,
    `PidFile ${join(directory, "sshd.pid")}`,
    `AuthorizedKeysFile ${identityFile}.pub`,
    `AllowUsers ${username}`,
    "UsePAM yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "StrictModes yes",
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "LogLevel VERBOSE",
  ].join("\n") + "\n",
  { mode: 0o600 },
);
const knownHosts = join(directory, "known_hosts");
await writeFile(
  knownHosts,
  `[127.0.0.1]:${port} ${await readFile(hostKey + ".pub", "utf8")}`,
  { mode: 0o600 },
);
const sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", configuration], {
  stdio: ["ignore", "ignore", "pipe"],
});
let diagnostics = "";
sshd.stderr.on("data", (chunk) => (diagnostics += chunk.toString()));
sshd.on("error", (error) => {
  diagnostics += error.message;
});
const environment = environmentInput({
  name: "임시 로컬 SSH",
  kind: "ssh",
  host: "127.0.0.1",
  port,
  username,
  identityFile,
  nodeExecutable: process.execPath,
  directory: join(directory, "worker"),
  slots: 1,
});
const remote = new Remote(environment, {
  launch: (command, args, options) => {
    const child = spawn(
      command,
      [
        "-F",
        "/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "UserKnownHostsFile=" + knownHosts,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        ...args,
      ],
      options,
    );
    child.stderr.on("data", (chunk) => (diagnostics += chunk.toString()));
    return child;
  },
  timeout: 20000,
});
let workerPid;
const useCodex = process.argv.includes("--codex");
try {
  // Read-only readiness probe; only a TCP handshake to the temporary loopback listener.
  const { connect } = await import("node:net");
  const deadline = Date.now() + 5000;
  while (true) {
    const ready = await new Promise((resolve) => {
      const client = connect(port, "127.0.0.1");
      client.on("connect", () => {
        client.destroy();
        resolve(true);
      });
      client.on("error", () => resolve(false));
    });
    if (ready) break;
    if (sshd.exitCode !== null || Date.now() > deadline)
      throw new Error("임시 sshd 시작 실패: " + diagnostics);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const owner = randomUUID();
  await remote.connect(owner);
  workerPid = JSON.parse(
    await readFile(join(environment.directory, "connection.json"), "utf8"),
  ).pid;
  const company = await remote.request("POST", "/api/companies", {
    name: "SSH 검증 회사",
    mode: "group",
  });
  assert.equal(company.status, 201);
  const id = randomUUID();
  const input = {
    companyId: company.data.id,
    create: true,
    parent: directory,
    folder: "ssh-project",
  };
  const project = await remote.request("POST", "/api/projects", input, id);
  assert.equal(project.status, 201);
  remote.disconnect();
  process.kill(workerPid, 0);
  await remote.connect(owner);
  assert.equal(
    JSON.parse(
      await readFile(join(environment.directory, "connection.json"), "utf8"),
    ).pid,
    workerPid,
  );
  assert.deepEqual(
    await remote.request("POST", "/api/projects", input, id),
    project,
  );
  const receipt = await remote.request("GET", `/api/requests/${id}`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.state, "completed");
  assert.deepEqual(receipt.data.result, project);
  assert.equal(
    (await remote.request("GET", `/api/requests/${randomUUID()}`)).data.state,
    "missing",
  );
  assert.equal(
    (await remote.request("GET", "/api/state")).data.projects.length,
    1,
  );
  if (useCodex) {
    console.log(
      "기존 Codex 구독 사용량을 쓰는 원격 단일 파일 검사입니다: " + directory,
    );
    const call = async (path, data) => {
      const result = await remote.request(
        data === undefined ? "GET" : "POST",
        "/api/" + path,
        data,
      );
      assert.ok(result.status < 300, JSON.stringify(result.data));
      return result.data;
    };
    const employee = await call("employees", {
      name: "SSH 연동 확인",
      role: "단일 파일 작성",
      instructions:
        "요청한 파일 하나만 apply_patch로 작성하세요. 셸, 네트워크, 하위 에이전트 호출은 하지 마세요.",
    });
    const assignment = await call("assignments", {
      projectId: project.data.id,
      employeeId: employee.id,
    });
    const task = await call("tasks", {
      projectId: project.data.id,
      assignmentId: assignment.id,
      prompt:
        "이 임시 폴더에 hello.txt 파일 하나를 만들고 정확히 Hello Otter 한 줄을 넣어 주세요. apply_patch만 사용하고 완료 보고는 한 문장으로 해 주세요.",
    });
    remote.disconnect();
    process.kill(workerPid, 0);
    await remote.connect(owner);
    const deadline = Date.now() + 180000;
    let lastStatus = "";
    while (true) {
      const state = await call("state?projectId=" + project.data.id);
      const current = state.tasks.find((item) => item.id === task.id);
      if (current.status !== lastStatus) {
        console.log("원격 Codex 업무: " + current.status);
        lastStatus = current.status;
      }
      for (const approval of state.approvals.filter(
        (item) => item.status === "pending",
      )) {
        const changes = approval.params.changes;
        const allowed =
          approval.taskId === task.id &&
          approval.method === "item/fileChange/requestApproval" &&
          !approval.params.grantRoot &&
          changes?.length === 1 &&
          current.worktree?.path.startsWith(
            join(environment.directory, "worktrees") + "/",
          ) &&
          resolve(current.worktree.path, changes[0].path) ===
            join(current.worktree.path, "hello.txt") &&
          changes[0].diff.includes("Hello Otter") &&
          changes[0].diff.length < 500;
        assert.ok(
          allowed,
          "정해진 임시 파일 밖의 승인 요청은 허용하지 않습니다.",
        );
        await call("approvals/" + approval.id + "/resolve", {
          decision: "accept",
        });
        console.log("임시 worktree의 hello.txt 변경만 승인");
      }
      if (
        ["review", "failed", "interrupted", "blocked"].includes(current.status)
      ) {
        assert.equal(
          current.status,
          "review",
          current.error || "원격 Codex 실행 실패",
        );
        assert.equal(
          (
            await readFile(join(current.worktree.path, "hello.txt"), "utf8")
          ).trim(),
          "Hello Otter",
        );
        assert.equal(state.tasks.length, 1);
        assert.equal(state.reports.length, 1);
        await call("tasks/" + task.id + "/accept", {
          revision: current.revision,
          confirm: true,
        });
        assert.equal(
          (await call("state?projectId=" + project.data.id)).tasks[0].status,
          "completed",
        );
        console.log(
          "PASS 실제 SSH + Codex: 접속 해제 중 실행, 파일 승인, 결과 커밋/보고/검토 완료",
        );
        break;
      }
      if (Date.now() > deadline)
        throw new Error(
          "원격 Codex 검사 시간 초과. 재실행하지 않고 임시 실행부를 중단합니다.",
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert.equal((await remote.request("POST", "/api/shutdown", {})).status, 200);
  console.log(
    "PASS 실제 SSH: 임시 키 인증, 실행부 설치, 저장소 생성, 연결 해제/PID 유지, 재접속, 요청 중복 방지",
  );
  console.log(
    "증거: " +
      directory +
      (useCodex
        ? " (Codex 포함, 다른 OS 미검증)"
        : " (실제 Codex/다른 OS 검증은 포함하지 않음)"),
  );
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  remote.disconnect();
  if (workerPid) {
    try {
      process.kill(workerPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  sshd.kill("SIGTERM");
  await new Promise((resolve) => {
    if (sshd.exitCode !== null || sshd.signalCode !== null) resolve();
    else sshd.once("exit", resolve);
  });
}
