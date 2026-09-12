import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function required(value, label, max = 10000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new DomainError(`${label}: 1~${max}자로 입력해 주세요.`);
  return value.trim();
}
export function choice(value, values, label) {
  if (!values.includes(value))
    throw new DomainError(`${label} 값이 올바르지 않습니다.`);
  return value;
}

// 모든 회사의 설정은 재사용할 수 있지만, 프로젝트 기록은 프로젝트 ID로만 조회한다.
const tables = [
  "companies",
  "projects",
  "employees",
  "assignments",
  "documents",
  "tasks",
  "messages",
  "reports",
  "approvals",
  "environments",
  "knowledge",
];
export class Store {
  constructor(path = ":memory:") {
    this.documentLocks = new Set();
    this.projectLocks = new Set();
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='metadata'",
          )
          .get() &&
        this.db
          .prepare("SELECT 1 FROM metadata WHERE key='otter.recordBackup'")
          .get()
      ) {
        const error = new DomainError(
          "기록 백업 사본은 실행용 DB로 열 수 없습니다. 원본에 덮어쓰거나 대기 업무를 자동 실행하지 않습니다. 별도의 복원 절차가 필요합니다.",
        );
        error.code = "OTTER_RECORD_BACKUP";
        throw error;
      }
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), employee_id TEXT NOT NULL REFERENCES employees(id), data TEXT NOT NULL, UNIQUE(project_id,employee_id));
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_cache (environment_id TEXT NOT NULL, project_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(environment_id,project_id));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, status INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES(1,'{"concurrency":2,"retries":2}');`);
    } catch (error) {
      // 생성자 실패 시 호출자에게 Store가 반환되지 않으므로 여기서 연결을 닫는다.
      this.db.close();
      throw error;
    }
  }
  table(table) {
    if (!tables.includes(table)) throw new Error("Unknown table");
    return table;
  }
  hasUnconfirmedOperation(projectId) {
    const project = this.get("projects", projectId);
    return (
      ["running", "unconfirmed"].includes(project.deployment?.status) ||
      ["sending", "unconfirmed"].includes(project.push?.status) ||
      this.all("tasks", projectId).some((task) =>
        ["applying", "unconfirmed"].includes(task.merge?.status),
      )
    );
  }
  all(table, projectId) {
    this.table(table);
    const sql =
      `SELECT data FROM ${table}` +
      (projectId ? " WHERE project_id=?" : "") +
      " ORDER BY rowid";
    return this.db
      .prepare(sql)
      .all(...(projectId ? [projectId] : []))
      .map((row) => JSON.parse(row.data));
  }
  get(table, id) {
    const row = this.db
      .prepare(`SELECT data FROM ${this.table(table)} WHERE id=?`)
      .get(id);
    if (!row) throw new DomainError("항목을 찾을 수 없습니다.", 404);
    return JSON.parse(row.data);
  }
  insert(table, data) {
    this.table(table);
    const item = {
      ...data,
      id: randomUUID(),
      revision: 1,
      createdAt: new Date().toISOString(),
    };
    const columns = ["id", "data"];
    const values = [item.id, JSON.stringify(item)];
    if (table === "projects") {
      columns.push("company_id", "root");
      values.push(item.companyId, item.root);
    }
    if (
      [
        "assignments",
        "documents",
        "tasks",
        "messages",
        "reports",
        "approvals",
      ].includes(table)
    ) {
      columns.push("project_id");
      values.push(item.projectId);
    }
    if (table === "assignments") {
      columns.push("employee_id");
      values.push(item.employeeId);
    }
    this.db
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...values);
    this.event(
      item.projectId ?? (table === "projects" ? item.id : null),
      `${table}.created`,
      { id: item.id },
    );
    return item;
  }
  update(table, id, patch, revision) {
    const old = this.get(table, id);
    if (revision !== undefined && old.revision !== revision)
      throw new DomainError(
        "다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 확인해 주세요.",
        409,
      );
    const data = {
      ...old,
      ...patch,
      id: old.id,
      projectId: old.projectId,
      companyId: old.companyId,
      root: old.root,
      employeeId: old.employeeId,
      revision: old.revision + 1,
    };
    this.db
      .prepare(`UPDATE ${this.table(table)} SET data=? WHERE id=?`)
      .run(JSON.stringify(data), id);
    this.event(data.projectId ?? null, `${table}.updated`, { id });
    return data;
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  activateProject(id, repo, revision) {
    const old = this.get("projects", id);
    if (old.stage !== "idea" || old.revision !== revision)
      throw new DomainError(
        "아이디어 상태가 바뀌었습니다. 다시 확인해 주세요.",
        409,
      );
    const data = {
      ...old,
      ...repo,
      name: old.name,
      stage: "development",
      interviewRoot: old.root,
      revision: old.revision + 1,
    };
    this.db
      .prepare("UPDATE projects SET root=?,data=? WHERE id=?")
      .run(repo.root, JSON.stringify(data), id);
    this.event(id, "projects.activated", { id });
    return data;
  }
  event(projectId, kind, data) {
    this.db
      .prepare(
        "INSERT INTO events(project_id,kind,data,created_at) VALUES(?,?,?,?)",
      )
      .run(projectId, kind, JSON.stringify(data), new Date().toISOString());
  }
  events(after = 0) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500")
      .all(after)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }
  settings(patch) {
    const current = JSON.parse(
      this.db.prepare("SELECT data FROM settings WHERE id=1").get().data,
    );
    if (!patch) return current;
    for (const key of ["concurrency", "retries"])
      if (
        patch[key] !== undefined &&
        (!Number.isInteger(patch[key]) ||
          patch[key] < (key === "concurrency" ? 1 : 0) ||
          patch[key] > 16)
      )
        throw new DomainError("실행 한도는 정수 범위 안에서 지정해 주세요.");
    const result = {
      concurrency: patch.concurrency ?? current.concurrency,
      retries: patch.retries ?? current.retries,
    };
    this.db
      .prepare("UPDATE settings SET data=? WHERE id=1")
      .run(JSON.stringify(result));
    return result;
  }
  importSetting(table, item, { overwrite = false } = {}) {
    if (!["companies", "employees"].includes(table))
      throw new Error("Only reusable settings can be imported");
    const old = this.db
      .prepare(`SELECT data FROM ${table} WHERE id=?`)
      .get(item.id);
    if (old && !overwrite) return JSON.parse(old.data);
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(item.id, JSON.stringify(item));
    return item;
  }
  cache(environmentId, projectId = "", value) {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO remote_cache(environment_id,project_id,data) VALUES(?,?,?) ON CONFLICT(environment_id,project_id) DO UPDATE SET data=excluded.data WHERE data<>excluded.data",
        )
        .run(environmentId, projectId, JSON.stringify(value));
    const row = this.db
      .prepare(
        "SELECT data FROM remote_cache WHERE environment_id=? AND project_id=?",
      )
      .get(environmentId, projectId);
    return row ? JSON.parse(row.data) : null;
  }
  receipt(id, hash) {
    const row = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id);
    if (row) {
      if (row.hash !== hash)
        throw new DomainError("같은 요청 ID의 내용을 변경할 수 없습니다.", 409);
      if (row.status === null) {
        const error = new DomainError(
          "이 요청은 이미 접수되었습니다. 상태를 확인하기 전에는 다시 실행하지 않습니다.",
          409,
        );
        error.pending = true;
        throw error;
      }
      return { status: row.status, data: JSON.parse(row.data) };
    }
    this.db.prepare("INSERT INTO requests(id,hash) VALUES(?,?)").run(id, hash);
    return null;
  }
  requestResult(id) {
    const row = this.db
      .prepare("SELECT status,data FROM requests WHERE id=?")
      .get(id);
    if (!row) return { state: "missing" };
    if (row.status === null) return { state: "pending" };
    return {
      state: "completed",
      result: { status: row.status, data: JSON.parse(row.data) },
    };
  }
  completeReceipt(id, status, data) {
    this.db
      .prepare("UPDATE requests SET status=?,data=? WHERE id=?")
      .run(status, JSON.stringify(data), id);
  }
  metadata(key, value) {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, JSON.stringify(value));
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : undefined;
  }
  close() {
    if (this.db.isOpen) this.db.close();
  }
}
