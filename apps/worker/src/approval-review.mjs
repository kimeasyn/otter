import { isAbsolute, relative, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 같은 Codex 연결에서 local 환경을 조회한 결과만 사용한다. 승인 요청 본문은 증거가 아니다.
export function localApprovalEnvironment(info, worktree) {
  try {
    const uri = new URL(info.cwd);
    if (uri.protocol !== "file:" || uri.hostname || uri.search || uri.hash)
      return null;
    const cwd = realpathSync(worktree);
    if (
      !statSync(cwd).isDirectory() ||
      realpathSync(fileURLToPath(uri)) !== cwd
    )
      return null;
    return { id: "local", cwd };
  } catch {
    return null;
  }
}

function matchesEnvironment(params, environment) {
  if (
    params.environmentId !== "local" ||
    environment?.id !== "local" ||
    !text(params.cwd) ||
    !isAbsolute(params.cwd)
  )
    return false;
  try {
    if (realpathSync(environment.cwd) !== environment.cwd) return false;
    const cwd = realpathSync(params.cwd);
    const path = relative(environment.cwd, cwd);
    return (
      statSync(cwd).isDirectory() &&
      !isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(".." + sep)
    );
  } catch {
    return false;
  }
}

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) =>
  object(value) && Object.keys(value).every((key) => allowed.includes(key));
const text = (value) =>
  typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const accessNames = { read: "읽기", write: "쓰기·삭제", deny: "접근 금지" };
const specialNames = {
  root: "전체 파일 시스템",
  minimal: "도구 실행에 필요한 기본 경로",
  project_roots: "프로젝트 작업 경로",
  tmpdir: "환경의 임시 폴더",
  slash_tmp: "/tmp",
};

// 화면에 설명할 수 있는 필드만 승인한다. 새 프로토콜 필드를 조용히 허용하지 않는다.
function permissions(value, details) {
  if (!keys(value, ["fileSystem", "network"])) return false;
  if (value.network != null) {
    if (
      !keys(value.network, ["enabled"]) ||
      (value.network.enabled != null &&
        typeof value.network.enabled !== "boolean")
    )
      return false;
    if (value.network.enabled != null)
      details.push(
        value.network.enabled
          ? "네트워크 접근 허용 (특정 호스트로 제한되지 않음)"
          : "네트워크 접근 추가 허용 없음",
      );
  }
  const fs = value.fileSystem;
  if (fs == null) return true;
  if (!keys(fs, ["read", "write", "entries", "globScanMaxDepth"])) return false;
  for (const mode of ["read", "write"]) {
    if (fs[mode] == null) continue;
    if (!Array.isArray(fs[mode])) return false;
    for (const path of fs[mode]) {
      if (!text(path) || !isAbsolute(path)) return false;
      details.push(`${accessNames[mode]}: ${path}`);
    }
  }
  if (fs.globScanMaxDepth != null) {
    if (!Number.isSafeInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 1)
      return false;
    details.push(`파일 패턴 탐색 깊이: ${fs.globScanMaxDepth}`);
  }
  if (fs.entries == null) return true;
  if (!Array.isArray(fs.entries)) return false;
  for (const entry of fs.entries) {
    if (
      !keys(entry, ["access", "path"]) ||
      !Object.hasOwn(accessNames, entry.access)
    )
      return false;
    const path = entry.path;
    if (!object(path)) return false;
    let target;
    if (
      path.type === "path" &&
      keys(path, ["type", "path"]) &&
      text(path.path) &&
      isAbsolute(path.path)
    )
      target = path.path;
    else if (
      path.type === "glob_pattern" &&
      keys(path, ["type", "pattern"]) &&
      text(path.pattern)
    )
      target = `파일 패턴 ${path.pattern}`;
    else if (path.type === "special" && keys(path, ["type", "value"])) {
      const value = path.value;
      if (
        !object(value) ||
        !Object.hasOwn(specialNames, value.kind) ||
        !keys(
          value,
          value.kind === "project_roots" ? ["kind", "subpath"] : ["kind"],
        ) ||
        (value.subpath != null && !text(value.subpath))
      )
        return false;
      target =
        specialNames[value.kind] + (value.subpath ? ` / ${value.subpath}` : "");
    } else return false;
    details.push(`${accessNames[entry.access]}: ${target}`);
  }
  return true;
}

