// SSH/WSL의 인증된 표준입출력 안에서 실행한다. 토큰은 원격 개인 폴더 밖으로 보내지 않는다.
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  open,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let ready;
let preparing = false;
let startAttempted = false;
let existingWorker = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error(
      "Otter 실행부 폴더는 현재 사용자만 접근하는 실제 디렉토리여야 합니다.",
    );
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function stoppedState(directory, payload) {
  if (await exists(join(directory, "worker.lock")))
    throw new Error(
      "기존 실행부 잠금이 있습니다. 실행 상태가 불확실하므로 시작하거나 예약을 반환하지 않습니다.",
    );
  const markerPath = join(directory, "stopped.json");
  if (!(await exists(markerPath))) {
    if (
      payload.expectedWorkerId ||
      payload.expectedStartId ||
      (await exists(join(directory, "otter.db")))
    )
      throw new Error(
        "기존 실행부의 정상 종료를 확인할 수 없습니다. 원격 프로세스와 작업을 먼저 확인해 주세요.",
      );
    return {
      protocol: 1,
      controllerId: payload.controllerId,
      settings: { concurrency: payload.slots },
      lifecycle: "absent",
    };
  }
  const stat = await lstat(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("실행부 종료 기록을 안전하게 읽을 수 없습니다.");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (
    marker.controllerId !== payload.controllerId ||
    (payload.expectedWorkerId &&
      marker.workerId !== payload.expectedWorkerId) ||
    (payload.expectedStartId && marker.startId !== payload.expectedStartId)
  )
    throw new Error("확인하려는 실행부와 종료 기록이 다릅니다.");
  if (!Number.isInteger(marker.pid) || marker.pid <= 1)
    throw new Error("종료 기록의 프로세스 식별자가 잘못되었습니다.");
  try {
    process.kill(marker.pid, 0);
    throw new Error(
      "이전 실행부 PID가 아직 존재합니다. 종료 여부를 확인하기 전에는 예약을 반환하지 않습니다.",
    );
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  return { ...marker, protocol: 1, lifecycle: "stopped" };
}
async function connection(directory) {
  const file = join(directory, "connection.json");
  let data;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("unsafe");
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("원격 연결 파일을 안전하게 읽을 수 없습니다.");
  }
  if (
    !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(data.origin) ||
    !/^[a-f0-9]{64}$/.test(data.token)
  )
    throw new Error("원격 연결 정보가 올바르지 않습니다.");
  try {
    const response = await fetch(data.origin + "/api/health", {
      headers: { Authorization: "Bearer " + data.token },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const health = await response.json();
    if (health.protocol !== 1)
      throw new Error("지원하지 않는 실행부 프로토콜입니다.");
    return { ...data, health };
  } catch {
    return null;
  }
}
async function prepare(payload) {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("이 환경에 Node.js 24 이상이 필요합니다.");
  if (
    !payload ||
    !payload.files ||
    typeof payload.files !== "object" ||
    Array.isArray(payload.files) ||
    !/^[a-f0-9]{64}$/.test(payload.version)
  )
    throw new Error("설치 데이터가 올바르지 않습니다.");
  if (
    createHash("sha256").update(JSON.stringify(payload.files)).digest("hex") !==
    payload.version
  )
    throw new Error("실행부 파일 검사에 실패했습니다.");
  if (
    typeof payload.controllerId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(payload.controllerId) ||
    !Number.isInteger(payload.slots) ||
    payload.slots < 1 ||
    payload.slots > 16
  )
    throw new Error("실행부 소유권과 예약 실행 수를 확인해 주세요.");
  const requestedDirectory =
    payload.directory || join(homedir(), ".otter-v2-remote");
  if (!isAbsolute(requestedDirectory))
    throw new Error("실행부 전용 절대 경로가 필요합니다.");
  const directory = resolve(requestedDirectory);
  if (directory === resolve(homedir()) || directory === "/")
    throw new Error("실행부 전용 절대 경로가 필요합니다.");
  if (payload.mode === "inspect" && !(await exists(directory))) {
    const health = await stoppedState(directory, payload);
    return { directory, health };
  }
  await privateDirectory(directory);
  let current = await connection(directory);
  existingWorker = !!current;
  if (
    current &&
    (current.health.controllerId !== payload.controllerId ||
      (payload.expectedWorkerId &&
        current.health.workerId !== payload.expectedWorkerId))
  )
    throw new Error("등록된 실행부와 다른 소유권 또는 데이터 폴더입니다.");
  if (payload.mode === "inspect")
    return current
      ? {
          ...current,
          directory,
          health: { ...current.health, lifecycle: "running" },
        }
      : { directory, health: await stoppedState(directory, payload) };
  if (current && current.workerVersion !== payload.version)
    throw new Error(
      "다른 버전의 실행부가 이미 동작 중입니다. 원격 작업을 안전하게 종료하고 실행부를 업데이트해 주세요.",
    );
  if (
    current &&
    (current.health.controllerId !== payload.controllerId ||
      current.health.settings.concurrency !== payload.slots)
  )
    throw new Error(
      "다른 앱의 실행부이거나 예약 실행 수가 다릅니다. 기존 실행부를 먼저 확인해 주세요.",
    );
  if (!current) {
    if (payload.expectedWorkerId || payload.expectedStartId)
      await stoppedState(directory, payload);
    try {
      await lstat(join(directory, "worker.lock"));
      throw new Error(
        "기존 실행부 잠금이 있습니다. 기존 작업 종료 여부를 확인하기 전에는 새 실행부를 시작하지 않습니다.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const release = join(directory, "releases", payload.version);
    await mkdir(release, { recursive: true, mode: 0o700 });
    for (const [name, source] of Object.entries(payload.files)) {
      if (!/^[a-z][a-z0-9-]*\.mjs$/.test(name) || typeof source !== "string")
        throw new Error("허용되지 않은 실행부 파일입니다.");
      try {
        await writeFile(join(release, name), source, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if (
          error.code !== "EEXIST" ||
          (await readFile(join(release, name), "utf8")) !== source
        )
          throw new Error("설치 파일이 기존 내용과 다릅니다.");
      }
    }
    const output = await open(join(directory, "worker.log"), "a", 0o600);
    startAttempted = true;
    const child = spawn(
      process.execPath,
      [
        join(release, "headless.mjs"),
        directory,
        payload.version,
        payload.controllerId,
        String(payload.slots),
        payload.startId || "",
      ],
      {
        detached: true,
        stdio: ["ignore", output.fd, output.fd],
        env: {
          ...process.env,
          PATH:
            dirname(process.execPath) +
            ":" +
            (process.env.PATH || "/usr/bin:/bin"),
          OTTER_V2_REMOTE: "1",
        },
      },
    );
    child.on("error", () => {});
    child.unref();
    await output.close();
    for (let attempt = 0; attempt < 100; attempt++) {
      current = await connection(directory);
      if (current) break;
      await delay(100);
    }
    if (!current)
      throw new Error(
        "원격 실행부가 준비되지 않았습니다. Node/Git 환경과 개인 폴더의 worker.log를 확인해 주세요.",
      );
  }
  return {
    ...current,
    directory,
    health: { ...current.health, lifecycle: "running" },
  };
}
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ type: "fatal", message: "연결 프로토콜 오류" });
    return;
  }
  if (!preparing) {
    preparing = true;
    void prepare(message)
      .then((value) => {
        ready = value;
        send({ type: "ready", health: value.health });
      })
      .catch((error) => {
        send({
          type: "fatal",
          message: error.message,
          safeToRelease: !startAttempted && !existingWorker,
        });
        lines.close();
        process.stdin.destroy();
      });
    return;
  }
  if (!ready) {
    send({
      id: message.id,
      status: 503,
      data: { error: "원격 실행부 준비 중입니다." },
    });
    return;
  }
  if (!ready.origin) {
    send({
      id: message.id,
      status: 409,
      data: { error: "실행부가 중단된 상태입니다. 먼저 시작해 주세요." },
    });
    return;
  }
  if (
    typeof message.id !== "string" ||
    !["GET", "POST"].includes(message.method) ||
    typeof message.path !== "string" ||
    !message.path.startsWith("/api/") ||
    message.path.includes("://")
  ) {
    send({
      id: message.id,
      status: 400,
      data: { error: "잘못된 요청입니다." },
    });
    return;
  }
  void (async () => {
    try {
      const response = await fetch(ready.origin + message.path, {
        method: message.method,
        headers: {
          Authorization: "Bearer " + ready.token,
          "Content-Type": "application/json",
          ...(message.method === "POST"
            ? { "Idempotency-Key": message.id }
            : {}),
        },
        ...(message.method === "POST"
          ? { body: JSON.stringify(message.data || {}) }
          : {}),
        signal: AbortSignal.timeout(45000),
      });
      const data = await response.json();
      if (
        message.method === "POST" &&
        message.path === "/api/shutdown" &&
        response.ok
      ) {
        let stopped = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            await lstat(join(ready.directory, "worker.lock"));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            stopped = true;
            break;
          }
          await delay(50);
        }
        if (!stopped) throw new Error("실행부 종료 확인 시간 초과");
        const marker = {
          ...ready.health,
          pid: ready.pid,
          lifecycle: "stopped",
          active: 0,
          stoppedAt: new Date().toISOString(),
        };
        const temporary = join(
          ready.directory,
          "stopped." + randomUUID() + ".json",
        );
        await writeFile(temporary, JSON.stringify(marker), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, join(ready.directory, "stopped.json"));
        data.stopped = true;
      }
      send({
        id: message.id,
        status: response.status,
        data,
      });
    } catch {
      send({
        id: message.id,
        status: 504,
        data: {
          error:
            "원격 요청의 결과를 확인하지 못했습니다. 자동으로 다시 실행하지 않습니다.",
        },
      });
    }
  })();
});
