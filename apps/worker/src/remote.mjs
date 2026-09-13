import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { DomainError, required } from "./store.mjs";
import { Knowledge } from "./knowledge.mjs";

const sourceDirectory = new URL("./", import.meta.url);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export function environmentInput(input) {
  for (const key of ["nodeExecutable", "directory", "username", "identityFile"])
    if (input[key] !== undefined && typeof input[key] !== "string")
      throw new DomainError("연결 설정은 문자열로 입력해 주세요.");
  const result = {
    name: required(input.name, "환경 이름", 80),
    kind: input.kind,
    slots: Number(input.slots ?? 1),
  };
  if (!["ssh", "wsl"].includes(result.kind))
    throw new DomainError("SSH 또는 WSL 환경을 선택해 주세요.");
  if (!Number.isInteger(result.slots) || result.slots < 1 || result.slots > 16)
    throw new DomainError("예약 실행 수는 1~16 사이 정수여야 합니다.");
  result.nodeExecutable = input.nodeExecutable?.trim() || "node";
  if (!/^(node|\/[^\r\n\0]+)$/.test(result.nodeExecutable))
    throw new DomainError(
      "Node 실행 파일은 node 또는 원격 절대 경로로 지정해 주세요.",
    );
  result.directory = input.directory?.trim() || "";
  if (
    result.directory &&
    (!result.directory.startsWith("/") || /[\r\n\0]/.test(result.directory))
  )
    throw new DomainError("실행부 전용 폴더의 원격 절대 경로가 필요합니다.");
  if (result.kind === "ssh") {
    result.host = required(input.host, "SSH 호스트", 253);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.:[\]_-]*$/.test(result.host))
      throw new DomainError("SSH 호스트 형식을 확인해 주세요.");
    result.username = input.username?.trim() || "";
    if (
      result.username &&
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(result.username)
    )
      throw new DomainError("SSH 사용자 이름 형식을 확인해 주세요.");
    result.port = Number(input.port || 22);
    if (
      !Number.isInteger(result.port) ||
      result.port < 1 ||
      result.port > 65535
    )
      throw new DomainError("SSH 포트는 1~65535 사이입니다.");
    result.identityFile = input.identityFile?.trim() || "";
    if (/[\r\n\0]/.test(result.identityFile))
      throw new DomainError("SSH 키 파일 경로를 확인해 주세요.");
  } else {
    result.distribution = required(input.distribution, "WSL 배포판", 120);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/.test(result.distribution))
      throw new DomainError("WSL 배포판 이름을 확인해 주세요.");
  }
  return result;
}

export function connectionCommand(
  environment,
  bootstrap,
  platform = process.platform,
) {
  const command = `${quote(environment.nodeExecutable)} --input-type=module -e ${quote(bootstrap)}`;
  if (environment.kind === "wsl") {
    if (platform !== "win32")
      throw new DomainError("WSL 연결은 Windows 앱에서 사용할 수 있습니다.");
    return [
      "wsl.exe",
      [
        "--distribution",
        environment.distribution,
        "--exec",
        "/bin/sh",
        "-lc",
        command,
      ],
    ];
  }
  return [
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-p",
      String(environment.port),
      ...(environment.username ? ["-l", environment.username] : []),
      ...(environment.identityFile ? ["-i", environment.identityFile] : []),
      "--",
      environment.host,
      command,
    ],
  ];
}

