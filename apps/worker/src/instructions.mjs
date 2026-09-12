import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  lstat,
  realpath,
  mkdir,
  rename,
  link,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DomainError } from "./store.mjs";
import { git } from "./git.mjs";

const names = ["AGENTS.md", "AGENTS.override.md"];
const hash = (content) => createHash("sha256").update(content).digest("hex");
const isInstruction = (document) =>
  document.kind === "instructions" ||
  (!document.kind && document.title === "프로젝트 지침");
const checkName = (name) => {
  if (!names.includes(name))
    throw new DomainError("프로젝트 루트의 지침 파일만 선택할 수 있습니다.");
  return name;
};

export async function readInstruction(root, name) {
  if ((await realpath(root)) !== resolve(root))
    throw new DomainError(
      "프로젝트 폴더가 다른 위치로 연결되었습니다. 실행 환경을 확인해 주세요.",
      409,
    );
  return readTextFile(join(root, checkName(name)), name);
}
async function readTextFile(path, name) {
  let file;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new DomainError("지침 파일은 링크가 아닌 일반 파일이어야 합니다.");
    if (stat.size > 200000)
      throw new DomainError("지침 파일은 200,000바이트 이하여야 합니다.");
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new DomainError(
        "읽는 동안 파일이 변경되었습니다. 다시 확인해 주세요.",
        409,
      );
    const buffer = Buffer.alloc(200001);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > 200000) throw new DomainError("지침 파일이 너무 큽니다.");
    let content;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new DomainError("UTF-8 텍스트 지침 파일만 지원합니다.");
    }
    return {
      name,
      path,
      exists: true,
      content,
      hash: hash(buffer.subarray(0, bytesRead)),
      bytes: bytesRead,
      mode: opened.mode & 0o777,
    };
  } catch (error) {
    if (error.code === "ENOENT")
      return {
        name,
        path,
        exists: false,
        content: "",
        hash: null,
        bytes: 0,
        mode: 0o644,
      };
    throw error;
  } finally {
    await file?.close();
  }
}

export async function initialInstructions(root) {
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const source = await readInstruction(root, name);
    if (source.exists && source.content.trim())
      return {
        content: source.content,
        fileSync: { name, hash: source.hash, content: source.content },
      };
  }
  return { content: "" };
}

async function writeInstruction(root, file, content) {
  if (Buffer.byteLength(content) > 200000)
    throw new DomainError(
      "파일로 저장할 지침은 200,000바이트 이하여야 합니다.",
    );
  const directory = await git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "otter-instruction-backups",
  ]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== resolve(directory))
    throw new DomainError("복구 폴더의 심볼릭 링크는 지원하지 않습니다.");
  const backup = join(directory, randomUUID() + "." + file.name);
  const staged = join(directory, randomUUID() + ".new");
  const stage = await open(staged, "wx", file.mode);
  let moved = false,
    published = false;
  try {
    try {
      await stage.writeFile(content);
      await stage.sync();
    } finally {
      await stage.close();
    }
    if (file.exists) {
      await rename(file.path, backup);
      moved = true;
      if ((await readTextFile(backup, file.name)).hash !== file.hash)
        throw new DomainError(
          "파일이 동시에 변경되어 저장을 중단했습니다.",
          409,
        );
    }
    // Exclusive publication: never overwrite a file recreated by another editor.
    await link(staged, file.path);
    published = true;
    return { path: file.path, backupPath: moved ? backup : null };
  } catch (error) {
    if (moved && !published) {
      try {
        await link(backup, file.path);
        await unlink(backup);
        moved = false;
      } catch {}
    }
    throw new DomainError(
      (error instanceof DomainError
        ? error.message
        : "파일 저장을 완료하지 못했습니다. 기존 파일은 덮어쓰지 않았습니다.") +
        (moved ? " 복구 파일: " + backup : ""),
      409,
    );
  } finally {
    await unlink(staged).catch(() => {});
  }
}

