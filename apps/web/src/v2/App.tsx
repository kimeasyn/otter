import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  statusNames,
  type Assignment,
  type Document,
  type Project,
  type Snapshot,
  type Task,
} from "./types";
import { Avatar, Office } from "./Office";
import { AvatarPicker } from "./AvatarPicker";
import { Reports } from "./Reports";
import { ModelPicker } from "./ModelPicker";
import { ExecutionError, type ErrorSettings } from "./ExecutionError";
import { ReviewTask } from "./ReviewTask";
import { Markdown } from "./Markdown";
import { TaskTitle } from "./TaskTitle";
import { RecordBackup } from "./RecordBackup";
import { Approvals } from "./Approvals";
import { Staff } from "./Staff";
import { Environments } from "./Environments";
import { InstructionFile } from "./InstructionFile";
import { Knowledge } from "./Knowledge";
import { Completion, Verification } from "./Completion";
import { RequestRecovery } from "./RequestRecovery";
import { EditorLink } from "./Editor";
import { MergeResult } from "./Merge";
import { PushProject } from "./Push";
import { AutomationSettings } from "./Automation";
import { DeployProject } from "./Deployment";
import {
  draftKey,
  finishDraft,
  getDraft,
  setDraft,
  useDrafts,
  useDraftStorageError,
} from "./drafts";

type Page = "office" | "tasks" | "staff" | "documents" | "reports" | "settings";
const pages: [Page, string, string][] = [
  ["office", "▦", "사무실"],
  ["tasks", "☷", "업무"],
  ["staff", "♙", "직원"],
  ["documents", "▤", "문서·지침"],
  ["reports", "◷", "보고"],
  ["settings", "⚙", "설정"],
];
type Action = (
  path: string,
  input: unknown,
  environment?: string,
) => Promise<unknown>;
type TaskFilters = { search: string; owner: string; status: string };
const emptyTaskFilters: TaskFilters = { search: "", owner: "", status: "" };
const fields = (form: HTMLFormElement) =>
  Object.fromEntries(new FormData(form));

const navigationKey = "otter:v2:navigation";
function readNavigation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(navigationKey) || "{}");
    return {
      projectId: typeof saved.projectId === "string" ? saved.projectId : "",
      page: pages.some(([key]) => key === saved.page)
        ? (saved.page as Page)
        : ("office" as Page),
      selected: typeof saved.selected === "string" ? saved.selected : "",
      taskId: typeof saved.taskId === "string" ? saved.taskId : "",
      channel:
        saved.channel === "project"
          ? ("project" as const)
          : saved.channel === "team"
            ? ("team" as const)
            : ("direct" as const),
      expanded: saved.expanded === true,
    };
  } catch {
    return {
      projectId: "",
      page: "office" as Page,
      selected: "",
      taskId: "",
      channel: "direct" as const,
      expanded: false,
    };
  }
}

