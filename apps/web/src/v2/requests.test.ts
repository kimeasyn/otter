import { expect, it, vi } from "vitest";
import { api } from "./types";

it("미확인 변경은 같은 ID를 유지하고 복구 확인 후에는 새 요청 ID를 사용한다", async () => {
  const keys: string[] = [];
  let acknowledged = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes("/request-journal/")) {
        acknowledged++;
        if (acknowledged > 1) throw new Error("확인 응답 유실");
        return new Response("{}", { status: 200 });
      }
      const key = new Headers(options?.headers).get("Idempotency-Key")!;
      keys.push(key);
      if (keys.length === 1) throw new Error("원격 응답 유실");
      if (keys.length === 2)
        return new Response(
          JSON.stringify({ pending: true, error: "미확인" }),
          { status: 409 },
        );
      return new Response(JSON.stringify({ id: "created" }), {
        status: 201,
        headers: { "X-Otter-Receipt": key },
      });
    }),
  );
  try {
    const input = { prompt: "원래 요청" };
    await expect(api("tasks", input, "remote-a")).rejects.toThrow("유실");
    await expect(api("tasks", input, "remote-a")).rejects.toThrow("미확인");
    expect(keys[0]).toBe(keys[1]);
    await api(`request-journal/${keys[0]}/ack`, {});
    await expect(api("tasks", input, "remote-a")).resolves.toEqual({
      id: "created",
    });
    expect(keys[2]).not.toBe(keys[0]);
    expect(acknowledged).toBe(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