export function approvalReview(method, params, environment = null) {
  const details = [];
  let canAccept = true;
  let title = "파일 변경 승인";
  let warning =
    "표시된 파일 변경을 확인하세요. 외부 전송·배포를 별도로 허가하는 승인은 아닙니다.";
  let decisions = ["accept", "decline", "cancel"];
  if (method === "item/permissions/requestApproval") {
    title = "이번 턴의 추가 접근 권한";
    decisions = ["accept", "decline"];
    canAccept =
      permissions(params.permissions, details) &&
      details.length > 0 &&
      text(params.cwd) &&
      isAbsolute(params.cwd);
    warning =
      "승인한 접근 범위는 명령 한 번이 아니라 현재 턴의 후속 작업에도 적용됩니다. 쓰기 권한에는 삭제가, 네트워크 권한에는 외부 전송·유료 서비스 호출 가능성이 포함됩니다. 다음 턴이나 세션 전체의 권한으로 저장하지 않습니다.";
  } else if (method === "item/commandExecution/requestApproval") {
    title = params.networkApprovalContext
      ? "네트워크 접근 승인"
      : "명령 실행 승인";
    if (params.availableDecisions != null) {
      decisions = Array.isArray(params.availableDecisions)
        ? decisions.filter((decision) =>
            params.availableDecisions.includes(decision),
          )
        : [];
    }
    canAccept = decisions.includes("accept");
    if (params.kind != null && !["command", "writeStdin"].includes(params.kind))
      canAccept = false;
    if (params.kind === "writeStdin")
      details.push("실행 중인 프로세스에 입력을 전달하는 요청입니다.");
    if (params.networkApprovalContext) {
      const network = params.networkApprovalContext;
      if (
        !keys(network, ["host", "protocol"]) ||
        !text(network.host) ||
        !text(network.protocol)
      )
        canAccept = false;
      else details.push(`접속 대상: ${network.protocol} · ${network.host}`);
      warning =
        "같은 접속 대상으로 대기 중인 여러 네트워크 요청이 함께 진행될 수 있습니다. 외부 전송·서버 자동화·비용 발생 가능성을 확인하세요. 영구 허용 규칙은 만들지 않습니다.";
    } else {
      if (
        typeof params.command !== "string" ||
        !params.command.trim() ||
        !text(params.cwd) ||
        !isAbsolute(params.cwd)
      )
        canAccept = false;
      warning =
        "이 명령은 파일 변경·외부 전송·배포 등 부수 효과를 낼 수 있습니다. 샌드박스 밖 실행 요청일 수 있으므로 작업 폴더만 접근한다고 가정하지 마세요. 세션 전체 승인이나 향후 명령의 자동 허용 규칙은 만들지 않습니다.";
    }
    if (
      params.additionalPermissions != null &&
      !permissions(params.additionalPermissions, details)
    )
      canAccept = false;
  } else if (method === "item/fileChange/requestApproval") {
    canAccept =
      Array.isArray(params.changes) &&
      params.changes.length > 0 &&
      params.changes.every(
        (change) => text(change.path) && typeof change.diff === "string",
      );
    if (params.grantRoot != null) {
      if (!text(params.grantRoot)) canAccept = false;
      else details.push(`추가 파일 접근 경로: ${params.grantRoot}`);
    }
  } else return null;
  if (params.environmentId != null) {
    if (matchesEnvironment(params, environment)) {
      details.push(
        "업무 실행부의 Codex local 환경과 직원 작업 폴더 연결을 확인했습니다. 접속 중인 PC를 뜻하지는 않습니다.",
      );
    } else {
      canAccept = false;
      details.push(
        "Otter 프로젝트와 연결을 확인하지 못한 Codex 내부 실행 환경입니다.",
      );
    }
  }
  return {
    title,
    details,
    warning,
    canAccept,
    decisions,
    acknowledgement: method !== "item/fileChange/requestApproval",
    ...(!canAccept
      ? {
          blockedReason:
            "실행 범위나 일회성 승인 선택을 안전하게 확인할 수 없습니다. 거절하거나 업무를 중단해 주세요.",
        }
      : {}),
  };
}
