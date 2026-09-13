import { useState } from "react";
import { Approvals } from "./Approvals";
import { ExecutionError, type ErrorSettings } from "./ExecutionError";
import { Verification } from "./Completion";
import { Markdown } from "./Markdown";
import { ReviewTask } from "./ReviewTask";
import { statusNames, type Snapshot, type Task } from "./types";

const kinds: Record<string, string> = {
  result: "결과 보고",
  progress: "진행 보고",
  blocker: "확인 필요",
  push: "Git 전송 기록",
  merge: "Git 반영 기록",
  deployment: "배포 실행 기록",
  automation: "자동 반영 기록",
};

export function Reports({
  data,
  initialTaskId = "",
  onTask,
  action,
  onErrorSettings,
}: {
  data: Snapshot;
  initialTaskId?: string;
  onTask: (task: Task) => void;
  action: (path: string, input: unknown) => Promise<unknown>;
  onErrorSettings?: ErrorSettings;
}) {
  const [taskId, setTaskId] = useState(initialTaskId);
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const tasks = data.tasks || [];
  const owner = (task?: Task) =>
    data.assignments?.find((a) => a.id === task?.assignmentId)?.settings.name;
  const reports = data.reports || [];
  const term = search.trim().toLocaleLowerCase();
  const filtered = [...reports].reverse().filter((report) => {
    const task = tasks.find((t) => t.id === report.taskId);
    return (
      (!taskId || report.taskId === taskId) &&
      (!kind || report.kind === kind) &&
      (!term ||
        [report.title, report.text, task?.title, owner(task)]
          .join("\n")
          .toLocaleLowerCase()
          .includes(term))
    );
  });
  const approvals = (data.approvals || []).filter(
    (a) => a.status === "pending" && (!taskId || a.taskId === taskId),
  );
  const selected = tasks.find((t) => t.id === taskId);
  return (
    <div className="reports-list">
      <section className="report-filters" aria-label="보고 찾기">
        <label>
          업무 범위
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">모든 업무·프로젝트 기록</option>
            {taskId && !selected && (
              <option value={taskId}>연결 업무를 확인할 수 없음</option>
            )}
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title} · {owner(task) || "담당 직원 미확인"}
              </option>
            ))}
          </select>
        </label>
        <label>
          보고 종류
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">모든 종류</option>
            {[...new Set(reports.map((r) => r.kind))].map((value) => (
              <option key={value} value={value}>
                {kinds[value] || "기타 보고"}
              </option>
            ))}
          </select>
        </label>
        <label className="report-search">
          보고 검색
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="제목·내용·담당 직원"
          />
        </label>
        <div className="report-filter-summary">
          <span role="status">
            보고 {filtered.length}개 / 전체 {reports.length}개
          </span>
          <button
            type="button"
            onClick={() => {
              setTaskId("");
              setKind("");
              setSearch("");
            }}
          >
            전체 보고 보기
          </button>
        </div>
        {selected && (
          <p className="report-scope">
            최근 확인한 업무: {selected.title} ·{" "}
            {statusNames[selected.status] || "상태 미확인"}
            <button type="button" onClick={() => onTask(selected)}>
              업무 대화로 돌아가기 →
            </button>
            <small>
              아래 보고는 작성 당시 기록입니다. 현재 상태와 다를 수 있습니다.
            </small>
          </p>
        )}
      </section>
      {!!approvals.length && (
        <details className="report-approvals" open>
          <summary>이 업무 범위의 질문·승인 {approvals.length}개</summary>
          <p>
            보고 검색·종류 필터와 별개인 대기 요청입니다. 해당 요청의 허용
            여부는 따로 결정해 주세요.
          </p>
          <Approvals items={approvals} action={action} tasks={tasks} />
        </details>
      )}
      {filtered.map((r) => {
        const task = tasks.find((t) => t.id === r.taskId);
        const date = r.createdAt ? new Date(r.createdAt) : null;
        return (
          <article className="report-card" key={r.id}>
            <span className="eyebrow">{kinds[r.kind] || "확인 필요"}</span>
            <h2>{r.title}</h2>
            <p className="report-meta">
              {task
                ? `${owner(task) || "담당 직원 미확인"} · ${task.title}`
                : r.taskId
                  ? "연결 업무를 확인할 수 없음"
                  : "프로젝트 기록"}
              {date && Number.isFinite(date.getTime()) && (
                <time dateTime={r.createdAt}>
                  {" "}
                  · {date.toLocaleString("ko-KR")}
                </time>
              )}
            </p>
            {task && (
              <p className="report-current-state">
                작성 당시 기록 · 현재 업무:{" "}
                {statusNames[task.status] || "상태 미확인"}
              </p>
            )}
            {r.kind === "blocker" ? (
              <ExecutionError
                text={r.text}
                onSettings={
                  onErrorSettings
                    ? (target) => onErrorSettings(target, task?.assignmentId)
                    : undefined
                }
              />
            ) : (
              <Markdown text={r.text} />
            )}
            {r.deployment && (
              <details>
                <summary>실행한 배포 명령</summary>
                <pre>
                  {JSON.stringify(
                    [r.deployment.executable, ...r.deployment.command.slice(1)],
                    null,
                    2,
                  )}
                </pre>
                <p>
                  제한 시간: {r.deployment.timeoutSeconds}초 · 명령 출력은 인증
                  정보 보호를 위해 수집하지 않습니다.
                </p>
              </details>
            )}
            <Verification result={r.verificationResult} />
            <footer>
              {r.kind === "push"
                ? "전송 확인과 원격 CI/CD의 성공 여부는 별개입니다."
                : r.kind === "deployment"
                  ? "명령 종료와 외부 서비스의 배포 성공은 별개입니다."
                  : r.kind === "automation"
                    ? "설정에 따른 Git 처리 기록입니다. 서버 CI/CD 결과는 별도로 확인하세요."
                    : r.kind === "merge"
                      ? "승인한 원본 반영 기록입니다. 푸시·배포는 별개입니다."
                      : r.verificationResult
                        ? "직원 보고와 별도 검증 기록을 함께 확인하세요."
                        : "직원의 보고입니다. 독립 검증은 아직 수행되지 않았습니다."}
              {task && (
                <button type="button" onClick={() => onTask(task)}>
                  업무 대화 열기 →
                </button>
              )}
              {task?.status === "review" &&
                r.kind === "result" &&
                [...reports]
                  .reverse()
                  .find(
                    (report) =>
                      report.taskId === task.id && report.kind === "result",
                  )?.id === r.id && <ReviewTask task={task} action={action} />}
            </footer>
          </article>
        );
      })}
      {!filtered.length && (
        <div className="empty-panel">
          {reports.length
            ? "선택한 조건에 맞는 보고가 없습니다. 범위를 바꾸거나 전체 보고를 확인하세요."
            : "아직 보고가 없습니다. 업무가 끝났거나 검증에 통과했다는 뜻은 아닙니다."}
        </div>
      )}
    </div>
  );
}
