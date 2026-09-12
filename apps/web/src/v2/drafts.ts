import { useSyncExternalStore } from "react";

type Draft = {
  text: string;
  version: string;
  revision?: number;
  mode?: "direct" | "delegate";
};
const storageKey = "otter.v2.drafts.1";
let storageError = "";
let drafts: Record<string, Draft> = {};
try {
  const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw new Error();
  for (const [key, value] of Object.entries(saved)) {
    if (
      !key.startsWith("[") ||
      !value ||
      typeof value !== "object" ||
      typeof value.text !== "string" ||
      typeof value.version !== "string" ||
      (value.revision !== undefined &&
        (!Number.isInteger(value.revision) || value.revision < 1)) ||
      (value.mode !== undefined && !["direct", "delegate"].includes(value.mode))
    )
      throw new Error();
  }
  drafts = saved as Record<string, Draft>;
} catch {
  storageError =
    "이 탭의 초안 보관소를 읽지 못했습니다. 새로고침 전에 작성 내용을 복사해 주세요.";
}
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => drafts;
export const draftKey = (...parts: string[]) => JSON.stringify(parts);
export const getDraft = (key: string) => drafts[key];
export function setDraft(key: string, value: Omit<Draft, "version"> | null) {
  drafts = { ...drafts };
  if (value === null) delete drafts[key];
  else drafts[key] = { ...value, version: crypto.randomUUID() };
  try {
    if (Object.keys(drafts).length)
      sessionStorage.setItem(storageKey, JSON.stringify(drafts));
    else sessionStorage.removeItem(storageKey);
    storageError = "";
  } catch {
    storageError =
      "초안을 이 탭에 보관하지 못했습니다. 화면 이동 중에는 유지되지만 새로고침·종료 전에 내용을 복사해 주세요.";
  }
  for (const listener of listeners) listener();
}
// 응답을 기다리는 동안 입력한 새 내용이나 다른 문서 버전은 지우지 않는다.
export function finishDraft(key: string, submitted: Draft, revision?: number) {
  const current = getDraft(key);
  if (current?.version === submitted.version) setDraft(key, null);
  else if (
    current &&
    revision !== undefined &&
    current.revision === submitted.revision
  )
    setDraft(key, { ...current, revision });
}
export function useDrafts() {
  return useSyncExternalStore(subscribe, snapshot);
}
export function useDraftStorageError() {
  return useSyncExternalStore(subscribe, () => storageError);
}
window.addEventListener("beforeunload", (event) => {
  if (storageError && Object.values(drafts).some((draft) => draft.text)) {
    event.preventDefault();
    event.returnValue = "";
  }
});
