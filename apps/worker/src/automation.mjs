import { createHash, randomUUID } from "node:crypto";
import { DomainError, choice } from "./store.mjs";
import { editorTarget } from "./editor.mjs";
import { ResultMerge } from "./merge.mjs";
import { ProjectPush } from "./push.mjs";
import { git } from "./git.mjs";
import { deploymentCommand } from "./deployment.mjs";

const conflict = (message) => new DomainError(message, 409);
const waiting = ["queued", "running", "waiting", "coordinating"];

export class Automation {
  constructor(store, runner, directory, deployment) {
    Object.assign(this, { store, runner, directory, deployment });
    this.running = new Map();
    for (const task of store
      .all("tasks")
      .filter((t) => t.automation?.status === "running"))
      this.result(
        task,
        "blocked",
        "실행부가 재시작되어 자동 반영의 완료를 확인하지 못했습니다. Git/배포 결과를 확인한 뒤 수동으로 마무리해 주세요.",
      );
  }
  async preview(id, input) {
    const project = this.store.get("projects", id);
    const merge = choice(input.merge, ["approval", "auto"], "원본 반영 방식");
    const push = choice(input.push, ["approval", "auto"], "푸시 방식");
    const deploy = choice(
      input.deploy ?? "approval",
      ["approval", "auto"],
      "배포 방식",
    );
    const target = await editorTarget(this.store, this.runner, id);
    if (!project.branch || target.branch !== project.branch)
      throw conflict("등록 당시 원본 브랜치에서 자동화를 설정해 주세요.");
    let destination = null;
    if (push === "auto") {
      const service = new ProjectPush(this.store, this.runner);
      const options = await service.options(id);
      const remote = options.remotes.find(
        (r) => r.name === input.remote && r.url,
      );
      if (!remote)
        throw conflict("안전하게 확인할 수 있는 등록 원격을 선택해 주세요.");
      if (typeof input.branch !== "string" || input.branch.length > 255)
        throw conflict("원격 브랜치를 입력해 주세요.");
      await git(target.path, [
        "check-ref-format",
        "refs/heads/" + input.branch,
      ]);
      destination = {
        remote: remote.name,
        url: remote.url,
        branch: input.branch,
      };
    }
    const deployment =
      deploy === "auto" ? await deploymentCommand(input.deployment) : null;
    const current = this.store.get("projects", id);
    if (current.revision !== project.revision)
      throw conflict("프로젝트가 변경됐습니다. 다시 확인해 주세요.");
    const preview = {
      projectId: id,
      revision: project.revision,
      root: target.path,
      sourceBranch: target.branch,
      merge,
      push,
      deploy,
      deployment,
      destination,
    };
    return {
      ...preview,
      approval: createHash("sha256")
        .update(JSON.stringify(preview))
        .digest("hex"),
    };
  }
  async configure(id, input) {
    const project = this.store.get("projects", id);
    // 해제는 진행 중이어도 허용한다. 이미 시작한 Git/배포 명령을 되돌리지는 않는다.
    if (input.disable === true) {
      if (input.revision !== project.revision)
        throw conflict("최신 설정을 불러온 뒤 자동화를 해제해 주세요.");
      return this.savePolicy(id, null, input.revision);
    }
    if (this.store.projectLocks.has(id))
      throw conflict("프로젝트 변경이 끝난 뒤 자동화를 설정해 주세요.");
    const preview = await this.preview(id, input);
    if (
      input.approval !== preview.approval ||
      input.confirm !== true ||
      (preview.push === "auto" && input.confirmRemote !== true) ||
      (preview.deploy === "auto" && input.confirmDeployment !== true)
    )
      throw conflict(
        "적용 범위와 원격 자동화·비용 가능성을 확인하고 승인해 주세요.",
      );
    if (this.store.projectLocks.has(id))
      throw conflict("프로젝트 변경이 끝난 뒤 다시 설정해 주세요.");
    const automation =
      preview.merge === "approval" &&
      preview.push === "approval" &&
      preview.deploy === "approval"
        ? null
        : {
            ...preview,
            id: randomUUID(),
            approvedAt: new Date().toISOString(),
          };
    return this.savePolicy(id, automation, preview.revision);
  }
  savePolicy(id, automation, revision) {
    return this.store.transaction(() => {
      const previous = this.store.get("projects", id).automation;
      const project = this.store.update(
        "projects",
        id,
        {
          automation,
          policy: {
            merge: automation?.merge || "approval",
            push: automation?.push || "approval",
            deploy: automation?.deploy || "approval",
          },
        },
        revision,
      );
      for (const task of this.store
        .all("tasks", id)
        .filter((t) => t.automation?.status === "waiting-merge"))
        this.store.update("tasks", task.id, {
          automation: {
            ...task.automation,
            status: "cancelled",
            message:
              "설정 변경/해제로 이전 업무의 자동 반영을 중단했습니다. 수동 반영·푸시·배포는 사용할 수 있습니다.",
          },
        });
      this.store.insert("reports", {
        projectId: id,
        kind: "automation",
        title: automation
          ? "완료 후 자동 반영 설정 승인"
          : "완료 후 자동 반영 해제",
        policy: automation || previous,
        text: automation
          ? `이후 새 업무의 완료 후 원본 반영: ${automation.merge}, 푸시: ${automation.push}, 배포: ${automation.deploy}\n원본: ${automation.root} · ${automation.sourceBranch}${automation.destination ? `\n전송 대상: ${automation.destination.url} · ${automation.destination.branch}\n원본 브랜치의 기존 이력과 원격 CI/CD·비용 가능성을 확인했습니다.` : ""}${automation.deployment ? `\n배포 명령: ${JSON.stringify(automation.deployment.command)}\n향후 원본 커밋과 변경된 스크립트·의존성에서 실행 계정 권한으로 반복 배포하며 외부 변경·비용이 발생할 수 있음을 승인했습니다.` : ""}\n정책 ID: ${automation.id}`
          : "새 자동 반영을 중단합니다. 이미 시작한 Git/배포 명령은 되돌리지 않고 결과 기록까지 기다립니다.",
      });
      return project;
    });
  }
  result(task, status, message) {
    this.store.transaction(() => {
      this.store.update("tasks", task.id, {
        automation: {
          ...task.automation,
          status,
          message,
          finishedAt: new Date().toISOString(),
          policyId: task.automationPolicyId,
        },
      });
      this.store.insert("reports", {
        projectId: task.projectId,
        taskId: task.id,
        kind: "automation",
        title: status === "done" ? "자동 반영 완료" : "자동 반영 확인 필요",
        text: message,
        policyId: task.automationPolicyId,
      });
    });
  }
  pump() {
    if (this.runner.stopping || this.stopping) return;
    const groups = new Map();
    // ponytail: 기존 저장소 조회를 재사용한다. 업무 수가 커져 측정상 병목이면 대기 상태 인덱스를 추가한다.
    for (const task of this.store.all("tasks")) {
      if (
        task.status !== "completed" ||
        task.parentTaskId ||
        task.mode === "interview" ||
        !task.automationPolicyId ||
        (task.automation && task.automation.status !== "waiting-merge") ||
        this.running.has(task.projectId) ||
        this.store.projectLocks.has(task.projectId)
      )
        continue;
      const project = this.store.get("projects", task.projectId);
      if (
        project.archived ||
        project.automation?.id !== task.automationPolicyId ||
        this.store.hasUnconfirmedOperation(project.id)
      )
        continue;
      if (
        this.store
          .all("tasks", project.id)
          .some(
            (t) =>
              this.runner.active.has(t.id) ||
              t.executionUnconfirmed ||
              waiting.includes(t.status),
          )
      )
        continue;
      if (!groups.has(project.id)) groups.set(project.id, []);
      groups.get(project.id).push(task);
    }
    for (const [projectId, tasks] of groups) {
      this.store.projectLocks.add(projectId);
      let advanced = false;
      const promise = (async () => {
        for (const task of tasks) {
          if (
            this.stopping ||
            this.runner.stopping ||
            this.store.get("projects", projectId).automation?.id !==
              task.automationPolicyId ||
            this.store.hasUnconfirmedOperation(projectId)
          )
            break;
          await this.run(task);
          if (
            this.store.get("tasks", task.id).automation?.status !==
            "waiting-merge"
          )
            advanced = true;
        }
      })().finally(() => {
        this.store.projectLocks.delete(projectId);
        this.running.delete(projectId);
        // 다음 완료 업무를 처리하되 수동 병합을 기다리는 같은 업무를 무한 조회하지 않는다.
        if (advanced) queueMicrotask(() => this.runner.pump());
      });
      this.running.set(projectId, promise);
    }
  }
  async run(task) {
    const policy = this.store.get("projects", task.projectId).automation;
    const authorize = () => {
      const project = this.store.get("projects", task.projectId);
      const current = this.store.get("tasks", task.id);
      if (
        this.runner.stopping ||
        this.stopping ||
        project.archived ||
        project.automation?.id !== policy.id ||
        project.root !== policy.root ||
        project.branch !== policy.sourceBranch ||
        current.status !== "completed" ||
        current.generation !== task.generation ||
        current.resultCommit !== task.resultCommit
      )
        throw conflict(
          "자동화 설정·업무 상태가 변경되었거나 종료 중이므로 추가 반영을 중단했습니다.",
        );
    };
    try {
      authorize();
      const merger = new ResultMerge(this.store, this.runner, this.directory);
      const preview = await merger.preview(task.id);
      authorize();
      if (!preview.alreadyMerged && policy.merge !== "auto") {
        if (task.automation?.status !== "waiting-merge")
          this.store.update("tasks", task.id, {
            automation: {
              status: "waiting-merge",
              policyId: policy.id,
              message:
                "수동으로 원본에 반영한 뒤 설정에 따른 푸시·배포를 진행합니다.",
            },
          });
        return;
      }
      this.store.update("tasks", task.id, {
        automation: {
          status: "running",
          policyId: policy.id,
          startedAt: new Date().toISOString(),
        },
      });
      const context = {
        lockHeld: true,
        policyId: policy.id,
        taskId: task.id,
        authorize,
      };
      // 결과 기록으로 업무 revision이 바뀌었으므로 최신 사전 검사를 사용한다.
      if (!preview.alreadyMerged) {
        const current = await merger.preview(task.id);
        authorize();
        await merger.apply(
          task.id,
          { confirm: true, approval: current.approval },
          context,
        );
      }
      if (policy.push === "auto") {
        authorize();
        const service = new ProjectPush(this.store, this.runner);
        // 이름이 같은 원격이 다른 주소로 바뀌면 네트워크 조회 전에 멈춘다.
        if (
          (await service.destination(
            policy.root,
            policy.destination.remote,
          )) !== policy.destination.url
        )
          throw conflict(
            "승인한 푸시 주소가 변경됐습니다. 새 주소로 자동 전송하지 않았습니다.",
          );
        const destination = {
          ...policy.destination,
          expectedUrl: policy.destination.url,
        };
        const pushed = await service.preview(task.projectId, destination);
        authorize();
        if (
          pushed.url !== policy.destination.url ||
          pushed.sourceBranch !== policy.sourceBranch
        )
          throw conflict("승인한 전송 대상과 다릅니다.");
        await service.apply(
          task.projectId,
          {
            ...destination,
            confirm: true,
            confirmAutomation: true,
            approval: pushed.approval,
          },
          context,
        );
      }
      let deploymentMessage = "\n별도 배포 명령은 수행하지 않았습니다.";
      if (policy.deploy === "auto") {
        const checkDeployment = (value) => {
          authorize();
          if (
            value.path !== policy.root ||
            value.branch !== policy.sourceBranch ||
            value.executable !== policy.deployment.executable ||
            value.executableHash !== policy.deployment.executableHash
          )
            throw conflict(
              "승인한 배포 실행 파일/폴더가 변경됐습니다. 자동 배포하지 않았습니다.",
            );
        };
        const value = await this.deployment.preview(
          task.projectId,
          policy.deployment,
        );
        checkDeployment(value);
        const previous = this.store
          .all("reports", task.projectId)
          .find(
            (report) =>
              report.deployment?.policyId === policy.id &&
              report.deployment?.commit === value.commit &&
              report.deployment?.status === "succeeded",
          );
        if (previous) {
          deploymentMessage =
            "\n같은 정책과 원본 커밋의 배포 명령이 이미 정상 종료되어 다시 실행하지 않았습니다. 서비스 상태는 별도 확인이 필요합니다.";
        } else {
          const execution = await this.deployment.start(
            task.projectId,
            {
              ...policy.deployment,
              approval: value.approval,
              confirm: true,
              confirmAccess: true,
              confirmRepeat: true,
            },
            { ...context, authorize: checkDeployment },
          );
          await this.deployment.running.get(task.projectId);
          const result = this.store.get("projects", task.projectId).deployment;
          if (result?.id !== execution.id || result.status !== "succeeded")
            throw conflict(
              "자동 배포 명령의 정상 종료를 확인하지 못했습니다. 배포 메뉴에서 실제 결과를 확인해 주세요. 자동 재시도하지 않습니다.",
            );
          deploymentMessage =
            "\n자동 배포 명령이 종료 코드 0으로 끝났습니다. 서비스 상태와 외부 비동기 작업의 성공은 별도 확인이 필요합니다.";
        }
      }
      this.result(
        this.store.get("tasks", task.id),
        "done",
        `완료된 업무를 설정에 따라 원본에 반영했습니다.${policy.push === "auto" ? `\n${policy.destination.url} · ${policy.destination.branch} 푸시를 확인했습니다. 원격 CI/CD 성공은 별도 확인이 필요합니다.` : "\nGit 푸시는 수행하지 않았습니다."}${deploymentMessage}\n적용 정책: ${policy.id}`,
      );
    } catch (error) {
      this.result(
        this.store.get("tasks", task.id),
        "blocked",
        error instanceof DomainError
          ? error.message
          : "자동 반영을 마치지 못했습니다. 결과를 대조한 뒤 수동으로 마무리해 주세요. 자동 재시도하지 않습니다.",
      );
    }
  }
  async close() {
    this.stopping = true;
    await Promise.all([...this.running.values()]);
  }
}
