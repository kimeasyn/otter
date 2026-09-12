import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { DomainError, required } from "./store.mjs";
import { editorTarget } from "./editor.mjs";
import { git } from "./git.mjs";

const oid = /^[a-f0-9]{40,64}$/;
const remoteName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const conflict = (message) => new DomainError(message, 409);
async function pushGit(root, args, trimOutput = true, onProcess) {
  try {
    return await git(
      root,
      [
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotePath=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.ssh.allow=always",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.file.allow=always",
        ...args,
      ],
      { trimOutput, onProcess },
    );
  } catch (error) {
    // Git stderr에는 인증 주소/토큰/서버 메시지가 들어갈 수 있다. UI/보고에 그대로 복사하지 않는다.
    const safe = conflict(
      "Git 명령을 완료하지 못했습니다. 실행 환경의 인증·접속·저장소 상태를 확인해 주세요.",
    );
    safe.gitCode = error.code;
    safe.gitRejected =
      args.includes("push") &&
      String(error.stdout || "")
        .split("\n")
        .some((line) => {
          const [flag, ref, summary] = line.split("\t");
          return (
            flag === "!" &&
            ref === args.at(-1) &&
            /^\[(?:remote )?rejected\]/.test(summary || "")
          );
        });
    throw safe;
  }
}
export function safePushURL(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 4096 ||
    /[\r\n\0]/.test(value)
  )
    throw conflict("푸시 주소 형식을 확인해 주세요.");
  if (isAbsolute(value)) return value;
  if (value.includes("://")) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw conflict("푸시 주소 형식을 확인해 주세요.");
    }
    if (
      !["ssh:", "https:", "file:"].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "ssh:" && url.username) ||
      (url.protocol === "file:" && url.hostname && url.hostname !== "localhost")
    )
      throw conflict(
        "인증 정보를 포함하지 않는 SSH/HTTPS 주소 또는 로컬 저장소 경로를 사용해 주세요.",
      );
    return value;
  }
  if (
    /^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*:[^:\r\n\0][^\r\n\0]*$/.test(
      value,
    ) &&
    !value.includes("::")
  )
    return value;
  throw conflict(
    "지원하지 않는 푸시 주소입니다. SSH/HTTPS 또는 로컬 절대 경로를 사용해 주세요.",
  );
}

