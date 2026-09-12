import type { Approval, Assignment, Task } from "./types";
import { statusNames } from "./types";

// 외형은 직원 ID/업무 데이터와 독립적이다. 꾸미기 UI 없이도 이 표현 계층을 교체할 수 있다.
export function Avatar({ color = "#6675cf" }: { color?: string }) {
  return (
    <svg
      className="avatar"
      viewBox="0 0 32 40"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <ellipse cx="16" cy="37" rx="12" ry="2" fill="#263047" opacity=".12" />
      <path d="M9 27h6v9H9zm9 0h6v9h-6z" fill="#34405b" />
      <path d="M8 35h8v3H8zm10 0h8v3h-8z" fill="#212938" />
      <path d="M7 19h19v12H7z" fill={color} />
      <path d="M4 22h4v10H4zm22 0h4v10h-4z" fill="#f1c09c" />
      <path d="M7 7h20v13H7zm4 13h12v3H11z" fill="#f1c09c" />
      <path d="M6 6h21v7h-4V9H12v4H6zM9 3h16v5H9z" fill="#493e42" />
      <path d="M12 14h2v3h-2zm9 0h2v3h-2z" fill="#302c36" />
      <path d="M16 19h4v1h-4z" fill="#b2726b" />
      <path d="M13 23h7v3h-7z" fill="#f8f7f3" />
    </svg>
  );
}
function Desk() {
  return (
    <svg
      className="desk"
      viewBox="0 0 120 65"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <path d="M6 29h108v17H6z" fill="#c69b6d" />
      <path d="M6 26h108v14H6z" fill="#ecd4b0" />
      <path d="M11 46h6v19h-6zm92 0h6v19h-6z" fill="#8b8174" />
      <path d="M40 0h40v28H40z" fill="#525d70" />
      <path d="M43 3h34v21H43z" fill="#d3e8ee" />
      <path d="M46 7h20v2H46zm0 5h27v2H46zm0 5h15v2H46z" fill="#7b9bbd" />
      <path d="M56 28h8v4h-8zm-8 4h24v2H48z" fill="#66717c" />
      <path d="M88 20h9v12h-9z" fill="#fcfcf7" />
      <path d="M97 23h3v6h-3z" fill="#e9e7de" />
      <path d="M18 22h13v10H18z" fill="#e7a380" />
    </svg>
  );
}
export function Office({
  team,
  tasks,
  selected,
  onSelect,
  approvals = [],
  onTask,
  stale = false,
}: {
  team: Assignment[];
  tasks: Task[];
  selected: string;
  onSelect: (id: string) => void;
  approvals?: Approval[];
  onTask?: (task: Task) => void;
  stale?: boolean;
}) {
  const pending = new Set(
    approvals.filter((a) => a.status === "pending").map((a) => a.taskId),
  );
  const attention = tasks.filter(
    (task) =>
      team.some((member) => member.id === task.assignmentId) &&
      (pending.has(task.id) ||
        ["waiting", "blocked", "review"].includes(task.status)),
  );
  const order: Record<string, number> = {
    waiting: 1,
    blocked: 2,
    running: 3,
    coordinating: 4,
    review: 5,
    queued: 6,
  };
  const rank = (task: Task) =>
    pending.has(task.id) ? 0 : (order[task.status] ?? 7);
  return (
    <div className="office-floor" data-stale={stale}>
      <div className="office-wall">
        <span>OTTER STUDIO</span>
        <div className="office-window" />
        <div className="office-window" />
        <span className="wall-clock">◷</span>
      </div>
      <div className="office-caption">
        <span className="plant">♣</span>
        <span>작은 팀, 큰 가능성.</span>
        <span className="office-live">
          {stale ? "마지막 확인 상태 · 연결 필요" : "실제 업무 상태"}
        </span>
      </div>
      {!!attention.length && onTask && (
        <details className="office-attention">
          <summary>
            확인할 업무 {attention.length}개 <span>질문·승인·검토</span>
          </summary>
          <ul>
            {attention.map((task) => (
              <li key={task.id}>
                <button type="button" onClick={() => onTask(task)}>
                  <strong>
                    {
                      team.find((member) => member.id === task.assignmentId)
                        ?.settings.name
                    }
                  </strong>
                  <span>{task.title}</span>
                  <small>
                    {pending.has(task.id)
                      ? "질문·승인 필요"
                      : statusNames[task.status]}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="workstations">
        {team.map((member) => {
          const memberTasks = tasks.filter(
            (task) => task.assignmentId === member.id,
          );
          // 실행부는 생성 순서로 업무를 보낸다. 같은 우선순위에서는 최근 업무를 표시한다.
          const task = [...memberTasks]
            .reverse()
            .sort((a, b) => rank(a) - rank(b))[0];
          const status = task
            ? statusNames[task.status] || "상태 확인 필요"
            : "대기 중";
          const recent = task && rank(task) === 7;
          const open = memberTasks.filter((task) => rank(task) < 7).length;
          const speech =
            task &&
            (pending.has(task.id) || task.status === "waiting"
              ? "확인이 필요해요!"
              : task.status === "queued" && task.retryAt
                ? "잠시 후 다시 시도해요"
                : task.status === "review"
                  ? "결과를 확인해 주세요"
                  : `${recent ? "최근 업무 · " : ""}${status}`);
          return (
            <div
              key={member.id}
              className={`station ${selected === member.id ? "selected" : ""} ${task?.status || "idle"}`}
            >
              {task && (
                <button
                  type="button"
                  className="speech"
                  onClick={() => (onTask ? onTask(task) : onSelect(member.id))}
                  aria-label={`${member.settings.name} · ${speech} · ${task.title}, 업무 대화 열기`}
                >
                  <span>{speech}</span>
                  <small title={task.title}>{task.title}</small>
                </button>
              )}
              <button
                type="button"
                className="station-person"
                onClick={() => onSelect(member.id)}
                aria-label={`${member.settings.name}, ${task ? status : "업무 없음"}, 대화 열기`}
              >
                <span className="station-scene">
                  <Avatar color={member.appearance.color} />
                  <Desk />
                </span>
                <strong>{member.settings.name}</strong>
                <span>{member.settings.role}</span>
                <span className={`status-dot ${task?.status || "idle"}`}>
                  {recent ? "최근 업무 · " : ""}
                  {status}
                </span>
                {open > 1 && <span>진행·대기 {open}개</span>}
              </button>
            </div>
          );
        })}
      </div>
      {!team.length && (
        <div className="office-empty">
          <Avatar />
          <h2>첫 동료를 맞이해 볼까요?</h2>
          <p>직원을 배정하면 이곳에서 대화하고 일을 맡길 수 있어요.</p>
        </div>
      )}
      <div className="office-lounge">
        <span>♣</span>
        <div className="sofa" />
        <div className="coffee-table" />
        <div className="rug" />
        <span>♣</span>
      </div>
    </div>
  );
}