export async function workerBundle() {
  const files = {};
  for (const name of (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".mjs"))
    .sort())
    files[name] = await readFile(new URL(name, sourceDirectory), "utf8");
  return {
    files,
    version: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

// JSONL is carried by the user's authenticated SSH/WSL process; no remote TCP listener is exposed.
export class Remote {
  constructor(environment, { launch = spawn, timeout = 50000 } = {}) {
    this.environment = environment;
    this.launch = launch;
    this.timeout = timeout;
    this.pending = new Map();
  }
  async connect(controllerId, options = {}) {
    if (this.connecting) return this.connecting;
    if (this.health) return this.health;
    this.disconnected = false;
    this.connecting = this.start(controllerId, options).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  async start(controllerId, options) {
    const bundle = await workerBundle();
    if (this.disconnected) throw new DomainError("연결이 취소되었습니다.", 503);
    const bootstrap = bundle.files["remote-bootstrap.mjs"];
    const [command, args] = connectionCommand(this.environment, bootstrap);
    return new Promise((resolve, reject) => {
      let ready = false;
      const child = this.launch(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      const timer = setTimeout(
        () =>
          fail(
            "연결 준비 시간이 초과되었습니다. 원격 Node.js 24 설치와 SSH 접속을 확인해 주세요.",
          ),
        this.timeout,
      );
      const fail = (message, safeToRelease = false) => {
        if (this.child !== child) return;
        this.error = message;
        this.health = null;
        this.child = null;
        clearTimeout(timer);
        child.stdin.destroy();
        child.kill();
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new DomainError(message, 503));
        }
        this.pending.clear();
        if (!ready) {
          const error = new DomainError(message, 503);
          error.safeToRelease = safeToRelease;
          reject(error);
        }
      };
      this.fail = fail;
      child.on("error", () =>
        fail(
          "연결 명령을 실행하지 못했습니다. SSH/WSL 설치와 접속 설정을 확인해 주세요.",
        ),
      );
      child.on("exit", () =>
        fail(
          "원격 연결이 끊겼습니다. 실행 중인 업무는 중단하지 않았습니다. SSH 키·호스트 등록·Node 경로를 확인하고 다시 연결해 주세요.",
        ),
      );
      child.stdin.on("error", () =>
        fail(
          "원격 연결에 요청을 전달하지 못했습니다. 상태 확인 후 다시 연결해 주세요.",
        ),
      );
      // Do not send raw SSH stderr into persistent logs/UI: it may contain account or proxy details.
      child.stderr.resume();
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return fail(
            "원격 로그인 스크립트가 통신 출력을 변경했습니다. 비대화형 SSH의 표준출력을 확인해 주세요.",
          );
        }
        if (message.type === "fatal")
          return fail(
            String(message.message).slice(0, 1000),
            message.safeToRelease === true,
          );
        if (message.type === "ready") {
          if (
            ready ||
            message.health?.protocol !== 1 ||
            message.health.controllerId !== controllerId ||
            (options.mode !== "inspect" &&
              message.health.settings?.concurrency !== this.environment.slots)
          )
            return fail(
              "실행부 소유권·버전 또는 예약 실행 수가 일치하지 않습니다.",
            );
          ready = true;
          clearTimeout(timer);
          this.health = message.health;
          this.error = null;
          resolve(this.health);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (
          !Number.isInteger(message.status) ||
          message.status < 100 ||
          message.status > 599
        )
          return fail("원격 응답 형식이 올바르지 않습니다.");
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve({ status: message.status, data: message.data });
      });
      child.stdin.write(
        JSON.stringify({
          ...bundle,
          directory: this.environment.directory,
          slots: this.environment.slots,
          controllerId,
          ...options,
        }) + "\n",
      );
    });
  }
  request(method, path, data, id = randomUUID()) {
    if (!this.health || !this.child)
      return Promise.reject(
        new DomainError(this.error || "환경에 먼저 연결해 주세요.", 503),
      );
    if (this.pending.has(id)) {
      const error = new DomainError(
        "같은 요청의 응답을 기다리는 중입니다.",
        409,
      );
      error.pending = true;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DomainError(
            "원격 응답을 확인하지 못했습니다. 같은 요청 ID로 결과를 확인하기 전에는 새 업무를 보내지 마세요.",
            504,
          ),
        );
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, path, data }) + "\n");
    });
  }
  disconnect() {
    this.disconnected = true;
    this.fail?.("연결을 해제했습니다. 원격 실행부와 작업은 계속 유지됩니다.");
  }
}

