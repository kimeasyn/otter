import { createHash } from "node:crypto";
import { DomainError } from "./store.mjs";

// 브라우저 원본/포트와 무관한 접수 기록. 실제 업무 기록/승인은 대상 실행부가 소유한다.
export class RequestJournal {
  constructor(store, environments) {
    this.store = store;
    this.environments = environments;
    this.inflight = new Set();
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS request_journal(id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL)",
    );
  }
  get(id) {
    const row = this.store.db
      .prepare("SELECT data FROM request_journal WHERE id=?")
      .get(id);
    if (!row) throw new DomainError("요청 기록을 찾을 수 없습니다.", 404);
    return JSON.parse(row.data);
  }
  save(record) {
    const current = this.get(record.id);
    if (current.status === "acknowledged" && record.status !== "acknowledged")
      return current;
    if (current.status === "confirmed" && record.status === "pending")
      return current;
    this.store.db
      .prepare("UPDATE request_journal SET data=? WHERE id=?")
      .run(JSON.stringify(record), record.id);
    return record;
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT data FROM request_journal WHERE json_extract(data,'$.status')!='acknowledged' ORDER BY rowid DESC",
      )
      .all()
      .map(({ data }) => {
        const { result, ...item } = JSON.parse(data);
        return {
          ...item,
          responseStatus: result?.status,
          responseError: result?.data?.error,
          resultId: result?.data?.id,
        };
      });
  }
  pending(message = "이 요청의 처리 결과를 먼저 확인해 주세요.") {
    const error = new DomainError(message, 409);
    error.pending = true;
    return error;
  }
  target(record) {
    const client = this.environments.client(record.environmentId);
    if (client.health?.workerId !== record.workerId)
      throw new DomainError(
        "원래 요청을 보낸 실행부와 다릅니다. 다른 실행부에 재전달하지 않습니다.",
        409,
      );
    return client;
  }
  reserve(environmentId, path, input, id) {
    const hash = createHash("sha256")
      .update(environmentId + "\n" + path + "\n" + JSON.stringify(input))
      .digest("hex");
    const old = this.store.db
      .prepare("SELECT hash,data FROM request_journal WHERE id=?")
      .get(id);
    if (old) {
      if (old.hash !== hash)
        throw new DomainError("같은 요청 ID의 내용을 변경할 수 없습니다.", 409);
      return { record: JSON.parse(old.data), created: false };
    }
    if (
      this.store.db
        .prepare(
          "SELECT id FROM request_journal WHERE hash=? AND json_extract(data,'$.status')!='acknowledged' LIMIT 1",
        )
        .get(hash)
    )
      throw this.pending(
        "같은 내용의 확인하지 않은 요청이 있습니다. 요청 복구에서 결과를 먼저 확인해 주세요.",
      );
    const environment =
      environmentId === "local"
        ? { name: "로컬", workerId: this.store.metadata("workerId") }
        : this.store.get("environments", environmentId);
    if (!environment.workerId)
      throw new DomainError("실행 환경에 먼저 연결해 주세요.", 503);
    const record = {
      id,
      environmentId,
      workerId: environment.workerId,
      environmentName: environment.name,
      path,
      input,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare("INSERT INTO request_journal(id,hash,data) VALUES(?,?,?)")
      .run(id, hash, JSON.stringify(record));
    return { record, created: true };
  }
  beginLocal(path, input, id) {
    return this.store.transaction(() => {
      const { record, created } = this.reserve("local", path, input, id);
      if (!created) {
        this.localTarget(record);
        const receipt = this.store.requestResult(id);
        if (receipt.state === "completed") return receipt.result;
        throw this.pending(
          "이미 접수한 로컬 요청입니다. 처리 결과를 확인하기 전에는 다시 실행하지 않습니다.",
        );
      }
      const hash = createHash("sha256")
        .update(path + "\n" + JSON.stringify(input))
        .digest("hex");
      return this.store.receipt(id, hash);
    });
  }
  localTarget(record) {
    if (record.workerId !== this.store.metadata("workerId"))
      throw new DomainError(
        "원래 로컬 실행부와 다릅니다. 요청을 다시 실행하지 않습니다.",
        409,
      );
  }
  completeLocal(id, result) {
    const record = this.get(id);
    return this.save({
      ...record,
      status: "confirmed",
      result,
      observedAt: new Date().toISOString(),
    });
  }
  async submit(environmentId, path, input, id) {
    const { record, created } = this.reserve(environmentId, path, input, id);
    if (created) return this.deliver(record);
    if (record.status === "confirmed") return record.result;
    if (record.status === "acknowledged") {
      const response = await this.target(record).request(
        "GET",
        `/api/requests/${id}`,
      );
      if (response.status === 200 && response.data.state === "completed")
        return response.data.result;
    }
    throw this.pending();
  }
  async deliver(record) {
    if (this.inflight.has(record.id))
      throw this.pending("기존 전달의 응답을 기다리고 있습니다.");
    this.target(record);
    this.inflight.add(record.id);
    try {
      const result = await this.environments.projectOperation(
        record.path,
        record.input,
        record.environmentId,
        record.id,
        () =>
          this.environments.forward(
            record.environmentId,
            "POST",
            record.path,
            record.input,
            record.id,
          ),
      );
      if (result.status < 500 && !result.data?.pending)
        this.save({
          ...record,
          status: "confirmed",
          result,
          observedAt: new Date().toISOString(),
        });
      return result;
    } catch (error) {
      if (error instanceof DomainError && error.status < 500 && !error.pending)
        this.save({
          ...record,
          status: "confirmed",
          result: { status: error.status, data: { error: error.message } },
          observedAt: new Date().toISOString(),
        });
      throw error;
    } finally {
      this.inflight.delete(record.id);
    }
  }
  async check(id) {
    const record = this.get(id);
    if (record.environmentId === "local") {
      this.localTarget(record);
      if (record.status !== "pending") return record;
      const receipt = this.store.requestResult(id);
      return receipt.state === "completed"
        ? this.completeLocal(id, receipt.result)
        : this.save({
            ...record,
            observation: receipt.state,
            observedAt: new Date().toISOString(),
          });
    }
    if (record.status !== "pending") return record;
    const response = await this.target(record).request(
      "GET",
      `/api/requests/${id}`,
    );
    if (response.status !== 200)
      throw new DomainError(
        "원격 요청 기록을 확인하지 못했습니다. 원격 실행부 버전과 연결을 확인해 주세요.",
        503,
      );
    const observation = response.data.state;
    if (!["missing", "pending", "completed"].includes(observation))
      throw new DomainError("원격 요청 기록 형식이 올바르지 않습니다.", 502);
    if (observation === "completed") {
      const result = response.data.result;
      if (!Number.isInteger(result?.status))
        throw new DomainError("원격 처리 결과를 확인하지 못했습니다.", 502);
      await this.environments.projectOperation(
        record.path,
        record.input,
        record.environmentId,
        record.id,
        async () => result,
      );
      await this.environments.refresh(record.environmentId).catch(() => {});
      return this.save({
        ...record,
        status: "confirmed",
        observation,
        result,
        observedAt: new Date().toISOString(),
      });
    }
    return this.save({
      ...record,
      observation,
      observedAt: new Date().toISOString(),
    });
  }
  async retry(id, input) {
    if (input.confirm !== true)
      throw new DomainError("원래 요청의 동일 ID 재전달에 동의해 주세요.");
    const record = await this.check(id);
    if (record.status !== "pending") return record;
    if (record.environmentId === "local")
      throw this.pending(
        "접수 결과가 불명확한 로컬 요청은 다시 실행하지 않습니다. 실제 업무와 파일 상태를 확인해 주세요.",
      );
    if (record.observation !== "missing")
      throw this.pending(
        "원격에서 이미 접수한 요청입니다. 처리 상태를 확인하기 전에는 다시 실행하지 않습니다.",
      );
    await this.deliver(record);
    return this.get(id);
  }
  acknowledge(id) {
    const record = this.get(id);
    if (record.status === "pending")
      throw this.pending("미확인 요청은 처리 완료로 숨길 수 없습니다.");
    return this.save({
      ...record,
      status: "acknowledged",
      input: null,
      result: null,
    });
  }
}
