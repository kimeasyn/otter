import { realpath } from "node:fs/promises";
import { resolve, isAbsolute, win32 } from "node:path";
import { DomainError, required } from "./store.mjs";
import { repository, git } from "./git.mjs";

export async function editorTarget(store, runner, projectId, taskId) {
  const project = store.get("projects", required(projectId, "프로젝트"));
  if (project.archived || project.stage === "idea")
    throw new DomainError("개발 공간이 있는 프로젝트를 먼저 열어 주세요.", 409);
  const task = taskId ? store.get("tasks", taskId) : null;
  if (task && task.projectId !== project.id)
    throw new DomainError("다른 프로젝트의 작업 폴더는 열지 않습니다.", 403);
  if (task && (!task.worktree || task.mode === "interview"))
    throw new DomainError("아직 개발용 작업 폴더가 없습니다.", 409);
  const path = task ? task.worktree.path : project.root;
  if ((await realpath(path)) !== resolve(path))
    throw new DomainError(
      "등록한 폴더가 다른 경로로 연결되었습니다. 경로를 확인해 주세요.",
      409,
    );
  const repo = await repository(path);
  if (task) {
    const common = async (root) =>
      realpath(
        resolve(root, await git(root, ["rev-parse", "--git-common-dir"])),
      );
    if ((await common(repo.root)) !== (await common(project.root)))
      throw new DomainError("작업 폴더가 다른 저장소를 가리킵니다.", 409);
  }
  return {
    projectId: project.id,
    taskId: task?.id,
    projectName: project.name,
    path: repo.root,
    branch: repo.branch,
    expectedBranch: task?.worktree.branch,
    active: task
      ? runner.active.has(task.id) || !!task.executionUnconfirmed
      : store
          .all("tasks", project.id)
          .some(
            (item) => runner.active.has(item.id) || item.executionUnconfirmed,
          ),
  };
}

export function editorArguments(
  path,
  environment,
  sshHost,
  platform = process.platform,
) {
  if (
    typeof path !== "string" ||
    /[\r\n\0]/.test(path) ||
    !(environment
      ? path.startsWith("/")
      : platform === "win32"
        ? win32.isAbsolute(path)
        : isAbsolute(path))
  )
    throw new DomainError("IDE에서 열 절대 경로를 확인해 주세요.");
  let authority;
  if (environment?.kind === "ssh") {
    if (
      typeof sshHost !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/.test(sshHost)
    )
      throw new DomainError("VS Code에 등록한 SSH Host 별칭을 입력해 주세요.");
    authority = "ssh-remote+" + sshHost;
  } else if (environment?.kind === "wsl") {
    if (platform !== "win32")
      throw new DomainError("WSL 폴더는 Windows 앱의 VS Code로 열어 주세요.");
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,119}$/.test(
        environment.distribution || "",
      )
    )
      throw new DomainError("WSL 배포판 이름을 확인해 주세요.");
    authority = "wsl+" + environment.distribution;
  } else if (environment)
    throw new DomainError("지원하지 않는 실행 환경입니다.");
  return ["--new-window", ...(authority ? ["--remote", authority] : []), path];
}

export async function editorRequest(
  { store, runner, environments },
  input,
  platform = process.platform,
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DomainError("IDE 열기 요청을 확인해 주세요.");
  const environmentId =
    input.environmentId == null
      ? "local"
      : required(input.environmentId, "실행 환경");
  const projectId = required(input.projectId, "프로젝트");
  const taskId =
    input.taskId == null || input.taskId === ""
      ? undefined
      : required(input.taskId, "업무");
  let target;
  let environment;
  if (environmentId === "local")
    target = await editorTarget(store, runner, projectId, taskId);
  else {
    environment = store.get("environments", environmentId);
    const project = environments
      .projects()
      .find((p) => p.id === projectId && p.environmentId === environmentId);
    if (!project)
      throw new DomainError("선택한 환경의 프로젝트가 아닙니다.", 403);
    const response = await environments.forward(
      environmentId,
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/editor` +
        (taskId ? "?taskId=" + encodeURIComponent(taskId) : ""),
    );
    if (response.status !== 200)
      throw new DomainError(
        response.data.error || "원격 작업 폴더를 확인하지 못했습니다.",
        response.status,
      );
    target = response.data;
    if (target.projectId !== projectId || target.taskId !== taskId)
      throw new DomainError("원격 작업 대상이 일치하지 않습니다.", 409);
  }
  return {
    ...target,
    environmentId,
    environmentName: environment?.name || "로컬",
    platform,
    args: editorArguments(target.path, environment, input.sshHost, platform),
  };
}
