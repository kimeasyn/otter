declare global {
  interface Window {
    otter?: {
      pickFolder: () => Promise<string | null>;
      pickCodex: () => Promise<string | null>;
      backupRecords?: () => Promise<{
        saved: boolean;
        path?: string;
        bytes?: number;
        sha256?: string;
        createdAt?: string;
      }>;
      openEditor: (input: {
        projectId: string;
        taskId?: string;
        environmentId: string;
        sshHost?: string;
        chooseExecutable?: boolean;
      }) => Promise<{ launched: boolean }>;
    };
  }
}
export type Employee = {
  id: string;
  revision: number;
  name: string;
  role: string;
  model: string;
  instructions: string;
  skills: string;
  sourceId?: string;
  appearance: { color: string; avatar: string };
};
export type Assignment = {
  id: string;
  employeeId: string;
  employeeRevision: number;
  revision: number;
  settings: Employee;
  appearance: Employee["appearance"];
};
export type Project = {
  deployment?: {
    id: string;
    status: string;
    name: string;
    command: string[];
    timeoutSeconds: number;
    commit: string;
    message?: string;
    note?: string;
    process?: {
      pid: number | null;
      closed: boolean;
      groupId?: number | null;
      groupState?: string;
    };
  };
  automation?: {
    id: string;
    root: string;
    sourceBranch: string;
    merge: "approval" | "auto";
    push: "approval" | "auto";
    deploy?: "approval" | "auto";
    deployment?: {
      name: string;
      command: string[];
      timeoutSeconds: number;
      executable: string;
      executableHash: string;
      processTracking?: "posix-group" | "parent-only";
    } | null;
    destination?: { remote: string; url: string; branch: string } | null;
  } | null;
  push?: { status: string; remote: string; branch: string; commit: string };
  completion?: "manual" | "verified";
  checks?: VerificationCheck[];
  revision: number;
  stage?: "idea" | "development";
  pmAssignmentId?: string;
  id: string;
  name: string;
  root: string;
  companyId: string;
  environment: string;
  environmentId?: string;
  environmentLabel?: string;
  archived: boolean;
};
export type Environment = {
  id: string;
  revision: number;
  name: string;
  kind: "ssh" | "wsl";
  host?: string;
  distribution?: string;
  slots: number;
  connected: boolean;
  error?: string;
  lastSeen?: string;
  allocated: boolean;
  workerId?: string;
  username?: string;
  port?: number;
  identityFile?: string;
  nodeExecutable?: string;
  directory?: string;
  busy?: boolean;
};
export type Task = {
  providerTurnId?: string | null;
  interruptionConfirmed?: boolean;
  executionUnconfirmed?: boolean;
  channel?: "direct" | "project";
  revision?: number;
  generation?: number;
  acceptedReview?: {
    revision: number;
    generation: number;
    resultCommit: string | null;
  } | null;
  automationPolicyId?: string | null;
  automation?: { status: string; message?: string } | null;
  verification?: VerificationResult | null;
  acceptedBy?: string;
  id: string;
  title: string;
  assignmentId: string;
  status: string;
  mode?: "direct" | "delegate" | "interview";
  parentTaskId?: string;
  dependencies?: string[];
  resultCommit?: string;
  merge?: {
    status: string;
    branch: string;
    commit: string;
    resultCommit: string;
  };
  error?: string;
  worktree?: { path: string; branch: string };
  retryAt?: string | null;
  retryCount?: number;
  maxRetries?: number;
};
export type VerificationCheck = {
  name: string;
  command: string[];
  timeoutSeconds: number;
};
export type VerificationResult = {
  status: string;
  commit?: string;
  error?: string;
  checks: (VerificationCheck & { status: string; exitCode?: number })[];
};
export type Message = {
  generation?: number;
  id: string;
  taskId: string;
  assignmentId: string;
  sender: string;
  senderAssignmentId?: string;
  recipientAssignmentId?: string;
  kind?: string;
  delivery?: string;
  text: string;
  createdAt: string;
  channel: string;
};
export type Document = {
  id: string;
  title: string;
  content: string;
  revision: number;
  kind?: string;
  sourceWarning?: string;
  fileSync?: { name: string; hash: string };
  knowledgeSource?: { id: string; revision: number };
};
export type SharedKnowledge = {
  id: string;
  revision: number;
  companyId: string;
  title: string;
  content: string;
  reason: string;
  approvedAt: string;
  sourceProjectId: string;
  status: "published" | "withdrawn";
};
export type Approval = {
  id: string;
  taskId: string;
  method: string;
  status: string;
  review?: {
    title: string;
    details: string[];
    warning: string;
    canAccept: boolean;
    decisions: string[];
    acknowledgement: boolean;
    blockedReason?: string;
  } | null;
  params: {
    companyName?: string;
    reason?: string;
    command?: string;
    cwd?: string;
    grantRoot?: string;
    name?: string;
    role?: string;
    model?: string;
    instructions?: string;
    skills?: string;
    title?: string;
    before?: string;
    content?: string;
    changes?: { path: string; diff: string; kind: unknown }[];
    questions?: { id: string; header: string; question: string }[];
  };
};
export type Snapshot = {
  knowledge?: SharedKnowledge[];
  environments?: Environment[];
  localSlots?: number;
  connectionError?: string;
  observedAt?: string;
  companies: { id: string; name: string; mode: string }[];
  projects: Project[];
  employees: Employee[];
  assignments?: Assignment[];
  documents?: Document[];
  tasks?: Task[];
  messages?: Message[];
  reports?: {
    id: string;
    createdAt?: string;
    taskId?: string | null;
    title: string;
    text: string;
    kind: string;
    verification: string;
    verificationResult?: VerificationResult;
    deployment?: {
      command: string[];
      executable: string;
      timeoutSeconds: number;
    };
  }[];
  approvals?: Approval[];
  settings: { concurrency: number; retries: number };
};
export const statusNames: Record<string, string> = {
  queued: "업무 대기",
  running: "작업 중",
  waiting: "답변 필요",
  review: "검토 요청",
  completed: "완료",
  failed: "실패",
  interrupted: "중단됨",
  coordinating: "팀 결과·결정 대기",
  handoff: "인계 완료",
  blocked: "확인 필요",
};
const pendingRequests = new Map<string, string>();
export async function api<T>(
  path: string,
  data?: unknown,
  environment = "local",
): Promise<T> {
  const payload = data === undefined ? undefined : JSON.stringify(data);
  const signature = environment + "\n" + path + "\n" + payload;
  let key = pendingRequests.get(signature);
  if (payload !== undefined && !key) {
    key = crypto.randomUUID();
    pendingRequests.set(signature, key);
  }
  const response = await fetch(
    "/api/" + path,
    data === undefined
      ? { headers: { "X-Otter-Environment": environment } }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Otter-Environment": environment,
            "Idempotency-Key": key!,
          },
          body: payload,
        },
  );
  const result = await response.json();
  const acknowledged = path.match(
    /^request-journal\/([a-zA-Z0-9_-]{8,128})\/ack$/,
  );
  if (response.ok && acknowledged) {
    for (const [signature, pendingId] of pendingRequests)
      if (pendingId === acknowledged[1]) pendingRequests.delete(signature);
  }
  const receipt = response.headers.get("X-Otter-Receipt");
  if (receipt && response.status < 500 && !result.pending) {
    // 결과를 받은 경우만 확인 처리한다. 실패해도 원래 응답은 유지하며 복구 목록에 남긴다.
    await fetch(`/api/request-journal/${encodeURIComponent(receipt)}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  if (response.ok || (response.status < 500 && !result.pending))
    pendingRequests.delete(signature);
  if (!response.ok)
    throw new Error(result.error || "실행부에 연결하지 못했습니다.");
  return result;
}
