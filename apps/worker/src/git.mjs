import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, readdir, mkdir } from "node:fs/promises";
import { isAbsolute, dirname, basename, join } from "node:path";
import { DomainError, required } from "./store.mjs";

const exec = promisify(execFile);
export async function git(cwd, args, { trimOutput = true, onProcess } = {}) {
  const execution = exec("git", ["-C", cwd, ...args], {
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  const child = execution.child;
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const state = { pid: child.pid || null, closed: false };
  let recordingError;
  try {
    onProcess?.(state);
  } catch (error) {
    recordingError = error;
  }
  let result, failure;
  try {
    result = await execution;
  } catch (error) {
    failure = error;
  }
  const terminal = await closed;
  onProcess?.({ ...state, closed: true, ...terminal });
  if (recordingError) throw recordingError;
  if (failure) throw failure;
  const { stdout } = result;
  return trimOutput ? stdout.trim() : stdout;
}
export async function repository(path) {
  required(path, "저장소 경로");
  if (!isAbsolute(path)) throw new DomainError("절대 경로를 선택해 주세요.");
  const root = await realpath(path);
  try {
    const gitRoot = await realpath(
      await git(root, ["rev-parse", "--show-toplevel"]),
    );
    if (root !== gitRoot)
      throw new DomainError("저장소의 최상위 폴더를 선택해 주세요.");
    return {
      root,
      name: basename(root),
      branch: await git(root, ["branch", "--show-current"]),
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "Git 저장소가 아닙니다. 기존 저장소를 선택하거나 새 프로젝트를 만들어 주세요.",
    );
  }
}
export async function createRepository(parent, name) {
  required(name, "폴더 이름", 80);
  if (
    !/^[\p{L}\p{N}_. -]+$/u.test(name) ||
    name === "." ||
    name === ".." ||
    name.trim() !== name
  )
    throw new DomainError("경로 구분자 없이 폴더 이름만 입력해 주세요.");
  const base = await realpath(required(parent, "상위 폴더"));
  const root = join(base, name);
  // 기존 폴더는 빈 폴더여도 덮어쓰거나 자동 초기화하지 않는다.
  try {
    await mkdir(root);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new DomainError("같은 이름의 폴더가 이미 있습니다.", 409);
    throw error;
  }
  await git(root, ["init", "-b", "main"]);
  return { root, name, branch: "main" };
}
export async function browse(path) {
  const root = await realpath(required(path, "폴더 경로"));
  const entries = await readdir(root, { withFileTypes: true });
  return {
    path: root,
    parent: dirname(root),
    folders: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
const creatingRoots = new Map();
export async function isolatedWorktree(root, directory, taskId, base = "HEAD") {
  const previous = creatingRoots.get(root) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => createWorktree(root, directory, taskId, base));
  creatingRoots.set(root, current);
  try {
    return await current;
  } finally {
    if (creatingRoots.get(root) === current) creatingRoots.delete(root);
  }
}
async function createWorktree(root, directory, taskId, base = "HEAD") {
  const hooks = join(dirname(directory), "empty-hooks");
  await mkdir(hooks, { recursive: true });
  // 커밋이 없는 신규 저장소는 사용자 파일을 포함하지 않는 빈 최초 커밋을 만든다.
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    await git(root, [
      "-c",
      "user.name=Otter",
      "-c",
      "user.email=otter@localhost",
      "-c",
      `core.hooksPath=${hooks}`,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "--only",
      "-m",
      "Initialize Otter project",
    ]);
  }
  await mkdir(dirname(directory), { recursive: true });
  const branch = `otter/${taskId}`;
  await git(root, [
    "-c",
    `core.hooksPath=${hooks}`,
    "worktree",
    "add",
    "-b",
    branch,
    directory,
    base,
  ]);
  return {
    path: directory,
    branch,
    base: await git(directory, ["rev-parse", "HEAD"]),
  };
}

const identity = [
  "-c",
  "user.name=Otter",
  "-c",
  "user.email=otter@localhost",
  "-c",
  "commit.gpgSign=false",
];
export async function checkpoint(worktree, title) {
  const hooks = join(dirname(worktree.path), "empty-hooks");
  if (await git(worktree.path, ["ls-files", "--unmerged"]))
    throw new DomainError(
      "미해결 Git 충돌이 남아 있습니다. 해결 후 파일을 스테이징해 주세요.",
      409,
    );
  const merging = await git(worktree.path, [
    "rev-parse",
    "-q",
    "--verify",
    "MERGE_HEAD",
  ]).then(
    () => true,
    () => false,
  );
  await git(worktree.path, ["add", "--all"]);
  if (
    merging ||
    (await git(worktree.path, ["diff", "--cached", "--name-only"]))
  )
    await git(worktree.path, [
      ...identity,
      "-c",
      `core.hooksPath=${hooks}`,
      "commit",
      "-m",
      `Otter: ${title}`,
    ]);
  return git(worktree.path, ["rev-parse", "HEAD"]);
}
export async function integrate(worktree, commits) {
  const hooks = join(dirname(worktree.path), "empty-hooks");
  for (const commit of [...new Set(commits)]) {
    if (!/^[a-f0-9]{40,64}$/.test(commit))
      throw new DomainError("인계 커밋을 확인할 수 없습니다.");
    try {
      await git(worktree.path, [
        ...identity,
        "-c",
        `core.hooksPath=${hooks}`,
        "merge",
        "--no-edit",
        commit,
      ]);
    } catch {
      throw new DomainError(
        "업무 인계 중 Git 충돌이 발생했습니다. 격리된 작업 브랜치에 충돌 내용을 보존했습니다. 확인 후 이어서 요청해 주세요.",
        409,
      );
    }
  }
}
