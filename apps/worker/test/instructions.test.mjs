import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";
import { Cowork } from "../src/cowork.mjs";
import {
  Instructions,
  applyTaskInstructions,
  readInstruction,
} from "../src/instructions.mjs";
import { git, isolatedWorktree } from "../src/git.mjs";

test("지침의 자동 발견, 직원 변경 제안, 양방향 비교/충돌, 복구 원본과 작업 스냅샷", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-instructions-"));
  const root = join(directory, "project");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "AGENTS.md"), "일반 지침\n");
  await writeFile(join(root, "AGENTS.override.md"), "원본 우선 지침\n");
  await writeFile(join(root, "keep.txt"), "기존 사용자 작업");
  await git(root, ["add", "keep.txt"]);
  const store = new Store();
  const company = new Company(store);
  const files = new Instructions(store);
  try {
    const org = company.createCompany({ name: "회사", mode: "group" });
    const project = await company.addProject({ companyId: org.id, root });
    let doc = store
      .all("documents", project.id)
      .find((item) => item.kind === "instructions");
    assert.equal(doc.content, "원본 우선 지침\n");
    assert.equal(doc.fileSync.name, "AGENTS.override.md");
    assert.match((await files.preview(doc.id, "AGENTS.md")).warning, /우선/);
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "사용자 지침 준수",
    });
    const assignment = company.assign(project.id, employee.id);
    const first = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "첫 업무",
    });
    const cowork = new Cowork(company);
    const proposal = cowork.handle(first, "otter_propose_document", {
      documentId: doc.id,
      revision: doc.revision,
      content: "직원이 제안한 새 지침\n",
      reason: "사용자가 지침 반영을 요청함",
    });
    assert.equal(store.get("documents", doc.id).content, "원본 우선 지침\n");
    cowork.resolve(proposal.proposalId, { decision: "accept" });
    doc = store.get("documents", doc.id);
    assert.equal(doc.content, "직원이 제안한 새 지침\n");
    assert.equal(
      await readFile(join(root, "AGENTS.override.md"), "utf8"),
      "원본 우선 지침\n",
      "문서 승인만으로 원본 파일을 덮어쓰지 않는다",
    );
    const preview = await files.preview(doc.id, "AGENTS.override.md");
    await writeFile(join(root, "AGENTS.override.md"), "외부 IDE 변경\n");
    await assert.rejects(
      files.sync(
        doc.id,
        {
          name: preview.name,
          fileHash: preview.hash,
          revision: preview.revision,
        },
        "export",
      ),
      /원본 파일이 변경/,
    );
    assert.equal(
      await readFile(join(root, "AGENTS.override.md"), "utf8"),
      "외부 IDE 변경\n",
    );
    const reviewed = await files.preview(doc.id, "AGENTS.override.md");
    const saving = files.sync(
      doc.id,
      {
        name: reviewed.name,
        fileHash: reviewed.hash,
        revision: reviewed.revision,
      },
      "export",
    );
    assert.throws(
      () => company.editDocument(doc.id, { ...doc, content: "동시 문서 변경" }),
      /동기화/,
    );
    const saved = await saving;
    assert.equal(await readFile(saved.backupPath, "utf8"), "외부 IDE 변경\n");
    assert.equal(
      await readFile(join(root, "AGENTS.override.md"), "utf8"),
      "직원이 제안한 새 지침\n",
    );
    assert.equal(
      await git(root, ["diff", "--cached", "--name-only"]),
      "keep.txt",
    );
    await assert.rejects(git(root, ["rev-parse", "--verify", "HEAD"]));
    const oldSnapshot = first.documents.find(
      (item) => item.kind === "instructions",
    );
    assert.equal(oldSnapshot.content, "원본 우선 지침\n");
    await writeFile(
      join(root, "AGENTS.override.md"),
      "파일에서 다시 가져올 내용\n",
    );
    const importedPreview = await files.preview(doc.id, "AGENTS.override.md");
    const imported = await files.sync(
      doc.id,
      {
        name: importedPreview.name,
        fileHash: importedPreview.hash,
        revision: importedPreview.revision,
      },
      "import",
    );
    assert.equal(imported.document.content, "파일에서 다시 가져올 내용\n");
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "최신 지침으로 새 업무",
    });
    const worktree = await isolatedWorktree(
      root,
      join(directory, "worktree"),
      task.id,
    );
    store.update("tasks", task.id, { worktree });
    await applyTaskInstructions(task, worktree, store);
    assert.equal(
      await readFile(join(worktree.path, "AGENTS.override.md"), "utf8"),
      "파일에서 다시 가져올 내용\n",
    );
    await writeFile(
      join(worktree.path, "AGENTS.override.md"),
      "작업 브랜치에서 직접 수정함",
    );
    await assert.rejects(
      applyTaskInstructions(store.get("tasks", task.id), worktree, store),
      /작업 브랜치의 지침 파일이 변경/,
    );
    assert.equal(
      await readFile(join(worktree.path, "AGENTS.override.md"), "utf8"),
      "작업 브랜치에서 직접 수정함",
    );
    assert.equal(
      await readFile(join(root, "keep.txt"), "utf8"),
      "기존 사용자 작업",
    );
  } finally {
    store.close();
  }
});

test("지침 경로/링크/잘못된 UTF-8을 거부하고 임의 파일에 접근하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-instruction-path-"));
  const root = join(directory, "repo");
  await mkdir(root);
  const outside = join(directory, "private.txt");
  await writeFile(outside, "다른 파일");
  await assert.rejects(readInstruction(root, "../private.txt"), /지침 파일만/);
  await symlink(outside, join(root, "AGENTS.md"));
  await assert.rejects(readInstruction(root, "AGENTS.md"), /일반 파일/);
  assert.equal(await readFile(outside, "utf8"), "다른 파일");
  await writeFile(join(root, "AGENTS.override.md"), Buffer.from([255]));
  await assert.rejects(readInstruction(root, "AGENTS.override.md"), /UTF-8/);
  await writeFile(join(root, "AGENTS.override.md"), "\ufeffBOM이 있는 지침\n");
  assert.equal(
    (await readInstruction(root, "AGENTS.override.md")).content,
    "\ufeffBOM이 있는 지침\n",
    "동기화 시 UTF-8 BOM을 임의로 제거하지 않는다",
  );
});