export class Environments {
  constructor(
    store,
    company,
    runner,
    { makeRemote = (environment) => new Remote(environment) } = {},
  ) {
    this.store = store;
    this.company = company;
    this.runner = runner;
    this.makeRemote = makeRemote;
    this.clients = new Map();
    this.operations = new Map();
    this.controllerId = store.metadata("controllerId") || randomUUID();
    store.metadata("controllerId", this.controllerId);
    runner.capacity = () =>
      Math.max(0, store.settings().concurrency - this.reserved());
  }
  reserved() {
    return this.store
      .all("environments")
      .reduce(
        (sum, item) => sum + (item.allocated === false ? 0 : item.slots),
        0,
      );
  }
  list() {
    return this.store.all("environments").map((environment) => {
      const client = this.clients.get(environment.id);
      return {
        ...environment,
        allocated: environment.allocated !== false,
        connected:
          !!client?.health &&
          client.health.lifecycle !== "stopped" &&
          client.health.lifecycle !== "absent",
        busy: this.operations.has(environment.id),
        error:
          client?.error ||
          environment.lastError ||
          (!client?.health
            ? environment.allocated === false
              ? "실행부가 시작되지 않았거나 안전하게 중단되었습니다."
              : "연결되지 않았습니다. 다시 연결해 주세요."
            : null),
        lastSeen: this.store.cache(environment.id)?.observedAt || null,
      };
    });
  }
  add(input) {
    if (this.closing) throw new DomainError("실행부를 종료하는 중입니다.", 409);
    const config = environmentInput(input);
    const exists = this.store
      .all("environments")
      .some(
        (item) =>
          item.kind === config.kind &&
          item.host === config.host &&
          item.username === config.username &&
          item.port === config.port &&
          item.distribution === config.distribution &&
          item.directory === config.directory,
      );
    if (exists)
      throw new DomainError(
        "이미 등록된 환경입니다. 기존 환경에 다시 연결해 주세요.",
        409,
      );
    return this.store.insert("environments", { ...config, allocated: false });
  }
  async exclusive(id, operation) {
    if (this.operations.has(id))
      throw new DomainError(
        "이 환경의 변경을 처리하고 있습니다. 완료 후 다시 시도해 주세요.",
        409,
      );
    const pending = Promise.resolve().then(operation);
    this.operations.set(id, pending);
    try {
      return await pending;
    } finally {
      this.operations.delete(id);
    }
  }
  edit(id, input) {
    if (this.closing) throw new DomainError("실행부를 종료하는 중입니다.", 409);
    if (this.operations.has(id))
      throw new DomainError("연결 작업이 끝난 후 설정을 변경해 주세요.", 409);
    const old = this.store.get("environments", id);
    const config = environmentInput({ ...old, ...input });
    const changed = (key) => old[key] !== config[key];
    if (old.workerId && ["kind", "directory", "distribution"].some(changed))
      throw new DomainError(
        "기존 기록의 실행 위치는 바꾸지 않습니다. 다른 위치는 새 환경으로 등록해 주세요.",
      );
    if (old.allocated !== false && changed("slots"))
      throw new DomainError(
        "실행부를 안전하게 중단하고 예약을 반환한 뒤 실행 수를 변경해 주세요.",
      );
    if (
      old.allocated !== false &&
      !old.workerId &&
      ["kind", "directory", "host", "port", "username", "distribution"].some(
        changed,
      )
    )
      throw new DomainError(
        "시작 결과가 불확실합니다. 기존 위치의 실행부 상태를 먼저 확인해 주세요.",
      );
    const result = this.store.update(
      "environments",
      id,
      { ...config, lastError: null },
      input.revision,
    );
    this.clients.get(id)?.disconnect();
    this.clients.delete(id);
    return result;
  }
  client(id) {
    this.store.get("environments", id);
    const client = this.clients.get(id);
    if (!client?.health)
      throw new DomainError(
        client?.error || "선택한 환경에 먼저 연결해 주세요.",
        503,
      );
    return client;
  }
  async connect(id) {
    if (this.closing) throw new DomainError("실행부를 종료하는 중입니다.", 409);
    return this.exclusive(id, () => this.startEnvironment(id)).catch(
      (error) => {
        if (error.status !== 409)
          this.store.update("environments", id, { lastError: error.message });
        throw error;
      },
    );
  }
  async inspect(environment) {
    const probe = this.makeRemote(environment);
    try {
      const health = await probe.connect(this.controllerId, {
        mode: "inspect",
        expectedWorkerId: environment.workerId,
        expectedStartId: environment.startId,
      });
      return { probe, health };
    } catch (error) {
      probe.disconnect();
      throw error;
    }
  }
  async startEnvironment(id) {
    const environment = this.store.get("environments", id);
    const { probe, health: before } = await this.inspect(environment);
    probe.disconnect();
    if (
      before.workerId &&
      this.store
        .all("environments")
        .some((item) => item.id !== id && item.workerId === before.workerId)
    )
      throw new DomainError("같은 실행부가 이미 등록되어 있습니다.", 409);
    const additional = environment.allocated === false ? environment.slots : 0;
    if (
      this.reserved() + additional + this.runner.active.size >
      this.store.settings().concurrency
    )
      throw new DomainError(
        "실행할 자리가 부족합니다. 로컬 업무 완료를 기다리거나 전체 한도를 늘려 주세요.",
      );
    if (
      before.lifecycle === "running" &&
      before.settings.concurrency !== environment.slots
    )
      throw new DomainError(
        "실행 중인 환경의 한도가 다릅니다. 먼저 안전하게 중단해 주세요.",
      );
    const startId =
      before.lifecycle === "running" ? before.startId : randomUUID();
    this.store.update("environments", id, {
      allocated: true,
      startId,
      workerId: before.workerId || environment.workerId,
      lastError: null,
    });
    this.clients.get(id)?.disconnect();
    const client = this.makeRemote(environment);
    this.clients.set(id, client);
    let health;
    try {
      health = await client.connect(this.controllerId, {
        expectedWorkerId: before.workerId || environment.workerId,
        expectedStartId: before.startId || environment.startId,
        startId,
      });
    } catch (error) {
      this.store.update("environments", id, {
        lastError: error.message,
        ...(before.lifecycle !== "running" && error.safeToRelease
          ? { allocated: false, startId: before.startId }
          : {}),
      });
      throw error;
    }
    const duplicate = this.store
      .all("environments")
      .some((item) => item.id !== id && item.workerId === health.workerId);
    if (duplicate) {
      client.disconnect();
      throw new DomainError(
        "같은 실행부가 다른 환경으로 이미 등록되어 있습니다.",
        409,
      );
    }
    if (environment.workerId && environment.workerId !== health.workerId) {
      client.disconnect();
      throw new DomainError(
        "등록된 실행부와 다른 데이터 폴더입니다. 기존 환경을 자동 교체하지 않습니다.",
        409,
      );
    }
    this.store.update("environments", id, {
      workerId: health.workerId,
      startId: health.startId,
      lastError: null,
    });
    await this.refresh(id);
    return this.list().find((item) => item.id === id);
  }
  disconnect(id) {
    if (this.operations.has(id))
      throw new DomainError("연결 작업이 끝난 뒤 연결을 해제해 주세요.", 409);
    this.store.get("environments", id);
    this.clients.get(id)?.disconnect();
    return { disconnected: true, reservedSlots: this.reserved() };
  }
  async stop(id) {
    return this.exclusive(id, async () => {
      const environment = this.store.get("environments", id);
      if (environment.allocated === false)
        return this.list().find((item) => item.id === id);
      const { probe, health } = await this.inspect(environment);
      try {
        if (health.lifecycle === "running") {
          const result = await probe.request("POST", "/api/shutdown", {});
          if (result.status !== 200 || !result.data.stopped)
            throw new DomainError(
              result.data.error ||
                "실행부 종료가 확인되지 않았습니다. 예약은 유지합니다.",
              503,
            );
        } else if (health.lifecycle !== "stopped")
          throw new DomainError(
            "원격 실행부의 종료 기록을 확인하지 못했습니다. 예약은 유지합니다.",
            503,
          );
        this.clients.get(id)?.disconnect();
        this.clients.delete(id);
        const result = this.store.update("environments", id, {
          allocated: false,
          lastError: null,
          workerId: health.workerId || environment.workerId,
          startId: health.startId || environment.startId,
        });
        this.runner.pump();
        return result;
      } finally {
        probe.disconnect();
      }
    });
  }
  async refresh(id, projectId = "") {
    const response = await this.client(id).request(
      "GET",
      "/api/state" +
        (projectId ? "?projectId=" + encodeURIComponent(projectId) : ""),
    );
    if (response.status !== 200)
      throw new DomainError(
        response.data.error || "원격 상태를 읽지 못했습니다.",
        response.status,
      );
    const snapshot = { ...response.data, observedAt: new Date().toISOString() };
    for (const item of snapshot.companies)
      this.company.importSettings({ company: item });
    for (const item of snapshot.employees)
      this.company.importSettings({ employee: item });
    const knowledge = new Knowledge(this.store);
    snapshot.knowledge = (snapshot.knowledge || []).map((item) =>
      knowledge.importApproved(item),
    );
    this.store.cache(id, projectId, snapshot);
    if (projectId)
      this.store.cache(id, "", {
        companies: snapshot.companies,
        employees: snapshot.employees,
        knowledge: snapshot.knowledge,
        projects: snapshot.projects,
        settings: snapshot.settings,
        observedAt: snapshot.observedAt,
      });
    return snapshot;
  }
  projects() {
    return [
      ...this.store.all("projects").map((item) => ({
        ...item,
        environmentId: "local",
        environmentLabel: "로컬",
        environment: "local",
      })),
      ...this.store.all("environments").flatMap((environment) =>
        (this.store.cache(environment.id)?.projects || []).map((item) => ({
          ...item,
          environmentId: environment.id,
          environmentLabel: environment.name,
          environment: environment.kind,
        })),
      ),
    ];
  }
  async snapshot(projectId) {
    const target =
      projectId && this.projects().find((item) => item.id === projectId);
    let scoped;
    let connectionError;
    if (target && target.environmentId !== "local") {
      try {
        scoped = await this.refresh(target.environmentId, projectId);
      } catch (error) {
        connectionError = error.message;
        scoped = this.store.cache(target.environmentId, projectId) || {};
      }
    } else scoped = this.company.snapshot(projectId);
    return {
      ...scoped,
      companies: this.store.all("companies"),
      employees: this.store.all("employees"),
      knowledge: this.store.all("knowledge"),
      projects: this.projects(),
      settings: this.store.settings(),
      environments: this.list(),
      localSlots: Math.max(
        0,
        this.store.settings().concurrency - this.reserved(),
      ),
      connectionError,
    };
  }
  async forward(id, method, path, input, key) {
    if (this.closing) throw new DomainError("실행부를 종료하는 중입니다.", 409);
    if (this.operations.has(id))
      throw new DomainError(
        "실행 환경을 변경하는 중입니다. 완료 후 다시 시도해 주세요.",
        409,
      );
    const client = this.client(id);
    const route = path.split("?")[0];
    if (
      !/^\/api\/(state|folders|events|assignments|projects|tasks|documents|approvals)(\/|$)/.test(
        route,
      ) &&
      !(
        method === "GET" &&
        /^\/api\/requests\/[a-zA-Z0-9_-]{8,128}$/.test(route)
      ) &&
      !(method === "POST" && route === "/api/codex-check") &&
      !(method === "GET" && route === "/api/codex-models") &&
      !(["GET", "POST"].includes(method) && route === "/api/codex-settings")
    )
      throw new DomainError("원격 전달이 허용되지 않은 경로입니다.", 403);
    if (method === "POST") {
      if (
        route === "/api/tasks" ||
        /^\/api\/tasks\/[^/]+\/continue$/.test(route)
      ) {
        const policy = await client.request("POST", "/api/settings", {
          retries: this.store.settings().retries,
        });
        if (policy.status !== 200) return policy;
      }
      const applyKnowledge = route.match(
        /^\/api\/projects\/([^/]+)\/knowledge-apply$/,
      );
      if (applyKnowledge) {
        const project = this.projects().find(
          (p) => p.id === applyKnowledge[1] && p.environmentId === id,
        );
        if (!project)
          throw new DomainError(
            "공유 지식을 적용할 원격 프로젝트를 확인해 주세요.",
            404,
          );
        const selected = new Knowledge(this.store).select(
          project.companyId,
          input,
        );
        const imported = await client.request(
          "POST",
          "/api/library/knowledge",
          selected,
        );
        if (imported.status !== 200) return imported;
      }
      let settings;
      if (["/api/projects", "/api/projects/idea"].includes(route))
        settings = {
          company: this.store.get("companies", input.companyId),
          ...(route === "/api/projects/idea" && input.employeeId
            ? { employee: this.store.get("employees", input.employeeId) }
            : {}),
        };
      if (route === "/api/assignments")
        settings = { employee: this.store.get("employees", input.employeeId) };
      const refresh = route.match(/^\/api\/assignments\/([^/]+)\/refresh$/);
      if (refresh) {
        const assignment = await client.request(
          "GET",
          "/api/assignments/" + refresh[1],
        );
        if (assignment.status !== 200) return assignment;
        settings = {
          employee: this.store.get("employees", assignment.data.employeeId),
        };
      }
      if (settings) {
        const imported = await client.request(
          "POST",
          "/api/library/import",
          settings,
        );
        if (imported.status !== 200) return imported;
      }
    }
    const result = await client.request(method, path, input, key);
    if (["/api/codex-check", "/api/codex-settings"].includes(route))
      return result;
    if (method === "POST" && result.status < 300) {
      // Keep a confirmed publication even if the subsequent snapshot cannot be fetched.
      if (/^\/api\/projects\/[^/]+\/knowledge-publish$/.test(route))
        new Knowledge(this.store).importApproved(result.data);
      if (
        /^\/api\/approvals\/[^/]+\/resolve$/.test(route) &&
        result.data.knowledge
      )
        new Knowledge(this.store).importApproved(result.data.knowledge);
      // Preserve newly created projects even if the next snapshot request loses its response.
      if (
        ["/api/projects", "/api/projects/idea"].includes(route) ||
        /^\/api\/projects\/[^/]+\/(archive|restore|activate)$/.test(route)
      ) {
        const cache = this.store.cache(id) || { projects: [] };
        cache.projects = [
          ...cache.projects.filter((item) => item.id !== result.data.id),
          result.data,
        ];
        this.store.cache(id, "", cache);
      }
      await this.refresh(id).catch(() => {});
    }
    return result;
  }
  async projectOperation(path, input, environment, key, operation) {
    const restore = path.match(/^\/api\/projects\/([^/]+)\/restore$/);
    if (!["/api/projects", "/api/projects/idea"].includes(path) && !restore)
      return operation();
    const hash = createHash("sha256")
      .update(environment + "\n" + path + "\n" + JSON.stringify(input))
      .digest("hex");
    const resultKey = "projectResult:" + key;
    const previous = this.store.metadata(resultKey);
    if (previous) {
      if (previous.hash !== hash)
        throw new DomainError("같은 요청 ID의 내용을 변경할 수 없습니다.", 409);
      return previous.result;
    }
    const project = restore
      ? this.projects().find((item) => item.id === restore[1])
      : null;
    const company = this.store.get(
      "companies",
      required(restore ? project?.companyId : input.companyId, "회사"),
    );
    if (company.mode !== "single") return operation();
    const claimKey = "projectClaim:" + company.id;
    const claim = this.store.metadata(claimKey);
    if (claim && claim.key !== key)
      throw new DomainError(
        "이 회사의 프로젝트 변경 결과를 확인하는 중입니다. 기존 요청 결과를 먼저 확인해 주세요.",
        409,
      );
    if (
      !claim &&
      this.projects().some(
        (item) =>
          item.companyId === company.id &&
          !item.archived &&
          item.id !== project?.id,
      )
    )
      throw new DomainError(
        "이 회사에는 다른 실행 환경을 포함해 이미 프로젝트가 있습니다.",
        409,
      );
    if (claim && claim.hash !== hash)
      throw new DomainError("처리 중인 요청의 내용을 변경할 수 없습니다.", 409);
    this.store.metadata(claimKey, { key, environment, hash });
    try {
      const result = await operation();
      if (
        result.status < 500 &&
        !(result.status === 409 && result.data?.pending)
      ) {
        this.store.metadata(claimKey, null);
        if (result.status < 300)
          this.store.metadata(resultKey, { hash, result });
      }
      return result;
    } catch (error) {
      if (error.status && error.status < 500 && !error.pending)
        this.store.metadata(claimKey, null);
      throw error;
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()]);
    try {
      // WSL is part of the local PC: full app quit must stop its worker, SSH jobs stay alive.
      for (const environment of this.store
        .all("environments")
        .filter((item) => item.kind === "wsl" && item.allocated !== false)) {
        await this.stop(environment.id);
      }
      for (const client of this.clients.values()) client.disconnect();
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }
}