export function AppV2() {
  const [initialNavigation] = useState(readNavigation);
  const [projectId, setProjectId] = useState(initialNavigation.projectId);
  const [page, setPage] = useState<Page>(initialNavigation.page);
  const [selected, setSelected] = useState(initialNavigation.selected);
  const [chatExpanded, setChatExpanded] = useState(initialNavigation.expanded);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [editorRequest, setEditorRequest] = useState({
    assignmentId: "",
    sequence: 0,
  });
  const [chatSelection, setChatSelection] = useState({
    taskId: initialNavigation.taskId,
    channel: initialNavigation.channel,
  });
  const [taskFilters, setTaskFilters] = useState({
    projectId: "",
    value: emptyTaskFilters,
  });
  const [chatTarget, setChatTarget] = useState({
    taskId: initialNavigation.taskId,
    revision: 0,
  });
  const [reportTarget, setReportTarget] = useState({
    projectId: "",
    taskId: "",
    revision: 0,
  });
  const focusTask = chatSelection.taskId;
  useEffect(() => {
    if (
      page === "office" &&
      chatTarget.revision > 0 &&
      window.matchMedia("(max-width: 930px)").matches
    )
      document
        .getElementById("project-chat")
        ?.scrollIntoView({ block: "start" });
  }, [page, chatTarget.revision]);
  const setFocusTask = (
    taskId: string,
    channel: "direct" | "project" = "direct",
  ) => {
    setChatTarget((current) => ({ taskId, revision: current.revision + 1 }));
    setChatSelection({ taskId, channel });
  };
  useEffect(() => {
    try {
      sessionStorage.setItem(
        navigationKey,
        JSON.stringify({
          projectId,
          page,
          selected,
          ...chatSelection,
          expanded: chatExpanded,
        }),
      );
    } catch {
      /* 탐색 위치 저장 실패는 작업을 막지 않는다. */
    }
  }, [projectId, page, selected, chatSelection, chatExpanded]);
  const [modal, setModal] = useState<
    "project" | "employee" | "environment" | null
  >(null);
  const [error, setError] = useState("");
  const [pendingActions, setPendingActions] = useState(0);
  const busy = pendingActions > 0;
  const openErrorSettings: ErrorSettings = (target, assignmentId) => {
    if (target === "staff") {
      setEditorRequest((current) => ({
        assignmentId: assignmentId || member?.id || "",
        sequence: current.sequence + 1,
      }));
      setPage("staff");
    } else setModal("environment");
  };
  const draftStorageError = useDraftStorageError();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["v2", projectId],
    queryFn: () =>
      api<Snapshot>(
        "state" +
          (projectId ? "?projectId=" + encodeURIComponent(projectId) : ""),
      ),
    refetchInterval: 2000,
  });
  const data = query.data;
  const projects = data?.projects.filter((p) => !p.archived) || [];
  const project = projects.find((p) => p.id === projectId);
  const team = data?.assignments || [];
  const tasks = data?.tasks || [];
  const operationPending =
    ["running", "unconfirmed"].includes(project?.deployment?.status || "") ||
    ["sending", "unconfirmed"].includes(project?.push?.status || "") ||
    tasks.some((task) =>
      ["applying", "unconfirmed"].includes(task.merge?.status || ""),
    );
  const member =
    project?.stage === "idea"
      ? team.find((a) => a.id === project.pmAssignmentId)
      : team.find((a) => a.id === selected) || team[0];
  const focusedTask = tasks.find((task) => task.id === focusTask);
  useEffect(() => {
    if (
      data &&
      (projectId || projects.length) &&
      !projects.some((p) => p.id === projectId)
    ) {
      setProjectId(projects[0]?.id || "");
      setSelected("");
      setFocusTask("");
    }
  }, [data, projectId, projects]);
  const action: Action = async (path, input, environment) => {
    setPendingActions((count) => count + 1);
    setError("");
    try {
      const projectAction = path.match(/^projects\/([^/]+)\//);
      const target = projectAction
        ? data?.projects.find((item) => item.id === projectAction[1])
        : project;
      const result = await api(
        path,
        input,
        environment ?? target?.environmentId ?? "local",
      );
      await client.invalidateQueries({ queryKey: ["v2"] });
      return result;
    } catch (e) {
      setError((e as Error).message);
      // 충돌 뒤 창을 다시 열 때도 최신 결과를 사용한다. 변경 요청 자체는 재전송하지 않는다.
      await client.invalidateQueries({ queryKey: ["v2"] });
      throw e;
    } finally {
      setPendingActions((count) => count - 1);
    }
  };
  const perform = (path: string, input: unknown) => {
    void action(path, input).catch(() => {});
  };
  const openTask = (task: Task) => {
    if (!team.some((member) => member.id === task.assignmentId)) {
      setError(
        "업무의 담당 직원 정보를 확인할 수 없습니다. 다른 직원의 대화로 대신 열지 않습니다. 실행 환경과 프로젝트 기록을 확인해 주세요.",
      );
      return;
    }
    setSelected(task.assignmentId);
    setFocusTask(task.id, task.channel === "project" ? "project" : "direct");
    setChatExpanded(true);
    setPage("office");
  };
  const openReports = (taskId = "") => {
    setReportTarget((current) => ({
      projectId,
      taskId,
      revision: current.revision + 1,
    }));
    setPage("reports");
  };
  return (
    <div className="otter-app">
      <aside
        className={`app-sidebar ${workspaceMenu ? "workspace-menu-open" : ""}`}
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("office");
          }}
        >
          <span className="brand-icon">
            o<span>·</span>
          </span>
          otter<span className="beta">PREVIEW</span>
        </a>
        <button
          className="workspace-menu-toggle"
          aria-expanded={workspaceMenu}
          aria-controls="workspace-controls"
          onClick={() => setWorkspaceMenu(!workspaceMenu)}
          aria-label="작업공간 메뉴"
        >
          ☰
        </button>
        <div id="workspace-controls" className="workspace-controls">
          <label className="company-picker">
            내 작업공간
            <select
              aria-label="프로젝트 선택"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSelected("");
                setFocusTask("");
                setWorkspaceMenu(false);
              }}
            >
              <option value="" disabled>
                프로젝트 선택
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.stage === "idea" ? " · 구상 중" : ""}
                  {p.environmentId && p.environmentId !== "local"
                    ? ` · ${p.environmentLabel}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <button className="new-project" onClick={() => setModal("project")}>
            ＋ 프로젝트 시작
          </button>
          <button
            className="new-project"
            onClick={() => setModal("environment")}
          >
            ⌁ 실행 환경
          </button>
        </div>
        <nav aria-label="주 메뉴">
          {pages.map(([key, icon, label]) => (
            <button
              key={key}
              className={page === key ? "active" : ""}
              onClick={() => (key === "reports" ? openReports() : setPage(key))}
            >
              <span>{icon}</span>
              {label}
              {key === "reports" && !!data?.reports?.length && (
                <small>{data.reports.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="workspace-mark">1</span>
          <div>
            나의 AI 회사<small>사람 한 명, 함께하는 직원들</small>
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="app-header">
          <div className="breadcrumb">
            {data?.companies.find((c) => c.id === project?.companyId)?.name ||
              "나의 작업공간"}
            <span>/</span>
            <strong>{project?.name || "시작하기"}</strong>
          </div>
          {project && data && (
            <details className="project-actions">
              <summary>프로젝트 작업</summary>
              <div className="project-actions-popover">
                <PushProject project={project} />
                <DeployProject project={project} />
                <EditorLink
                  project={project}
                  environments={data.environments}
                />
              </div>
            </details>
          )}
          <div
            className={`connection ${query.isError || data?.connectionError ? "offline" : ""}`}
          >
            <i />
            {query.isError
              ? "앱 실행부 연결 끊김"
              : `${project?.environmentLabel || "로컬"}${data?.connectionError ? " · 연결 끊김" : " 실행부"}`}
          </div>
        </header>
        {data?.connectionError && (
          <div className="error-banner" role="status">
            <div>
              {data.connectionError}
              <br />
              <small>
                저장된 기록입니다. 연결 끊김을 업무 실패로 처리하지 않습니다.
                {data.observedAt
                  ? ` 최근 확인: ${new Date(data.observedAt).toLocaleString()}`
                  : ""}
              </small>
            </div>
            <button onClick={() => setModal("environment")}>
              실행 환경 열기
            </button>
          </div>
        )}
        {(error || query.error) && (
          <div role="alert" className="error-banner">
            {error || query.error?.message}
            <button
              onClick={() => {
                setError("");
                void query.refetch();
              }}
            >
              다시 확인
            </button>
          </div>
        )}
        {data && (
          <RequestRecovery
            onEnvironments={() => setModal("environment")}
            onOpen={(location) => {
              if (
                !data.projects.some(
                  (p) =>
                    p.id === location.projectId &&
                    !p.archived &&
                    (p.environmentId || "local") === location.environmentId,
                )
              ) {
                setError(
                  "대상 프로젝트를 아직 열 수 없습니다. 실행 환경 연결과 프로젝트 보관 여부를 확인해 주세요.",
                );
                return;
              }
              setProjectId(location.projectId);
              setSelected(location.assignmentId || "");
              setFocusTask(location.taskId || "");
              setPage("office");
            }}
          />
        )}
        {draftStorageError && (
          <div className="error-banner" role="alert">
            {draftStorageError}
          </div>
        )}
        {!data ? (
          <div className="welcome">
            <h1>작업공간에 연결하고 있어요.</h1>
            <p>
              기록을 읽고 있습니다. 연결 실패를 작업 실패로 처리하지 않습니다.
            </p>
          </div>
        ) : !project ? (
          <div className="welcome">
            <span className="eyebrow">DEVELOP WITHOUT CODE</span>
            <h1>
              아이디어는 당신이.
              <br />
              개발은 당신의 팀이.
            </h1>
            <p>
              AI 직원을 모으고, 일을 맡기고, 결과를 확인하세요.
              <br />
              직접 코드를 수정할 때는 평소 쓰는 IDE를 열면 됩니다.
            </p>
            <button className="primary" onClick={() => setModal("project")}>
              첫 프로젝트 시작하기 ↗
            </button>
            <div className="welcome-notes">
              <span>01 저장소 연결</span>
              <span>02 직원 배정</span>
              <span>03 대화로 업무 요청</span>
            </div>
            {data.projects.some((p) => p.archived) && (
              <section className="archived-projects">
                <h2>보관한 프로젝트</h2>
                {data.projects
                  .filter((p) => p.archived)
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        void action(`projects/${p.id}/restore`, {})
                          .then(() => setProjectId(p.id))
                          .catch(() => {});
                      }}
                    >
                      {p.name} 다시 열기 ↗
                    </button>
                  ))}
              </section>
            )}
          </div>
        ) : (
          <div className={`workspace ${page === "office" ? "with-chat" : ""}`}>
            <main className="main-content">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {page === "office" ? "YOUR TEAM, AT WORK" : project.name}
                  </span>
                  <h1>
                    {page === "office" && project.stage === "idea"
                      ? "아이디어 회의실"
                      : pages.find((p) => p[0] === page)?.[2]}
                  </h1>
                  <p>
                    {page === "office"
                      ? project.stage === "idea"
                        ? "PM과 필요한 것부터 정리하고, 준비되면 개발을 시작하세요."
                        : "동료를 클릭해 대화하고, 진행 중인 일을 확인하세요."
                      : page === "tasks"
                        ? "업무의 진행과 검토를 한곳에서."
                        : page === "staff"
                          ? "함께 일할 동료와 일하는 방식을 관리하세요."
                          : page === "documents"
                            ? "팀이 같은 방향으로 일하기 위한 기준."
                            : page === "reports"
                              ? "대화와 구분해서 보는 결과와 확인할 사항."
                              : "실행 환경과 작업 정책을 확인하세요."}
                  </p>
                </div>
                <div className="button-row">
                  {page === "tasks" && project.stage !== "idea" && (
                    <button
                      className="primary"
                      onClick={() => {
                        if (!team.length) {
                          setModal("employee");
                          return;
                        }
                        setFocusTask("");
                        setPage("office");
                      }}
                    >
                      ＋ 새 업무 맡기기
                    </button>
                  )}
                  {page === "office" && (
                    <button
                      className="chat-jump"
                      onClick={() => setChatExpanded(true)}
                    >
                      대화 크게 보기 ↗
                    </button>
                  )}
                  {["office", "staff"].includes(page) && (
                    <button
                      className="primary"
                      onClick={() => setModal("employee")}
                    >
                      ＋ 직원 배정
                    </button>
                  )}
                </div>
              </div>
              {operationPending && (
                <p role="status" className="form-error">
                  Git/배포 결과 확인 전에는 새 업무나 다른 반영을 시작하지
                  않습니다. 업무 카드의 결과 대조 또는 상단 Git 푸시·배포
                  메뉴에서 확인하세요.
                </p>
              )}
              {page === "office" && project.stage === "idea" && (
                <IdeaWorkspace
                  project={project}
                  data={data}
                  action={action}
                  onTask={openTask}
                />
              )}
              {page === "office" && project.stage !== "idea" && (
                <>
                  <div className="office-toolbar">
                    <span>
                      <i className="green-dot" /> {team.length}명의 동료
                    </span>
                    <span>
                      {tasks.filter((t) => t.status === "running").length} 작업
                      중
                    </span>
                    <span>
                      {
                        tasks.filter(
                          (t) =>
                            t.status === "waiting" ||
                            data.approvals?.some(
                              (a) =>
                                a.taskId === t.id && a.status === "pending",
                            ),
                        ).length
                      }{" "}
                      답변·승인 필요
                    </span>
                    <button onClick={() => setPage("tasks")}>
                      업무 목록 보기 ↗
                    </button>
                  </div>
                  <Office
                    team={team}
                    tasks={tasks}
                    selected={member?.id || ""}
                    approvals={data.approvals}
                    onTask={openTask}
                    stale={query.isError || !!data.connectionError}
                    onSelect={(id) => {
                      setSelected(id);
                      setFocusTask("");
                    }}
                  />
                  <div className="office-bottom">
                    <span>
                      {query.isError || data.connectionError
                        ? "연결 전까지 마지막으로 확인한 상태입니다."
                        : "✦ 실제 실행 상태만 표시합니다."}
                    </span>
                    <span>꾸미기는 추후 지원 예정</span>
                  </div>
                </>
              )}
              {page === "tasks" && (
                <TaskBoard
                  tasks={tasks}
                  team={team}
                  project={project}
                  environments={data.environments}
                  approvals={data.approvals}
                  action={action}
                  onOpen={openTask}
                  onReports={openReports}
                  onErrorSettings={openErrorSettings}
                  filters={
                    taskFilters.projectId === project.id
                      ? taskFilters.value
                      : emptyTaskFilters
                  }
                  onFilters={(value) =>
                    setTaskFilters({ projectId: project.id, value })
                  }
                  stale={query.isError || !!data.connectionError}
                />
              )}
              {page === "staff" && (
                <Staff
                  key={`${project.environmentId || "local"}:${project.id}`}
                  projectId={project.id}
                  editorRequest={editorRequest}
                  environment={project.environmentId}
                  environmentLabel={project.environmentLabel}
                  data={data}
                  action={action}
                  onChat={(id) => {
                    setSelected(id);
                    setFocusTask("");
                    setPage("office");
                  }}
                  onAdd={() => setModal("employee")}
                />
              )}
              {page === "documents" && (
                <div className="document-list">
                  <Knowledge
                    key={project.id}
                    project={project}
                    data={data}
                    action={action}
                  />
                  {data.documents?.map((d) => (
                    <DocumentEditor
                      key={d.id}
                      doc={d}
                      action={action}
                      environment={project.environmentId}
                      files={project.stage !== "idea"}
                    />
                  ))}
                </div>
              )}
              {page === "reports" && (
                <Reports
                  onErrorSettings={openErrorSettings}
                  key={project.id + reportTarget.revision}
                  data={data}
                  initialTaskId={
                    reportTarget.projectId === project.id
                      ? reportTarget.taskId
                      : ""
                  }
                  action={action}
                  onTask={openTask}
                />
              )}
              {page === "settings" && (
                <div className="settings-list">
                  <RecordBackup />
                  <section>
                    <h2>실행 환경</h2>
                    <p>
                      {project.environmentLabel || "로컬"} · {project.root}
                    </p>
                    <p>
                      선택한 실행 환경에 설치된 CLI와 도구로 업무를 수행합니다.
                    </p>
                    <button onClick={() => setModal("environment")}>
                      환경 관리
                    </button>
                  </section>
                  <section>
                    <h2>실행 한도</h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        perform("settings", {
                          concurrency: Number(
                            new FormData(e.currentTarget).get("concurrency"),
                          ),
                          retries: Number(
                            new FormData(e.currentTarget).get("retries"),
                          ),
                        });
                      }}
                    >
                      <label>
                        동시에 작업할 직원 수
                        <input
                          name="concurrency"
                          type="number"
                          min="1"
                          max="16"
                          defaultValue={data.settings.concurrency}
                        />
                      </label>
                      <label>
                        일시적 오류 자동 재시도 횟수
                        <input
                          name="retries"
                          type="number"
                          min="0"
                          max="16"
                          required
                          defaultValue={data.settings.retries}
                        />
                      </label>
                      <p>
                        0이면 자동 재시도를 끕니다. 새 요청부터 로컬·원격에
                        적용합니다. 실행 종료가 확인되고 명령·도구 실행이 없었던
                        일시적 오류만 재시도합니다.
                      </p>
                      <button type="submit">저장</button>
                    </form>
                  </section>
                  <section>
                    <h2>현재 검증 단계</h2>
                    <p>
                      기본 완료 방식은 사용자 검토입니다. Codex가 요청한 실행
                      권한은 자동 승인하지 않습니다.
                    </p>
                    <p>
                      아래 완료 후 자동 반영과 임의 에이전트 명령의 권한 정책은
                      별개입니다. 전체 권한 강제와 설치형 패키징은 구현
                      중입니다.
                    </p>
                  </section>
                  {project.stage !== "idea" && (
                    <AutomationSettings
                      key={`automation-${project.id}`}
                      project={project}
                      action={action}
                      busy={busy}
                    />
                  )}
                  {project.stage !== "idea" && (
                    <Completion
                      key={project.id}
                      project={project}
                      action={action}
                      busy={busy}
                    />
                  )}
                  <section>
                    <h2>프로젝트 연결</h2>
                    <p>
                      보관하면 목록에서만 숨깁니다. 실제 파일과 대화 기록은
                      그대로 남습니다.
                    </p>
                    <button
                      className="danger"
                      onClick={() => {
                        if (
                          window.confirm(
                            "프로젝트를 목록에서 보관할까요? 실제 디렉토리와 파일은 삭제하지 않습니다.",
                          )
                        )
                          void action(`projects/${project.id}/archive`, {})
                            .then(() => setProjectId(""))
                            .catch(() => {});
                      }}
                    >
                      프로젝트 보관
                    </button>
                  </section>
                  <section>
                    <h2>보관한 프로젝트</h2>
                    {data.projects
                      .filter((p) => p.archived)
                      .map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            void action(`projects/${p.id}/restore`, {})
                              .then(() => setProjectId(p.id))
                              .catch(() => {});
                          }}
                        >
                          {p.name} 다시 열기 ↗
                        </button>
                      ))}
                    {!data.projects.some((p) => p.archived) && (
                      <p>보관한 프로젝트가 없습니다.</p>
                    )}
                  </section>
                </div>
              )}
            </main>
            {page === "office" && (
              <Chat
                expanded={chatExpanded}
                onExpandedChange={setChatExpanded}
                onSelectionChange={setChatSelection}
                onErrorSettings={openErrorSettings}
                key={
                  (member?.id || "empty") + chatTarget.revision + project.stage
                }
                member={member}
                data={data}
                action={action}
                projectId={projectId}
                busy={busy}
                onReports={openReports}
                onTask={openTask}
                initialChannel={chatSelection.channel}
                initialTaskId={
                  focusedTask
                    ? focusedTask.id
                    : tasks.some((task) => task.id === chatSelection.taskId)
                      ? chatSelection.taskId
                      : project.stage === "idea"
                        ? [...tasks]
                            .reverse()
                            .find((t) => t.mode === "interview")?.id || ""
                        : ""
                }
              />
            )}
          </div>
        )}
      </div>
      {modal && data && (
        <dialog
          className="modal-backdrop"
          aria-labelledby="modal-title"
          ref={(element) => {
            if (element && !element.open) element.showModal();
          }}
          onCancel={(e) => {
            if (busy) e.preventDefault();
            else setModal(null);
          }}
          onClick={(e) => {
            if (!busy && e.target === e.currentTarget) setModal(null);
          }}
        >
          <section className="modal">
            <button
              aria-label="닫기"
              className="modal-close"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              ×
            </button>
            {modal === "environment" ? (
              <Environments data={data} action={action} />
            ) : modal === "project" ? (
              <ProjectForm
                data={data}
                action={action}
                done={(id) => {
                  setProjectId(id);
                  setModal(null);
                  setPage("office");
                }}
              />
            ) : (
              <EmployeeForm
                data={data}
                projectId={projectId}
                action={action}
                done={() => setModal(null)}
              />
            )}
          </section>
        </dialog>
      )}
    </div>
  );
}
export function TaskBoard({
  tasks,
  team,
  project,
  environments,
  approvals,
  action,
  onOpen,
  onReports,
  onErrorSettings,
  filters,
  onFilters,
  stale = false,
}: {
  tasks: Task[];
  team: Assignment[];
  project: Project;
  environments?: Snapshot["environments"];
  approvals?: Snapshot["approvals"];
  action: Action;
  onOpen: (task: Task) => void;
  onReports?: (taskId: string) => void;
  onErrorSettings?: ErrorSettings;
  filters: TaskFilters;
  onFilters: (filters: TaskFilters) => void;
  stale?: boolean;
}) {
  const owners = new Map(
    team.map((member) => [member.id, member.settings.name]),
  );
  const pending = new Set(
    (approvals || [])
      .filter((a) => a.status === "pending")
      .map((a) => a.taskId),
  );
  const group = (task: Task) =>
    task.executionUnconfirmed || pending.has(task.id)
      ? 1
      : ["queued", "running", "coordinating"].includes(task.status)
        ? 0
        : ["completed", "handoff"].includes(task.status)
          ? 2
          : 1;
  const term = filters.search.trim().toLocaleLowerCase();
  const filtered = [...tasks]
    .reverse()
    .filter(
      (task) =>
        (!term ||
          [task.title, owners.get(task.assignmentId)]
            .join("\n")
            .toLocaleLowerCase()
            .includes(term)) &&
        (!filters.owner ||
          (filters.owner === "missing"
            ? !owners.has(task.assignmentId)
            : task.assignmentId === filters.owner)) &&
        (!filters.status ||
          (filters.status === "attention"
            ? group(task) === 1
            : task.status === filters.status)),
    );
  const groups = [0, 1, 2].map((index) =>
    filtered.filter((task) => group(task) === index),
  );
  return (
    <div className="task-workspace">
      <section className="task-filters" aria-label="업무 찾기">
        <label>
          업무 검색
          <input
            type="search"
            value={filters.search}
            placeholder="제목·담당 직원"
            onChange={(e) => onFilters({ ...filters, search: e.target.value })}
          />
        </label>
        <label>
          담당 직원
          <select
            value={filters.owner}
            onChange={(e) => onFilters({ ...filters, owner: e.target.value })}
          >
            <option value="">모든 직원</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>
                {member.settings.name}
              </option>
            ))}
            {filters.owner &&
              filters.owner !== "missing" &&
              !owners.has(filters.owner) && (
                <option value={filters.owner}>
                  이전에 선택한 직원 · 현재 미확인
                </option>
              )}
            {(filters.owner === "missing" ||
              tasks.some((task) => !owners.has(task.assignmentId))) && (
              <option value="missing">담당 직원 미확인</option>
            )}
          </select>
        </label>
        <label>
          업무 상태
          <select
            value={filters.status}
            onChange={(e) => onFilters({ ...filters, status: e.target.value })}
          >
            <option value="">모든 상태</option>
            <option value="attention">확인할 업무</option>
            {[
              ...new Set([
                ...Object.keys(statusNames),
                ...tasks.map((task) => task.status),
                ...(filters.status && filters.status !== "attention"
                  ? [filters.status]
                  : []),
              ]),
            ].map((status) => (
              <option key={status} value={status}>
                {statusNames[status] || `상태 미확인 · ${status}`}
              </option>
            ))}
          </select>
        </label>
        <div className="task-filter-summary">
          <span role="status">
            업무 {filtered.length}개 / 전체 {tasks.length}개 · 최근 등록순
          </span>
          <button
            type="button"
            onClick={() =>
              onFilters({ ...emptyTaskFilters, status: "attention" })
            }
          >
            확인할 업무 {tasks.filter((task) => group(task) === 1).length}개
          </button>
          <button type="button" onClick={() => onFilters(emptyTaskFilters)}>
            필터 초기화
          </button>
        </div>
      </section>
      {stale && (
        <p role="status">연결 전까지 마지막으로 확인한 업무를 표시합니다.</p>
      )}
      {!filtered.length && (
        <p className="empty-panel">
          {tasks.length
            ? "조건에 맞는 업무가 없습니다. 필터를 초기화하거나 검색어를 바꿔 주세요."
            : "아직 업무가 없습니다. 사무실에서 직원을 선택해 일을 맡겨 보세요."}
        </p>
      )}
      <div className="task-board">
        {groups.map((items, index) => (
          <section
            key={index}
            aria-label={["진행 중", "확인할 업무", "완료·인계"][index]}
          >
            <h2>
              {["진행 중", "확인할 업무", "완료·인계"][index]}{" "}
              <small>{items.length}</small>
            </h2>
            {items.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                project={project}
                environments={environments}
                team={team}
                environment={project.environmentId}
                action={action}
                perform={(path, input) => {
                  void action(path, input).catch(() => {});
                }}
                onOpen={() => onOpen(task)}
                onReports={onReports ? () => onReports(task.id) : undefined}
                onErrorSettings={(target) =>
                  onErrorSettings?.(target, task.assignmentId)
                }
                pendingApproval={pending.has(task.id)}
              />
            ))}
            {!items.length && (
              <p className="empty-line">표시할 업무가 없습니다.</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
function TaskCard({
  task,
  project,
  environments,
  team,
  perform,
  onOpen,
  onReports,
  onErrorSettings,
  environment,
  action,
  pendingApproval = false,
}: {
  task: Task;
  project: Project;
  environments?: Snapshot["environments"];
  team: Assignment[];
  perform: (path: string, input: unknown) => void;
  onOpen: () => void;
  onReports?: () => void;
  onErrorSettings?: ErrorSettings;
  environment?: string;
  action: Action;
  pendingApproval?: boolean;
}) {
  const [diff, setDiff] = useState("");
  return (
    <article className="task-card">
      <span className={`task-status ${task.status}`}>
        {task.status === "queued" && task.retryAt
          ? "재시도 대기"
          : statusNames[task.status] || "상태 미확인"}
      </span>
      {pendingApproval && <small>답변·승인 필요</small>}
      {task.executionUnconfirmed && <small>이전 실행 종료 확인 필요</small>}
      <h3>{task.title}</h3>
      <button
        onClick={onOpen}
        disabled={!team.some((member) => member.id === task.assignmentId)}
      >
        대화 열기 →
      </button>
      <EditorLink project={project} task={task} environments={environments} />
      {task.mode === "delegate" && <small>PM 위임 목표</small>}
      {task.mode === "interview" && (
        <small>PM 인터뷰 · 개발 전 요구사항 정리</small>
      )}
      {task.parentTaskId && (
        <small>
          PM이 배정한 업무 · {(task.dependencies || []).length}개 선행 업무
        </small>
      )}
      <p>
        {team.find((a) => a.id === task.assignmentId)?.settings.name ||
          "담당 직원 미확인"}
      </p>
      {!!task.retryCount && (
        <small>
          자동 재시도 {task.retryCount}/{task.maxRetries}회
          {task.status === "queued" && task.retryAt
            ? ` · ${new Date(task.retryAt).toLocaleTimeString()} 이후 실행`
            : ""}
        </small>
      )}
      {task.error && (
        <ExecutionError text={task.error} onSettings={onErrorSettings} />
      )}
      {task.error && onReports && (
        <button type="button" onClick={onReports}>
          관련 보고 확인 →
        </button>
      )}
      {task.acceptedBy === "verification" && (
        <small>완료 판정: 지정 검증 통과 · Git 반영 상태는 별도</small>
      )}
      {task.acceptedBy === "user" && task.acceptedReview && (
        <small>
          사용자 검토 완료 · 실행 {task.acceptedReview.generation}회차 · 변경
          번호 {task.acceptedReview.revision}
        </small>
      )}
      <Verification result={task.verification} />
      {task.automation && (
        <p role={task.automation.status === "blocked" ? "alert" : "status"}>
          자동 반영:{" "}
          {{
            running: "처리 중",
            done: "완료",
            blocked: "확인 필요",
            "waiting-merge": "원본 반영 대기",
            cancelled: "해제됨",
          }[task.automation.status] || task.automation.status}
          {task.automation.message && <small>{task.automation.message}</small>}
        </p>
      )}
      <MergeResult project={project} task={task} />
      {task.worktree && task.mode !== "interview" && (
        <details>
          <summary>작업 브랜치</summary>
          <p>{task.worktree.branch}</p>
          <code>{task.worktree.path}</code>
          <button
            onClick={() => {
              void api<{ diff: string; untracked: string }>(
                `tasks/${task.id}/diff`,
                undefined,
                environment,
              )
                .then((r) =>
                  setDiff(
                    (r.diff || "추적 파일 변경 없음") +
                      "\n새 파일:\n" +
                      r.untracked,
                  ),
                )
                .catch((e) => setDiff(e.message));
            }}
          >
            변경 내용 확인
          </button>
          {diff && <pre>{diff}</pre>}
        </details>
      )}
      {["running", "waiting", "queued", "coordinating", "blocked"].includes(
        task.status,
      ) && (
        <button onClick={() => perform(`tasks/${task.id}/cancel`, {})}>
          작업 중단
        </button>
      )}
      {task.status === "review" && <ReviewTask task={task} action={action} />}
    </article>
  );
}
export function Chat({
  member,
  data,
  action,
  projectId,
  busy,
  initialTaskId,
  onReports,
  onTask,
  onErrorSettings,
  initialChannel = "direct",
  expanded: controlledExpanded,
  onExpandedChange,
  onSelectionChange,
}: {
  member?: Assignment;
  data: Snapshot;
  action: Action;
  projectId: string;
  busy: boolean;
  initialTaskId: string;
  onReports: (taskId: string) => void;
  onTask: (task: Task) => void;
  onErrorSettings?: ErrorSettings;
  initialChannel?: "direct" | "project" | "team";
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onSelectionChange?: (selection: {
    taskId: string;
    channel: "direct" | "project" | "team";
  }) => void;
}) {
  const interview =
    data.projects.find((p) => p.id === projectId)?.stage === "idea";
  const [taskId, setTaskId] = useState(initialTaskId);
  const [channel, setChannel] = useState<"direct" | "project" | "team">(
    initialChannel,
  );
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const setExpanded = onExpandedChange ?? setLocalExpanded;
  useEffect(() => {
    onSelectionChange?.({
      taskId,
      channel,
    });
  }, [taskId, channel, onSelectionChange]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const tasks = (data.tasks || []).filter((t) => t.assignmentId === member?.id);
  const selectedTask = (
    channel === "direct" ? tasks : channel === "project" ? data.tasks || [] : []
  ).find((task) => task.id === taskId);
  const recipient =
    taskId && channel !== "team"
      ? data.assignments?.find((a) => a.id === selectedTask?.assignmentId)
      : member;
  const matchingChannel =
    !selectedTask || (selectedTask.channel || "direct") === channel;
  const activeSelection =
    !!selectedTask &&
    ["running", "waiting", "queued", "coordinating"].includes(
      selectedTask.status,
    );
  const uncertainSteering = (data.messages || []).some(
    (m) =>
      m.taskId === selectedTask?.id &&
      m.kind === "steering" &&
      ["sending", "unconfirmed"].includes(m.delivery || "") &&
      m.generation === selectedTask?.generation,
  );
  const canSteer =
    selectedTask?.status === "running" &&
    !!selectedTask.providerTurnId &&
    !!selectedTask.generation &&
    !uncertainSteering;
  const interrupted = selectedTask?.status === "interrupted";
  const resumable =
    interrupted &&
    selectedTask.interruptionConfirmed === true &&
    Number.isInteger(selectedTask.revision) &&
    !selectedTask.executionUnconfirmed &&
    !selectedTask.parentTaskId;
  const canSend =
    !!recipient &&
    matchingChannel &&
    !(taskId && !selectedTask) &&
    !selectedTask?.executionUnconfirmed &&
    (!activeSelection || canSteer) &&
    (!interrupted || resumable);
  const keyForTask = (id: string) =>
    draftKey(
      "chat",
      data.projects.find((p) => p.id === projectId)?.environmentId || "local",
      projectId,
      (channel === "project" && id
        ? data.tasks?.find((task) => task.id === id)?.assignmentId
        : member?.id) || "",
      interview ? "idea" : "development",
      channel,
      id,
    );
  const key = keyForTask(taskId);
  const drafts = useDrafts();
  const draft = drafts[key];
  const text = draft?.text || "";
  const mode = draft?.mode || "direct";
  const activeDraftKey = useRef(key);
  useEffect(() => {
    activeDraftKey.current = key;
  }, [key]);
  const bottom = useRef<HTMLDivElement>(null);
  const approvalStart = useRef<HTMLDivElement>(null);
  const taskPicker = useRef<HTMLSelectElement>(null);
  const messages = (data.messages || []).filter(
    (m) =>
      (channel === "direct"
        ? m.assignmentId === member?.id && m.channel === "direct"
        : m.channel === channel) &&
      (!taskId || m.taskId === taskId),
  );
  const continuing =
    selectedTask &&
    ["review", "completed", "blocked", "failed", "interrupted"].includes(
      selectedTask.status,
    ) &&
    !selectedTask.parentTaskId;
  const canContinue =
    continuing &&
    matchingChannel &&
    (selectedTask.mode !== "interview" || interview);
  const approvals = (data.approvals || []).filter(
    (a) =>
      a.status === "pending" &&
      (!taskId || a.taskId === taskId) &&
      (channel === "direct"
        ? tasks.some((t) => t.id === a.taskId)
        : channel === "project"),
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);
  useEffect(() => {
    if (initialTaskId) {
      taskPicker.current?.focus({ preventScroll: true });
      taskPicker.current?.scrollIntoView({ block: "nearest" });
    }
  }, [initialTaskId]);
  return (
    <aside
      id="project-chat"
      className={`chat-panel ${expanded ? "expanded" : ""}`}
      aria-label="팀 대화"
    >
      <header>
        <div className="chat-person">
          <Avatar {...recipient?.appearance} />
          <div>
            <h2>
              {channel === "team"
                ? "직원 간 대화"
                : channel === "project" && !taskId
                  ? "프로젝트 대화"
                  : recipient?.settings.name || "팀 메신저"}
            </h2>
            <p>
              {channel === "team"
                ? "실제 교환 메시지와 업무 인계"
                : recipient
                  ? `${channel === "project" ? "담당 직원 · " + recipient.settings.name + " · " : ""}${recipient.settings.role}`
                  : "담당 직원을 확인할 수 없습니다"}
            </p>
          </div>
        </div>
        <span className="chat-badge">
          {channel === "direct"
            ? "1:1"
            : channel === "project"
              ? "프로젝트"
              : "직원 간"}
        </span>
        <button
          type="button"
          className="chat-view-toggle"
          aria-pressed={expanded}
          onClick={(event) => {
            setExpanded(!expanded);
            event.currentTarget
              .closest("aside")
              ?.scrollIntoView({ block: "start" });
          }}
        >
          {expanded ? "사무실 함께 보기" : "대화 크게 보기"}
        </button>
      </header>
      <div className="chat-filter">
        {!!approvals.length && (
          <button
            type="button"
            className="approval-jump"
            onClick={() => {
              const target = approvalStart.current;
              const container = target?.parentElement;
              if (target && container)
                container.scrollTop +=
                  target.getBoundingClientRect().top -
                  container.getBoundingClientRect().top;
            }}
          >
            대기 요청 {approvals.length}개 읽기 ↑
          </button>
        )}
        {channel !== "team" && (
          <button
            type="button"
            className="new-task-button"
            disabled={!member || busy}
            onClick={() => {
              setTaskId("");
              composer.current?.focus({ preventScroll: true });
            }}
          >
            ＋ 새 업무 요청
          </button>
        )}
        <div className="chat-tabs" aria-label="대화 종류">
          {(
            [
              ["direct", "1:1"],
              ["project", "프로젝트"],
              ["team", "직원 간"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={channel === key ? "active" : ""}
              onClick={() => {
                setChannel(key);
                setTaskId("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          ref={taskPicker}
          aria-label="업무 대화 선택"
          value={taskId}
          onChange={(e) => {
            setTaskId(e.target.value);
          }}
        >
          <option value="">
            모든 업무 대화{channel !== "team" ? " · 새 업무 작성" : ""}
            {drafts[keyForTask("")]?.text ? " · 초안" : ""}
          </option>
          {(channel === "direct" ? tasks : data.tasks || []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
              {drafts[keyForTask(t.id)]?.text ? " · 초안" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="chat-messages">
        {selectedTask && (
          <section className="chat-task-context" aria-label="선택한 업무 상태">
            <TaskTitle
              key={selectedTask.id}
              task={selectedTask}
              action={action}
            />
            <strong>
              업무 상태 · {statusNames[selectedTask.status] || "상태 미확인"}
            </strong>
            {selectedTask.error && (
              <ExecutionError
                text={selectedTask.error}
                onSettings={(target) =>
                  onErrorSettings?.(target, selectedTask.assignmentId)
                }
              />
            )}
            {selectedTask.status === "review" && (
              <ReviewTask task={selectedTask} action={action} />
            )}
            {(data.reports || []).some((r) => r.taskId === selectedTask.id) ? (
              <button type="button" onClick={() => onReports(selectedTask.id)}>
                관련 보고{" "}
                {
                  (data.reports || []).filter(
                    (r) => r.taskId === selectedTask.id,
                  ).length
                }
                개 보기 →
              </button>
            ) : (
              <small>아직 이 업무의 보고가 없습니다.</small>
            )}
            {!matchingChannel && (
              <p>
                이 업무는{" "}
                {selectedTask.channel === "project"
                  ? "프로젝트 대화"
                  : "1:1 대화"}
                에서 진행합니다.
                <button type="button" onClick={() => onTask(selectedTask)}>
                  원래 업무 대화 열기 →
                </button>
              </p>
            )}
            {selectedTask.executionUnconfirmed && (
              <p>
                이전 실행의 종료가 확인되지 않아 같은 업무에 추가 요청을 보내지
                않습니다.
              </p>
            )}
            {interrupted && !resumable && (
              <p>
                {selectedTask.parentTaskId
                  ? "PM이 배정한 업무입니다. 상위 PM 업무에서 진행 방법을 정해 주세요."
                  : "종료 확인 기록이 없어 바로 재개할 수 없습니다. 기존 실행 상태와 보존된 작업 파일을 확인해 주세요."}
              </p>
            )}
            {activeSelection && (
              <p>
                {uncertainSteering
                  ? "추가 지시의 전달 여부를 확인 중이거나 확인하지 못했습니다. 같은 내용을 다시 보내지 말고 직원 응답과 결과를 확인해 주세요."
                  : canSteer
                    ? "추가 지시는 같은 업무의 현재 실행에 전달합니다. 이미 실행한 작업을 취소하거나 권한 요청을 승인하지는 않습니다. 새 업무는 ‘모든 업무 대화’를 선택해 요청하세요."
                    : "실행 준비·대기 또는 질문/승인 처리 중입니다. 추가 지시 대신 해당 질문·승인을 확인해 주세요. 새 업무는 ‘모든 업무 대화’에서 요청할 수 있습니다."}
              </p>
            )}
          </section>
        )}
        {!messages.length && (
          <div className="chat-intro">
            <Avatar {...recipient?.appearance} />
            <h3>
              {selectedTask
                ? "이 대화방에는 해당 업무의 메시지가 없습니다."
                : recipient
                  ? `${recipient.settings.name}에게 일을 맡겨 보세요.`
                  : "이곳에서 대화를 시작하세요."}
            </h3>
            <p>요청과 답변은 이 프로젝트에만 보관됩니다.</p>
          </div>
        )}
        {messages.map((m) => (
          <div
            className={`message ${m.sender === "user" ? "mine" : ""}`}
            key={m.id}
          >
            <span>
              {m.sender === "user"
                ? "나"
                : data.assignments?.find(
                    (a) => a.id === (m.senderAssignmentId || m.assignmentId),
                  )?.settings.name || "직원"}
              {m.recipientAssignmentId && (
                <>
                  {" "}
                  →{" "}
                  {data.assignments?.find(
                    (a) => a.id === m.recipientAssignmentId,
                  )?.settings.name || "담당 직원"}
                </>
              )}
              {m.kind === "handoff" ? " · 업무 인계" : ""}
              {m.kind === "steering" ? " · 추가 지시" : ""}
            </span>
            <Markdown text={m.text} />
            <time>
              {new Date(m.createdAt).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
              {m.delivery === "sending"
                ? " · 전달 확인 중"
                : m.delivery === "unconfirmed"
                  ? " · 전달 여부 미확인 · 자동 재전송 안 함"
                  : m.delivery === "rejected"
                    ? " · 제공자 접수 거절"
                    : m.delivery === "next-task"
                      ? " · 다음 실행에 전달"
                      : m.delivery === "delivered"
                        ? " · 전달됨"
                        : ""}
            </time>
          </div>
        ))}
        <div ref={approvalStart}>
          <Approvals items={approvals} action={action} tasks={data.tasks} />
        </div>
        <div ref={bottom} />
      </div>
      {channel !== "team" && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSend || !recipient || !draft || busy) return;
            void action(
              canSteer
                ? `tasks/${selectedTask!.id}/steer`
                : canContinue
                  ? `tasks/${selectedTask.id}/continue`
                  : "tasks",
              {
                projectId,
                assignmentId: recipient.id,
                prompt: text,
                mode,
                channel,
                ...(canSteer
                  ? {
                      generation: selectedTask!.generation,
                      turnId: selectedTask!.providerTurnId,
                    }
                  : {}),
                ...(interrupted
                  ? { confirmResume: true, revision: selectedTask!.revision }
                  : {}),
              },
            )
              .then((result) => {
                finishDraft(key, draft);
                if (
                  !canContinue &&
                  !canSteer &&
                  activeDraftKey.current === key &&
                  !getDraft(key)
                )
                  setTaskId((result as Task).id);
              })
              .catch(() => {});
          }}
        >
          {resumable && matchingChannel && (
            <div className="resume-consent">
              이어서 진행하면 보존된 작업에서 재개합니다.
              <small>
                실행 {selectedTask.generation || 1}회차 · 변경 번호{" "}
                {selectedTask.revision}. 같은 업무·대화·작업 폴더를 유지하고
                현재 지침을 적용합니다. 이미 실행한 명령은 되돌리지 않으며,
                중단된 하위 업무는 자동 재개하지 않습니다.
              </small>
            </div>
          )}
          {!canContinue && !activeSelection && !interview && (
            <label className="request-mode">
              요청 방식
              <select
                aria-label="요청 방식"
                value={mode}
                onChange={(e) =>
                  setDraft(key, {
                    text,
                    mode: e.target.value as "direct" | "delegate",
                  })
                }
              >
                <option value="direct">이 직원에게 직접 요청</option>
                <option value="delegate">이 직원에게 PM 역할로 위임</option>
              </select>
            </label>
          )}
          <textarea
            ref={composer}
            aria-label="직원에게 업무 요청"
            placeholder={
              recipient
                ? `${recipient.settings.name}에게 어떤 일을 맡길까요?`
                : "먼저 직원을 배정해 주세요"
            }
            value={text}
            onChange={(e) => setDraft(key, { text: e.target.value, mode })}
            onKeyDown={(e) => {
              if (
                e.key !== "Enter" ||
                e.shiftKey ||
                e.ctrlKey ||
                e.altKey ||
                e.metaKey ||
                e.nativeEvent.isComposing ||
                e.nativeEvent.keyCode === 229
              )
                return;
              e.preventDefault();
              if (!e.repeat && canSend && text.trim() && !busy)
                e.currentTarget.form?.requestSubmit();
            }}
            disabled={
              !recipient ||
              !matchingChannel ||
              !!selectedTask?.executionUnconfirmed ||
              (interrupted && !resumable)
            }
            required
          />
          <small>Enter로 전송 · Shift+Enter로 줄바꿈</small>
          {!!text && (
            <div className="draft-note">
              <small>이 탭에 초안 보관 · 자동 전송하지 않음</small>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "이 대화의 입력 초안을 버릴까요? 이미 접수된 메시지와 업무는 취소되지 않습니다.",
                    )
                  )
                    setDraft(key, null);
                }}
              >
                초안 버리기
              </button>
            </div>
          )}
          <div>
            <small>
              {canSteer
                ? "현재 업무에 추가 지시 · 새 실행을 만들지 않음"
                : activeSelection
                  ? "현재 업무 · 상태 확인 후 추가 지시 가능"
                  : interview
                    ? "PM 인터뷰 · 저장 위치 확정 전에는 개발하지 않습니다"
                    : canContinue
                      ? "선택한 업무·작업 브랜치에서 대화 이어가기"
                      : mode === "delegate"
                        ? "PM이 계획·배정·인계를 진행합니다"
                        : "새 업무 · 격리된 작업 브랜치"}
            </small>
            <button
              className="primary"
              type="submit"
              disabled={!canSend || !text.trim() || busy}
              aria-label={
                canSteer
                  ? "현재 실행에 추가 지시 보내기"
                  : interrupted
                    ? "이어서 진행"
                    : "업무 요청 보내기"
              }
            >
              {interrupted ? "이어서 진행" : "↑"}
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}
function DocumentEditor({
  doc,
  action,
  environment,
  files = true,
}: {
  doc: Document;
  action: Action;
  environment?: string;
  files?: boolean;
}) {
  const key = draftKey("document", environment || "local", doc.id);
  const draft = useDrafts()[key];
  const [saving, setSaving] = useState(false);
  const [savedRevision, setSavedRevision] = useState(0);
  const content = draft?.text ?? doc.content;
  const revision = draft?.revision ?? doc.revision;
  const conflict = !!draft && draft.revision !== doc.revision;
  return (
    <article className="document-editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (saving || conflict || !draft) return;
          setSaving(true);
          void action(`documents/${doc.id}/edit`, {
            title: doc.title,
            content,
            revision,
          })
            .then((result) => {
              finishDraft(key, draft, (result as Document).revision);
              setSavedRevision((result as Document).revision);
            })
            .catch(() => {})
            .finally(() => setSaving(false));
        }}
      >
        <header>
          <h2>{doc.title}</h2>
          <span>이 프로젝트에만 적용 · 버전 {doc.revision}</span>
        </header>
        {doc.sourceWarning && (
          <p role="status">
            저장소 지침을 가져오지 못했습니다: {doc.sourceWarning}
          </p>
        )}
        {doc.knowledgeSource && (
          <p className="document-provenance">
            사용자가 선택한 공유 지식의 사본입니다. 이 문서의 편집은 현재
            프로젝트에만 적용되며 공유 원본이나 다른 프로젝트를 바꾸지 않습니다.
          </p>
        )}
        <textarea
          aria-label={doc.title}
          value={content}
          onChange={(e) => {
            setDraft(key, { text: e.target.value, revision });
          }}
          placeholder="팀에 알려줄 내용을 작성하세요."
        />
        {draft && (
          <div className="draft-note">
            <small>이 탭에 편집 초안 보관</small>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (
                  window.confirm(
                    "작성 중인 초안을 버리고 저장된 문서를 불러올까요?",
                  )
                )
                  setDraft(key, null);
              }}
            >
              초안 버리기
            </button>
          </div>
        )}
        {conflict && (
          <div className="document-conflict" role="status">
            <strong>
              다른 변경이 먼저 저장되었습니다. 작성 중인 내용은 유지했습니다.
            </strong>
            <details open>
              <summary>서버에 저장된 최신 내용</summary>
              <pre>{doc.content || "(비어 있음)"}</pre>
            </details>
            <div className="button-row">
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "작성 중인 내용 대신 서버의 최신 문서를 불러올까요?",
                    )
                  ) {
                    setDraft(key, null);
                  }
                }}
              >
                최신 문서 불러오기
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft(key, { text: content, revision: doc.revision })
                }
              >
                내 편집을 새 변경안으로 유지
              </button>
            </div>
          </div>
        )}
        <footer>
          <small>
            새 업무 요청·대화 재개부터 적용합니다. 기존 실행의 지침은
            유지합니다.
          </small>
          <button type="submit" disabled={conflict || saving || !draft}>
            {saving
              ? "저장 중…"
              : !draft && savedRevision === doc.revision
                ? "저장됨 ✓"
                : "변경 저장"}
          </button>
        </footer>
      </form>
      {files &&
        (doc.kind === "instructions" ||
          (!doc.kind && doc.title === "프로젝트 지침")) && (
          <InstructionFile
            doc={doc}
            action={action}
            environment={environment}
            dirty={!!draft}
          />
        )}
    </article>
  );
}
function IdeaWorkspace({
  project,
  data,
  action,
  onTask,
}: {
  project: Project;
  data: Snapshot;
  action: Action;
  onTask: (task: Task) => void;
}) {
  const [parent, setParent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const drafts = useDrafts();
  const unsaved = (data.documents || []).some(
    (doc) =>
      !!drafts[draftKey("document", project.environmentId || "local", doc.id)],
  );
  const documents = data.documents || [];
  const tasks = data.tasks || [];
  const pending =
    data.approvals?.filter((a) => a.status === "pending").length || 0;
  const running = tasks.some((t) =>
    ["queued", "running", "waiting", "coordinating"].includes(t.status),
  );
  const ready =
    documents.length >= 4 && documents.every((d) => d.content.trim());
  const last = [...tasks].reverse().find((t) => t.mode === "interview");
  return (
    <div className="idea-workspace">
      <section className="idea-summary">
        <span className="eyebrow">
          01 대화 → 02 문서·팀 확인 → 03 저장 위치
        </span>
        <h2>{project.name}</h2>
        <p>{documents.find((d) => d.title === "목표")?.content}</p>
        <p>
          실행 환경: {project.environmentLabel || "로컬"}. 아직 개발 저장소를
          만들지 않았습니다.
        </p>
        <button
          type="button"
          disabled={saving || running}
          onClick={() => {
            if (
              last &&
              ["review", "completed", "blocked", "failed"].includes(last.status)
            )
              return onTask(last);
            setSaving(true);
            setError("");
            void action("tasks", {
              projectId: project.id,
              assignmentId: project.pmAssignmentId,
              prompt: `다음 아이디어를 함께 구체화해 주세요. 필요한 질문부터 하고 목표·요구사항·프로젝트 지침·개발 계획과 팀을 제안해 주세요. 아직 구현은 하지 마세요.\n\n${documents.find((d) => d.title === "목표")?.content}`,
            })
              .then((task) => onTask(task as Task))
              .catch((e) => setError(e.message))
              .finally(() => setSaving(false));
          }}
        >
          {running
            ? "PM이 정리 중입니다"
            : last
              ? "PM 대화 이어가기"
              : "PM에게 아이디어 전달"}
        </button>
        <small>
          실제 Codex 실행 시 선택한 환경에 로그인한 계정의 사용량을 소비합니다.
        </small>
      </section>
      <section className="idea-summary">
        <h2>함께할 팀 · {data.assignments?.length || 0}명</h2>
        <p>
          {data.assignments
            ?.map((a) => `${a.settings.name} (${a.settings.role})`)
            .join(" · ")}
        </p>
        <p>
          PM이 제안한 신규 직원은 대화의 승인 카드에서 역할·모델·이유를 확인하고
          채용합니다.
        </p>
      </section>
      <div className="document-list">
        {documents.map((doc) => (
          <details key={doc.id} className="idea-document">
            <summary>
              {doc.title} · {doc.content.trim() ? "작성됨" : "정리 필요"} · 버전{" "}
              {doc.revision}
            </summary>
            <DocumentEditor
              doc={doc}
              action={action}
              environment={project.environmentId}
              files={false}
            />
          </details>
        ))}
      </div>
      <form
        className="idea-summary"
        onSubmit={(e) => {
          e.preventDefault();
          if (saving || running || pending > 0 || !ready || unsaved) return;
          setSaving(true);
          setError("");
          const values = fields(e.currentTarget);
          void action(`projects/${project.id}/activate`, {
            revision: project.revision,
            parent,
            folder: values.folder,
            confirm: true,
            documents: Object.fromEntries(
              documents.map((d) => [d.id, d.revision]),
            ),
            team: Object.fromEntries(
              (data.assignments || []).map((a) => [a.id, a.revision]),
            ),
          })
            .catch((e) => setError(e.message))
            .finally(() => setSaving(false));
        }}
      >
        <h2>준비되면 개발 공간 만들기</h2>
        {unsaved && (
          <p role="status">
            작성 중인 문서를 먼저 저장해 주세요. 저장 위치를 확정하면 회의실에서
            사무실로 이동합니다.
          </p>
        )}
        <p>
          문서와 팀을 확인한 뒤 새 Git 저장소를 만듭니다. 대화·문서·직원은
          유지되며 외부 공개나 개발 실행은 자동으로 하지 않습니다.
        </p>
        {(!ready || pending > 0 || running) && (
          <p role="status">
            {!ready ? "네 문서를 먼저 정리해 주세요. " : ""}
            {pending ? `검토할 제안 ${pending}개. ` : ""}
            {running ? "진행 중인 인터뷰가 있습니다." : ""}
          </p>
        )}
        <label>저장할 상위 폴더</label>
        <FolderPicker
          environment={project.environmentId}
          value={parent}
          onChange={setParent}
        />
        <label>
          새 폴더 이름
          <input
            required
            name="folder"
            placeholder="my-project"
            maxLength={80}
          />
        </label>
        <button
          className="primary"
          disabled={saving || running || pending > 0 || !ready || unsaved}
        >
          저장 위치 확정·개발 공간 열기
        </button>
      </form>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
function FolderPicker({
  value,
  onChange,
  environment = "local",
}: {
  value: string;
  onChange: (path: string) => void;
  environment?: string;
}) {
  const [listing, setListing] = useState<{
    path: string;
    parent: string;
    folders: { path: string; name: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const browse = (path: string) => {
    setError("");
    if (window.otter && environment === "local") {
      void window.otter
        .pickFolder()
        .then((selected) => {
          if (selected) onChange(selected);
        })
        .catch((e) => setError(e.message));
      return;
    }
    void api<NonNullable<typeof listing>>(
      "folders?path=" + encodeURIComponent(path),
      undefined,
      environment,
    )
      .then(setListing)
      .catch((e) => setError(e.message));
  };
  return (
    <div className="folder-picker">
      <div className="path-input">
        <input
          required
          aria-label="폴더 경로"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="폴더를 찾아 선택하세요"
        />
        <button type="button" onClick={() => browse(value)}>
          폴더 찾기
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {listing && (
        <div className="folder-list">
          <div>
            <button type="button" onClick={() => browse(listing.parent)}>
              ↑ 상위 폴더
            </button>
            <strong>{listing.path}</strong>
          </div>
          {listing.folders.map((f) => (
            <button type="button" key={f.path} onClick={() => browse(f.path)}>
              ▱ {f.name} <span>›</span>
            </button>
          ))}
          <button
            type="button"
            className="primary"
            onClick={() => {
              onChange(listing.path);
              setListing(null);
            }}
          >
            이 폴더 선택
          </button>
        </div>
      )}
    </div>
  );
}
function ProjectForm({
  data,
  action,
  done,
}: {
  data: Snapshot;
  action: Action;
  done: (id: string) => void;
}) {
  const [root, setRoot] = useState("");
  const [create, setCreate] = useState(false);
  const [ideaMode, setIdeaMode] = useState(false);
  const [pmId, setPmId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [environment, setEnvironment] = useState("local");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        const input = fields(e.currentTarget);
        setSaving(true);
        setError("");
        void (async () => {
          let id = companyId;
          if (!id) {
            const org = (await action("companies", {
              name: input.companyName,
              mode: input.mode,
            })) as { id: string };
            id = org.id;
            setCompanyId(id);
          }
          const project = (await action(
            ideaMode ? "projects/idea" : "projects",
            {
              companyId: id,
              root,
              create,
              parent: root,
              folder: input.folder,
              name: input.name,
              idea: input.idea,
              ...(ideaMode
                ? {
                    confirmPM: true,
                    employeeId: pmId,
                    pm: {
                      name: input.pmName,
                      model: input.pmModel,
                      instructions: input.pmInstructions,
                      skills: "",
                    },
                  }
                : {}),
            },
            environment,
          )) as { id: string };
          done(project.id);
        })()
          .catch((e) => setError(e.message))
          .finally(() => setSaving(false));
      }}
    >
      <fieldset className="creation-fields" disabled={saving}>
        <span className="eyebrow">LET’S BUILD SOMETHING</span>
        <h2 id="modal-title">프로젝트 시작하기</h2>
        <p>기존 저장소를 연결하거나, 새 아이디어의 자리를 만드세요.</p>
        <label>
          실행 환경
          <select
            value={environment}
            onChange={(event) => {
              setEnvironment(event.target.value);
              setRoot("");
            }}
          >
            <option value="local">이 컴퓨터 · 로컬</option>
            {(data.environments || []).map((item) => (
              <option key={item.id} value={item.id} disabled={!item.connected}>
                {item.name} · {item.kind.toUpperCase()}
                {item.connected ? "" : " (연결 필요)"}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          <button
            type="button"
            className={!create && !ideaMode ? "active" : ""}
            onClick={() => {
              setCreate(false);
              setIdeaMode(false);
            }}
          >
            기존 저장소
          </button>
          <button
            type="button"
            className={create ? "active" : ""}
            onClick={() => {
              setCreate(true);
              setIdeaMode(false);
            }}
          >
            새 프로젝트
          </button>
          <button
            type="button"
            className={ideaMode ? "active" : ""}
            onClick={() => {
              setIdeaMode(true);
              setCreate(false);
            }}
          >
            아이디어부터
          </button>
        </div>
        <label>
          회사
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            <option value="">새 회사 만들기</option>
            {data.companies
              .filter(
                (c) =>
                  c.mode === "group" ||
                  !data.projects.some(
                    (p) => p.companyId === c.id && !p.archived,
                  ),
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        {!companyId && (
          <div className="form-grid">
            <label>
              회사 이름
              <input name="companyName" required defaultValue="나의 스튜디오" />
            </label>
            <label>
              회사 구성
              <select name="mode">
                <option value="single">프로젝트 하나</option>
                <option value="group">프로젝트 묶음</option>
              </select>
            </label>
          </div>
        )}
        {!ideaMode && (
          <>
            <label>{create ? "저장할 상위 폴더" : "Git 저장소 폴더"}</label>
            <FolderPicker
              key={environment}
              value={root}
              onChange={setRoot}
              environment={environment}
            />
          </>
        )}
        {create && (
          <>
            <label>
              새 폴더 이름
              <input required name="folder" placeholder="my-project" />
            </label>
            <label>
              어떤 것을 만들고 싶나요?
              <textarea
                name="idea"
                placeholder="아이디어를 적어 두세요. 프로젝트 목표 문서에 저장됩니다."
              />
            </label>
          </>
        )}
        {ideaMode && (
          <>
            <label>
              어떤 것을 만들고 싶나요?
              <textarea
                name="idea"
                required
                maxLength={50000}
                placeholder="누구의 어떤 문제를 해결하고 싶나요? 아직 구체적이지 않아도 괜찮아요."
              />
            </label>
            <p>
              저장 위치는 PM과 정리한 뒤 선택합니다. 지금은 선택한 실행 환경에
              인터뷰 기록만 준비합니다.
            </p>
            <label>
              함께 정리할 PM
              <select value={pmId} onChange={(e) => setPmId(e.target.value)}>
                <option value="">새 기본 PM</option>
                {data.employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.role}
                  </option>
                ))}
              </select>
            </label>
            {!pmId ? (
              <>
                <label>
                  PM 이름
                  <input
                    name="pmName"
                    required
                    defaultValue="정리하는 PM"
                    maxLength={80}
                  />
                </label>
                <ModelPicker
                  name="pmModel"
                  label="PM 모델"
                  environment={environment}
                  environmentLabel={
                    data.environments?.find((item) => item.id === environment)
                      ?.name
                  }
                />
                <label>
                  PM 지침
                  <textarea
                    name="pmInstructions"
                    required
                    defaultValue="사용자의 아이디어를 짧은 질문으로 구체화한다. 목표·요구사항·지침·계획을 정리하고, 필요한 팀 구성을 이유와 함께 제안한다. 확인하지 않은 내용을 확정하지 않는다."
                  />
                </label>
              </>
            ) : (
              <p>
                {data.employees.find((e) => e.id === pmId)?.role} · 모델:{" "}
                {data.employees.find((e) => e.id === pmId)?.model ||
                  "설치된 Codex 기본값"}
              </p>
            )}
            <p>
              역할: 요구사항 정리와 팀 조율. 필요한 이유: 아이디어를 개발 가능한
              문서와 업무로 구체화합니다.
            </p>
            <p className="form-note">
              아래 버튼을 누르면 이 PM을 배정하고 회의실을 준비합니다. 실제 대화
              실행은 회의실에서 요청할 때 시작합니다.
            </p>
          </>
        )}
        <label>
          프로젝트 표시 이름
          <input
            name="name"
            required={ideaMode}
            placeholder={
              ideaMode ? "아이디어의 이름" : "비워두면 폴더 이름을 사용합니다"
            }
          />
        </label>
        <p className="form-note">
          {environment === "local"
            ? "로컬"
            : data.environments?.find((item) => item.id === environment)
                ?.name}{" "}
          환경 · 외부 저장소에 자동 공개하지 않습니다.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={saving}>
          {saving
            ? "준비 중…"
            : ideaMode
              ? "PM 배정하고 회의실 열기"
              : "프로젝트 열기"}
        </button>
      </fieldset>
    </form>
  );
}
function EmployeeForm({
  data,
  projectId,
  action,
  done,
}: {
  data: Snapshot;
  projectId: string;
  action: Action;
  done: () => void;
}) {
  const [existing, setExisting] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        const input = fields(e.currentTarget);
        setSaving(true);
        setError("");
        void (async () => {
          const employee = existing
            ? { id: existing }
            : ((await action("employees", input)) as { id: string });
          // 생성은 끝났다. 배정 실패 뒤에는 같은 직원을 사용하고 다시 만들지 않는다.
          if (!existing) {
            setExisting(employee.id);
            setCreatedId(employee.id);
          }
          await action("assignments", { projectId, employeeId: employee.id });
          done();
        })()
          .catch((e) => setError(e.message))
          .finally(() => setSaving(false));
      }}
    >
      <fieldset className="creation-fields" disabled={saving}>
        <span className="eyebrow">MEET YOUR NEXT TEAMMATE</span>
        <h2 id="modal-title">함께 일할 직원</h2>
        <label>
          직원 선택
          <select
            value={existing}
            onChange={(e) => setExisting(e.target.value)}
          >
            <option value="">새 직원 만들기</option>
            {existing &&
              !data.employees.some((employee) => employee.id === existing) && (
                <option value={existing}>방금 생성한 직원</option>
              )}
            {data.employees.map((e) => (
              <option value={e.id} key={e.id}>
                {e.name} · {e.role}
              </option>
            ))}
          </select>
        </label>
        {createdId && createdId === existing && (
          <p role="status" className="creation-notice">
            직원 생성은 완료됐습니다. 선택된 직원으로 배정만 다시 시도하세요.
            창을 닫아도 직원은 라이브러리에 보관됩니다.
          </p>
        )}
        {!existing && (
          <>
            <AvatarPicker />
            <div className="form-grid">
              <label>
                이름
                <input required name="name" placeholder="김코딩" />
              </label>
              <label>
                역할
                <input required name="role" placeholder="백엔드 개발" />
              </label>
            </div>
            <ModelPicker
              environment={
                data.projects.find((p) => p.id === projectId)?.environmentId
              }
              environmentLabel={
                data.projects.find((p) => p.id === projectId)?.environmentLabel
              }
            />
            <label>
              일하는 방식과 지침
              <textarea
                required
                name="instructions"
                defaultValue="요청한 범위에서 작업하고, 실제 테스트 결과와 미검증 항목을 구분해 한국어로 보고하세요."
              />
            </label>
            <label>
              스킬·전문 지식
              <textarea
                name="skills"
                placeholder="이 직원이 활용할 절차나 전문 지식을 적어 주세요."
              />
            </label>
          </>
        )}
        <p className="form-note">
          설정은 재사용하고, 이 프로젝트의 대화와 기억은 따로 유지합니다.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="primary wide"
          disabled={saving || !projectId}
        >
          {saving ? "배정 중…" : "이 프로젝트에 배정"}
        </button>
      </fieldset>
    </form>
  );
}
