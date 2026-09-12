import { createServer } from "node:http";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { readFile, open, mkdir, unlink, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, DomainError } from "./store.mjs";
import { Company } from "./company.mjs";
import { Runner } from "./runner.mjs";
import { browse } from "./git.mjs";
import { Environments } from "./remote.mjs";
import { Instructions } from "./instructions.mjs";
import { Ideas } from "./ideas.mjs";
import { Knowledge } from "./knowledge.mjs";
import { RequestJournal } from "./request-journal.mjs";
import { editorRequest, editorTarget } from "./editor.mjs";
import { ResultMerge } from "./merge.mjs";
import { ProjectPush } from "./push.mjs";
import { GitRecovery } from "./git-recovery.mjs";
import { Automation } from "./automation.mjs";
import { Deployment } from "./deployment.mjs";
import { CodexReadiness } from "./readiness.mjs";
import { codexSettings, configuredCodex, saveCodexSettings } from "./codex.mjs";

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512000) throw new DomainError("요청이 너무 큽니다.", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new DomainError("JSON 요청이 올바르지 않습니다.");
  }
}
const equals = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function startServer({
  directory = join(homedir(), ".otter-v2"),
  port = 4318,
  webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url)),
  makeCodex,
  headless = false,
  workerVersion = "development",
  controllerId,
  slots,
  onShutdown,
  makeRemote,
  startId,
} = {}) {
  if (
    headless &&
    (!/^[a-f0-9-]{36}$/.test(controllerId || "") ||
      !Number.isInteger(slots) ||
      slots < 1 ||
      slots > 16)
  )
    throw new Error("원격 실행부의 소유권과 예약 실행 수가 필요합니다.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "worker.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "실행부 잠금이 있습니다. 다른 Otter 실행부와 Codex 작업이 종료되었는지 확인해 주세요: " +
          lockPath,
      );
    throw error;
  }
  let store, runner, readiness, deployment, automation, environments, server;
  let closing = false;
  const releaseLock = async () => {
    const owned = await lock.stat();
    const current = await lstat(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (current && (current.dev !== owned.dev || current.ino !== owned.ino))
      throw new Error(
        "실행부 잠금의 소유권이 변경되었습니다. 다른 잠금은 삭제하지 않습니다.",
      );
    if (current) await unlink(lockPath);
    await lock.close();
  };
  const cleanup = async () => {
    // 프로세스 종료를 확인하지 못하면 DB와 잠금을 그대로 유지한다.
    await runner?.close();
    store?.close();
    await releaseLock();
  };
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const token = randomBytes(32).toString("hex");
    store = new Store(join(directory, "otter.db"));
    const workerId = store.metadata("workerId") || randomUUID();
    if (headless) {
      const owner = store.metadata("controllerId");
      if (owner && owner !== controllerId) {
        throw new Error("다른 Otter 앱에 연결된 실행부입니다.");
      }
      store.metadata("controllerId", controllerId);
      store.settings({ concurrency: slots });
    }
    store.metadata("workerId", workerId);
    const company = new Company(store);
    const instructions = new Instructions(store);
    const createCodex = (options) => configuredCodex(store, options, makeCodex);
    runner = new Runner(store, directory, createCodex);
    readiness = new CodexReadiness(directory, createCodex);
    deployment = new Deployment(store, runner);
    automation = new Automation(store, runner, directory, deployment);
    runner.onIdle = () => automation.pump();
    const ideas = new Ideas(company, runner, directory);
    const knowledge = new Knowledge(store);
    environments = headless
      ? null
      : new Environments(store, company, runner, { makeRemote });
    const journal = environments
      ? new RequestJournal(store, environments)
      : null;
    let origin;
    let closePromise;
    const pendingRequests = new Map();
    const allowedDuringShutdown = (request) =>
      (request.method === "GET" && request.url === "/api/health") ||
      (headless &&
        onShutdown &&
        !closePromise &&
        request.method === "POST" &&
        request.url === "/api/shutdown");
    const handleRequest = async (request, response) => {
      let receiptId;
      let readOnlyPreview = false;
      const send = (status, value) => {
        if (receiptId)
          store.transaction(() => {
            store.completeReceipt(receiptId, status, value);
            if (journal)
              journal.completeLocal(receiptId, { status, data: value });
          });
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify(value));
        if (request.method === "POST" && status < 300 && !readOnlyPreview)
          queueMicrotask(() => automation.pump());
      };
      try {
        if (request.headers.host !== new URL(origin).host)
          throw new DomainError("허용되지 않은 호스트입니다.", 403);
        if (request.headers.origin && request.headers.origin !== origin)
          throw new DomainError(
            "다른 웹사이트의 요청은 허용하지 않습니다.",
            403,
          );
        if (request.headers["sec-fetch-site"] === "cross-site")
          throw new DomainError(
            "다른 웹사이트의 요청은 허용하지 않습니다.",
            403,
          );
        const url = new URL(request.url, origin);
        const path = url.pathname;
        readOnlyPreview =
          request.method === "POST" &&
          (path === "/api/codex-check" ||
            /^\/api\/projects\/[^/]+\/(automation|deployment)-preview$/.test(
              path,
            ));
        if (!path.startsWith("/api/")) {
          if (headless)
            throw new DomainError(
              "원격 실행부는 인증된 API로만 접근할 수 있습니다.",
              401,
            );
          if (request.method !== "GET")
            throw new DomainError("허용되지 않은 요청입니다.", 405);
          const file = resolve(
            webRoot,
            "." + decodeURIComponent(path === "/" ? "/index.html" : path),
          );
          if (!file.startsWith(resolve(webRoot) + sep))
            throw new DomainError("잘못된 경로입니다.", 403);
          const data = await readFile(file);
          response.writeHead(200, {
            "Content-Type":
              {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript",
                ".css": "text/css",
                ".svg": "image/svg+xml",
                ".png": "image/png",
              }[extname(file)] || "application/octet-stream",
            "Set-Cookie": `otter_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            "X-Content-Type-Options": "nosniff",
          });
          response.end(data);
          return;
        }
        const cookie = request.headers.cookie
          ?.split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("otter_session="))
          ?.slice(14);
        if (
          !(!headless && equals(cookie, token)) &&
          !equals(request.headers.authorization, "Bearer " + token)
        )
          throw new DomainError("앱을 다시 열어 연결해 주세요.", 401);
        if (request.method === "GET") {
          if (path === "/api/editor" && environments)
            return send(
              200,
              await editorRequest(
                { store, runner, environments },
                {
                  projectId: url.searchParams.get("projectId"),
                  taskId: url.searchParams.get("taskId"),
                  environmentId: request.headers["x-otter-environment"],
                  sshHost: url.searchParams.get("sshHost"),
                },
              ),
            );
          if (journal && path === "/api/request-journal")
            return send(200, journal.list());
          const receipt = path.match(
            /^\/api\/requests\/([a-zA-Z0-9_-]{8,128})$/,
          );
          if (path === "/api/health")
            return send(200, {
              protocol: 1,
              startId,
              workerId,
              workerVersion,
              controllerId: store.metadata("controllerId"),
              platform: process.platform,
              active: runner.active.size,
              stopping: closing,
              settings: store.settings(),
            });
          const assignment = path.match(/^\/api\/assignments\/([^/]+)$/);
          if (assignment)
            return send(200, store.get("assignments", assignment[1]));
          if (path === "/api/environments" && environments)
            return send(200, environments.list());
          const environment = request.headers["x-otter-environment"];
          if (
            environments &&
            environment &&
            environment !== "local" &&
            path !== "/api/state"
          ) {
            const result = await environments.forward(
              environment,
              "GET",
              url.pathname + url.search,
            );
            return send(result.status, result.data);
          }
          if (receipt) return send(200, store.requestResult(receipt[1]));
          if (path === "/api/codex-settings")
            return send(200, codexSettings(store));
          if (path === "/api/state")
            return send(
              200,
              environments
                ? await environments.snapshot(
                    url.searchParams.get("projectId") || undefined,
                  )
                : company.snapshot(
                    url.searchParams.get("projectId") || undefined,
                  ),
            );
          if (path === "/api/folders")
            return send(
              200,
              await browse(url.searchParams.get("path") || homedir()),
            );
          if (path === "/api/events") {
            const after = Number(url.searchParams.get("after") || 0);
            if (!Number.isSafeInteger(after) || after < 0)
              throw new DomainError("이벤트 위치가 잘못되었습니다.");
            return send(200, store.events(after));
          }
          const gitRecovery = path.match(
            /^\/api\/(tasks|projects)\/([^/]+)\/(merge|push)-recovery$/,
          );
          if (
            gitRecovery &&
            (gitRecovery[1] === "tasks") === (gitRecovery[3] === "merge")
          )
            return send(
              200,
              await new GitRecovery(store, runner).observe(
                gitRecovery[3],
                gitRecovery[2],
              ),
            );
          const automationPreview = path.match(
            /^\/api\/projects\/([^/]+)\/automation$/,
          );
          if (automationPreview)
            return send(
              200,
              await automation.preview(
                automationPreview[1],
                Object.fromEntries(url.searchParams),
              ),
            );
          const push = path.match(/^\/api\/projects\/([^/]+)\/push$/);
          if (push) {
            const service = new ProjectPush(store, runner);
            return send(
              200,
              url.searchParams.has("remote")
                ? await service.preview(push[1], {
                    remote: url.searchParams.get("remote"),
                    branch: url.searchParams.get("branch"),
                  })
                : await service.options(push[1]),
            );
          }
          const diff = path.match(/^\/api\/tasks\/([^/]+)\/diff$/);
          const merge = path.match(/^\/api\/tasks\/([^/]+)\/merge$/);
          if (merge)
            return send(
              200,
              await new ResultMerge(store, runner, directory).preview(merge[1]),
            );
          const editor = path.match(/^\/api\/projects\/([^/]+)\/editor$/);
          if (editor)
            return send(
              200,
              await editorTarget(
                store,
                runner,
                editor[1],
                url.searchParams.get("taskId") || undefined,
              ),
            );
          const file = path.match(/^\/api\/documents\/([^/]+)\/file$/);
          if (file)
            return send(
              200,
              await instructions.preview(
                file[1],
                url.searchParams.get("name") || "AGENTS.md",
              ),
            );
          if (diff) return send(200, await runner.diff(diff[1]));
        }
        if (request.method === "POST") {
          const input = await body(request);
          if (closing && !allowedDuringShutdown(request))
            throw new DomainError(
              "실행부를 종료하는 중입니다. 새 요청은 접수하지 않았습니다.",
              503,
            );
          const recovery = path.match(
            /^\/api\/request-journal\/([a-zA-Z0-9_-]{8,128})\/(check|retry|ack)$/,
          );
          if (journal && recovery) {
            const [, id, operation] = recovery;
            return send(
              200,
              operation === "check"
                ? await journal.check(id)
                : operation === "retry"
                  ? await journal.retry(id, input)
                  : journal.acknowledge(id),
            );
          }
          const key = request.headers["idempotency-key"];
          if (/^\/api\/tasks\/[^/]+\/steer$/.test(path) && !key)
            throw new DomainError(
              "추가 지시에는 중복 방지를 위한 요청 ID가 필요합니다.",
            );
          if (
            key &&
            (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
          )
            throw new DomainError("요청 ID 형식이 올바르지 않습니다.");
          const environment = request.headers["x-otter-environment"];
          if (
            environments &&
            environment &&
            environment !== "local" &&
            !/^\/api\/(companies|employees|settings|environments|knowledge)(\/|$)/.test(
              path,
            )
          ) {
            if (readOnlyPreview) {
              const result = await environments.forward(
                environment,
                "POST",
                path,
                input,
                key,
              );
              return send(result.status, result.data);
            }
            if (!key)
              throw new DomainError("원격 변경 요청에는 요청 ID가 필요합니다.");
            const result = await journal.submit(environment, path, input, key);
            response.setHeader("X-Otter-Receipt", key);
            return send(result.status, result.data);
          }
          if (headless && !key && !readOnlyPreview)
            throw new DomainError("원격 변경 요청에는 요청 ID가 필요합니다.");
          if (
            key &&
            !readOnlyPreview &&
            !/^\/api\/environments\/[^/]+\/(connect|disconnect|stop|edit)$/.test(
              path,
            )
          ) {
            if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
              throw new DomainError("요청 ID 형식이 올바르지 않습니다.");
            const previous = journal
              ? journal.beginLocal(path, input, key)
              : store.receipt(
                  key,
                  createHash("sha256")
                    .update(path + "\n" + JSON.stringify(input))
                    .digest("hex"),
                );
            receiptId = key;
            if (journal) response.setHeader("X-Otter-Receipt", key);
            if (previous) return send(previous.status, previous.data);
          }
          if (path === "/api/codex-check")
            return send(200, await readiness.check());
          if (path === "/api/codex-settings")
            return send(
              200,
              await saveCodexSettings(
                store,
                input,
                () =>
                  runner.active.size > 0 ||
                  !!readiness.pending ||
                  !!readiness.client,
              ),
            );
          if (path === "/api/shutdown" && headless && onShutdown) {
            send(200, { stopping: true });
            setImmediate(onShutdown);
            return;
          }
          if (path === "/api/library/import" && headless)
            return send(200, company.importSettings(input, true));
          if (path === "/api/library/knowledge" && headless)
            return send(200, knowledge.importApproved(input));
          if (path === "/api/environments" && environments)
            return send(201, environments.add(input));
          const connection = path.match(
            /^\/api\/environments\/([^/]+)\/(connect|disconnect|stop|edit)$/,
          );
          if (connection && environments)
            return send(
              200,
              connection[2] === "connect"
                ? await environments.connect(connection[1])
                : connection[2] === "stop"
                  ? await environments.stop(connection[1])
                  : connection[2] === "edit"
                    ? environments.edit(connection[1], input)
                    : environments.disconnect(connection[1]),
            );
          if (path === "/api/companies")
            return send(201, company.createCompany(input));
          const automationPreview = path.match(
            /^\/api\/projects\/([^/]+)\/automation-preview$/,
          );
          if (automationPreview)
            return send(
              200,
              await automation.preview(automationPreview[1], input),
            );
          const deploy = path.match(
            /^\/api\/projects\/([^/]+)\/(deployment-preview|deploy|deployment-acknowledge)$/,
          );
          if (deploy)
            return send(
              200,
              deploy[2] === "deployment-preview"
                ? await deployment.preview(deploy[1], input)
                : deploy[2] === "deploy"
                  ? await deployment.start(deploy[1], input)
                  : deployment.acknowledge(deploy[1], input),
            );
          const automationSetting = path.match(
            /^\/api\/projects\/([^/]+)\/automation$/,
          );
          if (automationSetting)
            return send(
              200,
              await automation.configure(automationSetting[1], input),
            );
          const fileSync = path.match(
            /^\/api\/documents\/([^/]+)\/file-(import|export)$/,
          );
          if (fileSync)
            return send(
              200,
              await instructions.sync(fileSync[1], input, fileSync[2]),
            );
          const activation = path.match(/^\/api\/projects\/([^/]+)\/activate$/);
          const sharing = path.match(
            /^\/api\/projects\/([^/]+)\/knowledge-(publish|apply)$/,
          );
          if (sharing)
            return send(
              200,
              sharing[2] === "publish"
                ? knowledge.publish(sharing[1], input)
                : knowledge.apply(sharing[1], input),
            );
          const withdraw = path.match(/^\/api\/knowledge\/([^/]+)\/withdraw$/);
          if (withdraw)
            return send(200, knowledge.withdraw(withdraw[1], input));
          if (activation)
            return send(200, await ideas.activate(activation[1], input));
          if (["/api/projects", "/api/projects/idea"].includes(path)) {
            const operation = async () => ({
              status: 201,
              data:
                path === "/api/projects/idea"
                  ? await ideas.create(input)
                  : await company.addProject(input),
            });
            const result = environments
              ? await environments.projectOperation(
                  path,
                  input,
                  "local",
                  key || randomUUID(),
                  operation,
                )
              : await operation();
            return send(result.status, result.data);
          }
          if (path === "/api/employees")
            return send(201, company.createEmployee(input));
          if (path === "/api/assignments")
            return send(201, company.assign(input.projectId, input.employeeId));
          if (path === "/api/tasks") {
            const task = company.requestTask(input);
            runner.pump();
            return send(201, task);
          }
          if (path === "/api/settings") {
            if (
              environments &&
              input.concurrency !== undefined &&
              input.concurrency < environments.reserved() + runner.active.size
            )
              throw new DomainError(
                "원격 예약 수와 현재 실행 중인 로컬 업무보다 한도를 낮출 수 없습니다.",
              );
            const settings = store.settings(input);
            runner.pump();
            return send(200, settings);
          }
          const gitRecovery = path.match(
            /^\/api\/(tasks|projects)\/([^/]+)\/(merge|push)-recovery$/,
          );
          if (
            gitRecovery &&
            (gitRecovery[1] === "tasks") === (gitRecovery[3] === "merge")
          )
            return send(
              200,
              await new GitRecovery(store, runner).resolve(
                gitRecovery[3],
                gitRecovery[2],
                input,
              ),
            );
          const push = path.match(/^\/api\/projects\/([^/]+)\/push$/);
          if (push)
            return send(
              200,
              await new ProjectPush(store, runner).apply(push[1], input),
            );
          const merge = path.match(/^\/api\/tasks\/([^/]+)\/merge$/);
          if (merge)
            return send(
              200,
              await new ResultMerge(store, runner, directory).apply(
                merge[1],
                input,
              ),
            );
          const action = path.match(
            /^\/api\/(projects|employees|assignments|documents|tasks|approvals)\/([^/]+)\/(archive|restore|edit|refresh|cancel|accept|resolve|continue|completion|steer)$/,
          );
          if (action) {
            const [, table, id, verb] = action;
            if (table === "projects" && verb === "completion")
              return send(200, company.configureCompletion(id, input));
            if (table === "projects" && verb === "archive")
              return send(200, company.archiveProject(id));
            if (table === "projects" && verb === "restore") {
              const operation = async () => ({
                status: 200,
                data: company.restoreProject(id),
              });
              const result = environments
                ? await environments.projectOperation(
                    path,
                    input,
                    "local",
                    key || randomUUID(),
                    operation,
                  )
                : await operation();
              return send(result.status, result.data);
            }
            if (table === "employees" && verb === "edit")
              return send(200, company.editEmployee(id, input));
            if (table === "employees" && verb === "refresh")
              return send(
                200,
                company.refreshEmployee(
                  id,
                  input.fields,
                  input.revision,
                  input.sourceRevision,
                ),
              );
            if (table === "assignments" && verb === "edit")
              return send(200, company.editAssignment(id, input));
            if (table === "assignments" && verb === "refresh")
              return send(
                200,
                company.refreshAssignment(
                  id,
                  input.fields,
                  input.revision,
                  input.sourceRevision,
                ),
              );
            if (table === "documents" && verb === "edit")
              return send(200, company.editDocument(id, input));
            if (table === "tasks" && verb === "steer")
              return send(200, await runner.steer(id, input));
            if (table === "tasks" && verb === "cancel") {
              await runner.cancel(id);
              return send(200, {});
            }
            if (table === "tasks" && verb === "accept")
              return send(200, runner.accept(id, input));
            if (table === "tasks" && verb === "continue") {
              if (runner.active.has(id))
                throw new DomainError(
                  "기존 실행의 종료가 확인될 때까지 기다려 주세요.",
                  409,
                );
              const task = company.continueTask(id, input);
              runner.pump();
              return send(200, task);
            }
            if (table === "approvals" && verb === "resolve") {
              const result = runner.approve(id, input);
              return send(
                200,
                result?.knowledgeId
                  ? { knowledge: store.get("knowledge", result.knowledgeId) }
                  : {},
              );
            }
          }
        }
        throw new DomainError("요청 경로를 찾을 수 없습니다.", 404);
      } catch (error) {
        send(error.status || (error.code === "ENOENT" ? 404 : 500), {
          ...(error.pending ? { pending: true } : {}),
          error:
            error instanceof DomainError
              ? error.message
              : error.code === "ENOENT"
                ? "파일 또는 폴더를 찾을 수 없습니다."
                : "요청을 처리하지 못했습니다. 실행 환경과 입력을 확인해 주세요.",
        });
      }
    };
    server = createServer((request, response) => {
      if (closing && !allowedDuringShutdown(request)) {
        response.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        response.end(
          JSON.stringify({
            error: "실행부를 종료하는 중입니다. 새 요청은 접수하지 않았습니다.",
          }),
        );
        request.resume();
        return;
      }
      // 소켓 단절은 Git/원격 요청의 완료가 아니다. 기록 저장까지 기다린다.
      const pending = handleRequest(request, response)
        .catch(() => response.destroy())
        .finally(() => pendingRequests.delete(request));
      pendingRequests.set(request, pending);
    });
    await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(port, "127.0.0.1", res);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    runner.pump();
    return {
      origin,
      token,
      store,
      runner,
      environments,
      automation,
      deployment,
      close: () => {
        if (closePromise) return closePromise;
        closing = true;
        runner.stopping = true;
        // 아직 본문을 다 보내지 않은 요청은 실행 전에 끊는다.
        for (const request of pendingRequests.keys())
          if (!request.complete) request.destroy();
        closePromise = (async () => {
          await Promise.all([...pendingRequests.values()]);
          await readiness.close();
          await automation.close();
          await deployment.close();
          await environments?.close();
          await runner.close();
          await new Promise((res) => server.close(res));
          await cleanup();
        })().catch((error) => {
          // 종료 실패 시 DB/잠금과 새 요청 차단을 유지하며 종료 재확인을 허용한다.
          closePromise = undefined;
          throw error;
        });
        return closePromise;
      },
    };
  } catch (error) {
    closing = true;
    if (runner) runner.stopping = true;
    await readiness?.close();
    await automation?.close();
    await deployment?.close();
    await environments?.close();
    if (server?.listening) await new Promise((res) => server.close(res));
    await cleanup();
    if (error.code === "ERR_SQLITE_ERROR" || error instanceof SyntaxError) {
      const failure = new DomainError(
        "작업 기록을 읽거나 초기화하지 못했습니다. 원본 데이터 폴더를 보존하고 디스크 여유 공간·접근 권한·백업을 확인해 주세요. 빈 DB로 대체하거나 손상된 기록을 자동 삭제하지 않았습니다.",
        500,
      );
      failure.code = "OTTER_DATA_UNAVAILABLE";
      throw failure;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startServer({
    directory: process.env.OTTER_V2_DATA,
    port: Number(process.env.OTTER_V2_PORT || 4318),
  }).catch((error) => {
    console.error(
      error instanceof DomainError
        ? error.message
        : error.code === "EADDRINUSE"
          ? "Otter 포트가 이미 사용 중입니다. 기존 실행부를 확인하거나 다른 개발 포트를 선택해 주세요."
          : "Otter를 시작하지 못했습니다. 기존 실행·데이터 폴더 권한·실행 설정을 확인해 주세요. 기존 잠금을 임의로 삭제하지 마세요.",
    );
    process.exitCode = 1;
    return null;
  });
  if (app) {
    console.log(`Otter v2: ${app.origin}`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try {
        await app.close();
      } catch {
        closing = false;
        console.error(
          "실행부 종료를 확인하지 못했습니다. 기록과 잠금을 유지합니다. 상태를 확인한 뒤 종료 신호를 다시 보내 주세요.",
        );
      }
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  }
}