export class Instructions {
  constructor(store) {
    this.store = store;
    this.files = new Set();
  }
  document(id) {
    const document = this.store.get("documents", id);
    if (!isInstruction(document))
      throw new DomainError(
        "프로젝트 지침 문서에서 파일 연결을 사용해 주세요.",
      );
    const project = this.store.get("projects", document.projectId);
    if (this.store.hasUnconfirmedOperation(project.id))
      throw new DomainError(
        "먼저 프로젝트의 미확인 Git/배포 결과를 확인해 주세요.",
        409,
      );
    if (project.stage === "idea" || this.store.projectLocks.has(project.id))
      throw new DomainError(
        "저장 위치를 확정한 뒤 저장소 지침 파일을 연결해 주세요.",
        409,
      );
    if (project.archived)
      throw new DomainError("보관한 프로젝트를 먼저 복원해 주세요.");
    return { document, project };
  }
  async preview(id, name = "AGENTS.md") {
    const { document, project } = this.document(id);
    const file = await readInstruction(project.root, name);
    const override = await readInstruction(project.root, "AGENTS.override.md");
    return {
      documentId: id,
      revision: document.revision,
      documentContent: document.content,
      ...file,
      warning:
        name === "AGENTS.md" && override.content.trim()
          ? "AGENTS.override.md가 있어 Codex는 해당 파일을 우선합니다."
          : file.bytes > 32768
            ? "Codex 기본 지침 읽기 한도를 넘을 수 있습니다. 내용과 실행 설정을 확인해 주세요."
            : null,
      state:
        file.content === document.content && file.exists
          ? "same"
          : document.fileSync?.name === name &&
              document.fileSync.hash !== file.hash
            ? "file-changed"
            : "different",
    };
  }
  async sync(id, input, direction) {
    const { document, project } = this.document(id);
    checkName(input.name);
    if (document.revision !== input.revision)
      throw new DomainError(
        "문서가 변경되었습니다. 새 차이를 확인해 주세요.",
        409,
      );
    const key = project.root + "/" + input.name;
    if (this.files.has(key) || this.store.documentLocks.has(id))
      throw new DomainError("지침 파일 변경을 처리하는 중입니다.", 409);
    this.files.add(key);
    this.store.documentLocks.add(id);
    try {
      const file = await readInstruction(project.root, input.name);
      if (file.hash !== input.fileHash)
        throw new DomainError(
          "원본 파일이 변경되었습니다. 새 차이를 확인해 주세요.",
          409,
        );
      if (direction === "import") {
        if (!file.exists)
          throw new DomainError("가져올 지침 파일이 없습니다.", 404);
        return {
          document: this.store.update(
            "documents",
            id,
            {
              content: file.content,
              kind: "instructions",
              fileSync: {
                name: input.name,
                hash: file.hash,
                content: file.content,
              },
            },
            input.revision,
          ),
        };
      }
      const written = await writeInstruction(
        project.root,
        file,
        document.content,
      );
      const result = this.store.update(
        "documents",
        id,
        {
          kind: "instructions",
          fileSync: {
            name: input.name,
            hash: hash(document.content),
            content: document.content,
          },
          lastFileBackup: written.backupPath,
        },
        input.revision,
      );
      return { document: result, ...written };
    } finally {
      this.files.delete(key);
      this.store.documentLocks.delete(id);
    }
  }
}

export async function applyTaskInstructions(task, worktree, store) {
  const document = task.documents.find((item) => item.fileSync?.name);
  if (!document) return;
  const name = checkName(document.fileSync.name);
  const current = await readInstruction(worktree.path, name);
  const previous = task.appliedInstructions;
  if (
    previous &&
    (previous.name !== name || previous.hash !== current.hash) &&
    current.content !== document.content
  )
    throw new DomainError(
      "작업 브랜치의 지침 파일이 변경되었습니다. 파일을 보존했으니 확인한 뒤 다시 요청해 주세요.",
      409,
    );
  if (task.worktree && !previous && current.content !== document.content)
    throw new DomainError(
      "기존 작업 브랜치의 지침을 자동 교체하지 않습니다. 내용을 확인해 주세요.",
      409,
    );
  if (current.content !== document.content || !current.exists) {
    await writeInstruction(worktree.path, current, document.content);
  }
  store.update("tasks", task.id, {
    appliedInstructions: { name, hash: hash(document.content) },
  });
}