export class ProjectPush {
  constructor(store, runner) {
    Object.assign(this, { store, runner });
  }
  async options(id) {
    const target = await editorTarget(this.store, this.runner, id);
    const names = (await pushGit(target.path, ["remote"]))
      .split("\n")
      .filter(Boolean);
    const remotes = [];
    for (const name of names) {
      try {
        remotes.push({ name, url: await this.destination(target.path, name) });
      } catch (error) {
        remotes.push({ name, error: error.message });
      }
    }
    return { path: target.path, branch: target.branch, remotes };
  }
  async destination(root, name) {
    if (!remoteName.test(name || ""))
      throw conflict(
        "등록된 원격 이름을 확인해 주세요. 영문·숫자·점·밑줄·하이픈을 지원합니다.",
      );
    const urls = (
      await pushGit(root, ["remote", "get-url", "--push", "--all", name], false)
    )
      .replace(/\r?\n$/, "")
      .split(/\r?\n/);
    if (urls.length !== 1)
      throw conflict(
        "여러 푸시 주소가 등록되어 있습니다. 단일 대상 원격을 사용해 주세요.",
      );
    const url = safePushURL(urls[0]);
    const vcs = await pushGit(root, [
      "config",
      "--get",
      `remote.${name}.vcs`,
    ]).catch((error) => {
      if (error.gitCode === 1) return "";
      throw error;
    });
    if (vcs)
      throw conflict("사용자 정의 원격 도우미는 외부 IDE에서 사용해 주세요.");
    await this.validateURL(root, url);
    return url;
  }
  async validateURL(root, value) {
    const url = safePushURL(value);
    if ((await pushGit(root, ["ls-remote", "--get-url", "--", url])) !== url)
      throw conflict(
        "주소 재작성으로 조회 대상이 달라집니다. 원격 설정을 확인해 주세요.",
      );
    const rewrites = await pushGit(root, [
      "config",
      "--null",
      "--get-regexp",
      "^url\\..*\\.pushinsteadof$",
    ]).catch((error) => {
      if (error.gitCode === 1) return "";
      throw error;
    });
    if (
      rewrites
        .split("\0")
        .filter(Boolean)
        .some((entry) => url.startsWith(entry.slice(entry.indexOf("\n") + 1)))
    )
      throw conflict(
        "주소 재작성으로 실제 전송 대상이 달라집니다. 원격 설정을 확인해 주세요.",
      );
    return url;
  }
  async remoteHead(root, url, ref) {
    const output = await pushGit(root, ["ls-remote", "--refs", "--", url, ref]);
    if (!output) return "";
    const lines = output.split("\n");
    const [commit, name] = lines[0].split("\t");
    if (lines.length !== 1 || name !== ref || !oid.test(commit))
      throw conflict("원격 브랜치 상태를 확정하지 못했습니다.");
    return commit;
  }
  async fetchHistory(root, url, commit) {
    if (!oid.test(commit)) throw conflict("조회할 원격 커밋을 확인해 주세요.");
    await this.validateURL(root, url);
    await pushGit(root, [
      "fetch",
      "--no-write-fetch-head",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-auto-maintenance",
      "--",
      url,
      commit,
    ]);
  }
  async preview(id, input) {
    const project = this.store.get("projects", id);
    if (
      project.push &&
      ["sending", "unconfirmed"].includes(project.push.status)
    )
      throw conflict(
        "이전 푸시 결과가 확인되지 않았습니다. 원격 상태와 요청 기록을 먼저 확인해 주세요. 자동 재전송하지 않습니다.",
      );
    if (this.store.hasUnconfirmedOperation(id))
      throw conflict("먼저 프로젝트의 미확인 Git/배포 결과를 확인해 주세요.");
    if (
      this.store
        .all("tasks", id)
        .some(
          (t) =>
            this.runner.active.has(t.id) ||
            t.executionUnconfirmed ||
            ["queued", "running", "waiting", "coordinating"].includes(t.status),
        )
    )
      throw conflict("프로젝트의 진행 중인 업무가 끝난 뒤 푸시해 주세요.");
    const target = await editorTarget(this.store, this.runner, id);
    if (!project.branch || target.branch !== project.branch)
      throw conflict("원본을 등록 당시 브랜치로 전환한 뒤 다시 확인해 주세요.");
    const grafts = await readFile(
      resolve(
        target.path,
        await pushGit(target.path, ["rev-parse", "--git-path", "info/grafts"]),
      ),
      "utf8",
    ).catch((error) => {
      if (error.code === "ENOENT") return "";
      throw conflict("Git 이력 설정을 확인하지 못했습니다.");
    });
    if (grafts.trim())
      throw conflict(
        "Git grafts로 변경한 이력이 있습니다. 실제 커밋 이력을 외부 IDE에서 확인해 주세요.",
      );
    if (
      await pushGit(target.path, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
    )
      throw conflict(
        "원본에 커밋하지 않은 변경이 있습니다. 이번 푸시에 포함되지 않으므로 먼저 정리해 주세요.",
      );
    const branch = required(input.branch, "대상 브랜치", 255);
    const ref = "refs/heads/" + branch;
    await pushGit(target.path, ["check-ref-format", ref]);
    const remote = required(input.remote, "원격", 100);
    const url = await this.destination(target.path, remote);
    if (input.expectedUrl && input.expectedUrl !== url)
      throw conflict(
        "승인한 푸시 주소가 변경됐습니다. 새 주소는 조회하거나 전송하지 않았습니다.",
      );
    const commit = await pushGit(target.path, ["rev-parse", "HEAD"]);
    if (!oid.test(commit)) throw conflict("전송할 커밋을 확인하지 못했습니다.");
    const expected = await this.remoteHead(target.path, url, ref);
    if (expected && expected !== commit) {
      const ancestor = await pushGit(target.path, [
        "merge-base",
        "--is-ancestor",
        expected,
        commit,
      ]).then(
        () => true,
        (error) => {
          if (error.gitCode === 1 || error.gitCode === 128) return false;
          throw error;
        },
      );
      if (!ancestor)
        throw conflict(
          "원격의 변경이 원본 이력에 포함되어 있지 않거나 아직 조회되지 않았습니다. 외부 IDE에서 fetch와 변경 통합 후 다시 확인하세요. 원격 이력을 덮어쓰지 않습니다.",
        );
    }
    const range = expected ? `${expected}..${commit}` : commit;
    const count = Number(
      await pushGit(target.path, ["rev-list", "--count", range]),
    );
    const summary = await pushGit(target.path, [
      "log",
      "--format=%h %s",
      "--max-count=30",
      range,
      "--",
    ]);
    const preview = {
      projectId: id,
      projectRevision: project.revision,
      path: target.path,
      sourceBranch: target.branch,
      remote,
      url,
      branch,
      ref,
      commit,
      expected,
      count,
      summary,
      alreadyPushed: expected === commit,
    };
    return {
      ...preview,
      approval: createHash("sha256")
        .update(JSON.stringify(preview))
        .digest("hex"),
    };
  }
  async apply(id, input, context = {}) {
    if (
      input.confirm !== true ||
      input.confirmAutomation !== true ||
      !/^[a-f0-9]{64}$/.test(input.approval || "")
    )
      throw new DomainError(
        "전송 내용과 원격 자동화 실행 가능성을 확인하고 승인해 주세요.",
      );
    if (this.store.projectLocks.has(id) && !context.lockHeld)
      throw conflict(
        "프로젝트를 변경하는 중입니다. 완료 후 다시 시도해 주세요.",
      );
    if (!context.lockHeld) this.store.projectLocks.add(id);
    try {
      const preview = await this.preview(id, input);
      context.authorize?.();
      if (preview.approval !== input.approval)
        throw conflict(
          "확인 이후 원본·원격 또는 프로젝트가 바뀌었습니다. 최신 내용을 다시 확인해 주세요.",
        );
      if (preview.alreadyPushed)
        return {
          alreadyPushed: true,
          commit: preview.commit,
          branch: preview.branch,
        };
      const push = {
        status: "sending",
        path: preview.path,
        remote: preview.remote,
        url: preview.url,
        branch: preview.branch,
        commit: preview.commit,
        expected: preview.expected,
        approvedAt: new Date().toISOString(),
        ...(context.policyId
          ? { policyId: context.policyId, taskId: context.taskId }
          : {}),
      };
      this.store.update("projects", id, { push });
      try {
        // 명시적 조상 검사로 fast-forward만 허용한다. lease는 강제 덮어쓰기가 아니라
        // 사전 확인 이후 원격이 바뀌는 경쟁을 막기 위해 정확한 기존 OID와 함께 사용한다.
        await pushGit(
          preview.path,
          [
            "-c",
            `remote.${preview.remote}.mirror=false`,
            "-c",
            "push.followTags=false",
            "-c",
            "push.autoSetupRemote=false",
            "-c",
            "push.pushOption=",
            "push",
            "--porcelain",
            "--no-verify",
            "--signed=false",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--receive-pack=git-receive-pack",
            `--force-with-lease=${preview.ref}:${preview.expected}`,
            "--",
            preview.url,
            `${preview.commit}:${preview.ref}`,
          ],
          true,
          (process) => {
            push.process = process;
            this.store.update("projects", id, { push });
          },
        );
        if (
          (await this.destination(preview.path, preview.remote)) !==
            preview.url ||
          (await this.remoteHead(preview.path, preview.url, preview.ref)) !==
            preview.commit
        )
          throw conflict("푸시 이후 대상 상태가 달라졌습니다.");
      } catch (error) {
        this.store.update("projects", id, {
          push: {
            ...push,
            status: "unconfirmed",
            rejected: error.gitRejected === true,
          },
        });
        throw conflict(
          "푸시 성공 여부를 확정하지 못했습니다. 자동 재전송하지 않았습니다. 원격 저장소의 브랜치와 전송 커밋을 확인해 주세요.",
        );
      }
      this.store.transaction(() => {
        this.store.update("projects", id, {
          push: {
            ...push,
            status: "pushed",
            pushedAt: new Date().toISOString(),
          },
        });
        this.store.insert("reports", {
          projectId: id,
          kind: "push",
          title: "원격 푸시 확인",
          text: `${preview.remote} (${preview.url})의 ${preview.branch}에 ${preview.commit} 전송을 확인했습니다.\n별도 배포 명령은 실행하지 않았습니다. 서버 CI/CD·자동화 결과는 원격 서비스에서 확인하세요.`,
        });
      });
      return {
        alreadyPushed: false,
        branch: preview.branch,
        commit: preview.commit,
      };
    } finally {
      if (!context.lockHeld) this.store.projectLocks.delete(id);
    }
  }
}
