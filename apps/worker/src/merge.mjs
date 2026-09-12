import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DomainError } from "./store.mjs";
import { editorTarget } from "./editor.mjs";
import { git } from "./git.mjs";

const oid = /^[a-f0-9]{40,64}$/;
const checkedGit = (root, args, options) =>
  git(
    root,
    ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args],
    options,
  );
const conflict = (message) => new DomainError(message, 409);

export class ResultMerge {
  constructor(store, runner, directory) {
    Object.assign(this, { store, runner, directory });
  }
  async preview(id) {
    const task = this.store.get("tasks", id);
    const project = this.store.get("projects", task.projectId);
    if (
      task.parentTaskId ||
      task.mode === "interview" ||
      !task.worktree ||
      !["review", "completed"].includes(task.status) ||
      !oid.test(task.resultCommit || "")
    )
      throw conflict("검토 가능한 최종 업무 결과만 원본에 반영할 수 있습니다.");
    if (task.merge && !["merged", "not-applied"].includes(task.merge.status))
      throw conflict(
        "이전 반영의 종료를 확인하지 못했습니다. 원본과 반영 기록을 외부 IDE에서 확인해 주세요.",
      );
    if (this.store.hasUnconfirmedOperation(project.id))
      throw conflict("먼저 프로젝트의 미확인 Git/배포 결과를 확인해 주세요.");
    if (
      this.store
        .all("tasks", project.id)
        .some(
          (t) =>
            this.runner.active.has(t.id) ||
            t.executionUnconfirmed ||
            ["queued", "running", "waiting", "coordinating"].includes(t.status),
        )
    )
      throw conflict("이 프로젝트의 진행 중인 업무가 끝난 뒤 반영해 주세요.");
    const target = await editorTarget(this.store, this.runner, project.id);
    const source = await editorTarget(this.store, this.runner, project.id, id);
    if (!project.branch || target.branch !== project.branch)
      throw conflict(
        `원본을 등록 당시 브랜치(${project.branch || "없음"})로 전환한 뒤 확인해 주세요. 자동 전환하지 않습니다.`,
      );
    if (
      source.branch !== task.worktree.branch ||
      (await checkedGit(source.path, ["rev-parse", "HEAD"])) !==
        task.resultCommit
    )
      throw conflict(
        "직원 작업 브랜치가 보고한 결과와 달라졌습니다. 결과를 다시 검토해 주세요.",
      );
    // 조회 단계에서 사용자 정의 병합 드라이버/필터를 실행하지 않는다.
    const drivers = await checkedGit(target.path, [
      "config",
      "--get-regexp",
      "^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process))$",
    ]).catch((error) => {
      if (error.code === 1) return "";
      throw error;
    });
    if (drivers)
      throw conflict(
        "사용자 정의 Git 병합 드라이버/파일 필터가 있습니다. 이 저장소는 외부 IDE에서 반영해 주세요.",
      );
    for (const path of [target.path, source.path]) {
      if (
        await checkedGit(path, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ])
      )
        throw conflict(
          "원본 또는 직원 작업 폴더에 커밋하지 않은 변경이 있습니다. 파일을 보존하며 반영을 중단합니다.",
        );
      for (const ref of [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "REBASE_HEAD",
      ]) {
        const exists = await checkedGit(path, [
          "rev-parse",
          "--verify",
          "-q",
          ref,
        ]).then(
          () => true,
          (error) => {
            if (error.code === 1) return false;
            throw error;
          },
        );
        if (exists)
          throw conflict(
            "진행 중인 Git 작업을 외부 IDE에서 먼저 마무리해 주세요.",
          );
      }
    }
    const base = await checkedGit(target.path, ["rev-parse", "HEAD"]);
    const alreadyMerged = await checkedGit(target.path, [
      "merge-base",
      "--is-ancestor",
      task.resultCommit,
      base,
    ]).then(
      () => true,
      (error) => {
        if (error.code === 1) return false;
        throw error;
      },
    );
    let tree;
    try {
      tree = await checkedGit(target.path, [
        "merge-tree",
        "--write-tree",
        base,
        task.resultCommit,
      ]);
    } catch (error) {
      if (error.code === 1)
        throw conflict(
          "원본과 직원 결과에 Git 충돌이 있습니다. 원본 파일은 변경하지 않았습니다. 직원에게 원본 변경을 작업 브랜치에 통합하고 충돌을 해결하도록 요청한 뒤 다시 검토해 주세요.",
        );
      throw conflict(
        "병합 사전 검사를 수행하지 못했습니다. Git 2.38 이상과 저장소 상태를 확인해 주세요.",
      );
    }
    if (!oid.test(tree))
      throw conflict("병합 결과 트리를 확인하지 못했습니다.");
    const summary = await checkedGit(target.path, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--stat",
      base,
      tree,
      "--",
    ]);
    const preview = {
      taskId: id,
      projectId: project.id,
      revision: task.revision,
      projectRevision: project.revision,
      path: target.path,
      branch: target.branch,
      sourceBranch: source.branch,
      base,
      resultCommit: task.resultCommit,
      tree,
      alreadyMerged,
      summary,
    };
    return {
      ...preview,
      approval: createHash("sha256")
        .update(JSON.stringify(preview))
        .digest("hex"),
    };
  }
  async apply(id, input, context = {}) {
    if (input.confirm !== true || !/^[a-f0-9]{64}$/.test(input.approval || ""))
      throw new DomainError("변경 내용을 확인하고 원본 반영을 승인해 주세요.");
    const projectId = this.store.get("tasks", id).projectId;
    if (this.store.projectLocks.has(projectId) && !context.lockHeld)
      throw conflict(
        "프로젝트를 변경하는 중입니다. 잠시 후 다시 확인해 주세요.",
      );
    if (!context.lockHeld) this.store.projectLocks.add(projectId);
    try {
      const preview = await this.preview(id);
      context.authorize?.();
      if (input.approval !== preview.approval)
        throw conflict(
          "확인 이후 업무 또는 원본이 바뀌었습니다. 최신 변경 내용을 다시 확인해 주세요.",
        );
      if (preview.alreadyMerged)
        return {
          alreadyMerged: true,
          branch: preview.branch,
          commit: preview.base,
        };
      const hooks = join(this.directory, "merge-empty-hooks");
      await mkdir(hooks, { recursive: true });
      const options = [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Otter",
        "-c",
        "user.email=otter@localhost",
      ];
      // 승인한 두 커밋/트리로 결과를 고정한다. 원본에서는 충돌 병합을 재실행하지 않는다.
      const commit = await checkedGit(preview.path, [
        ...options,
        "commit-tree",
        preview.tree,
        "-p",
        preview.base,
        "-p",
        preview.resultCommit,
        "-m",
        `Otter: integrate task ${id}`,
      ]);
      if (!oid.test(commit)) throw conflict("반영 커밋을 만들지 못했습니다.");
      const current = await this.preview(id);
      context.authorize?.();
      if (current.approval !== preview.approval)
        throw conflict(
          "반영 직전에 저장소가 바뀌었습니다. 원본을 변경하지 않고 중단했습니다.",
        );
      const merge = {
        status: "applying",
        path: preview.path,
        branch: preview.branch,
        base: preview.base,
        resultCommit: preview.resultCommit,
        commit,
        approvedAt: new Date().toISOString(),
        ...(context.policyId ? { policyId: context.policyId } : {}),
      };
      this.store.update("tasks", id, { merge });
      try {
        await checkedGit(
          preview.path,
          [
            ...options,
            "-c",
            "merge.autoStash=false",
            "merge",
            "--ff-only",
            "--no-edit",
            "--no-overwrite-ignore",
            commit,
          ],
          {
            onProcess: (process) => {
              merge.process = process;
              this.store.update("tasks", id, { merge });
            },
          },
        );
        if (
          (await checkedGit(preview.path, ["rev-parse", "HEAD"])) !== commit ||
          (await checkedGit(preview.path, ["branch", "--show-current"])) !==
            preview.branch ||
          (await checkedGit(preview.path, [
            "status",
            "--porcelain",
            "--untracked-files=all",
          ]))
        )
          throw conflict("반영 이후 원본 상태가 달라졌습니다.");
      } catch {
        this.store.update("tasks", id, {
          merge: { ...merge, status: "unconfirmed" },
        });
        throw conflict(
          "Git 반영 결과를 확정하지 못했습니다. 파일을 되돌리거나 재실행하지 않았습니다. 외부 IDE에서 원본과 반영 커밋을 확인해 주세요.",
        );
      }
      this.store.transaction(() => {
        this.store.update("tasks", id, {
          merge: {
            ...merge,
            status: "merged",
            mergedAt: new Date().toISOString(),
          },
        });
        this.store.insert("reports", {
          projectId,
          taskId: id,
          kind: "merge",
          title: "원본 반영 완료",
          text: `${preview.branch}에 승인한 직원 결과를 반영했습니다.\n결과: ${preview.resultCommit}\n반영: ${commit}\n푸시·배포와 병합 결과의 추가 테스트는 수행하지 않았습니다.`,
        });
      });
      return { branch: preview.branch, commit, alreadyMerged: false };
    } finally {
      if (!context.lockHeld) this.store.projectLocks.delete(projectId);
    }
  }
}
