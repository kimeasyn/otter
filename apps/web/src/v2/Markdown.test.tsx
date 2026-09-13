import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("보고의 제목·목록·코드를 렌더링하고 파일 참조는 탐색 대신 경로를 복사한다", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { container } = render(
    <Markdown
      text={
        "## 결과\n\n- **완료**\n- `검사`\n\n```js\nconst x = 1;\n```\n\n[파일](/repo/file.ts:12) [문서](https://example.com/docs)"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "결과" })).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(container.querySelector("pre code")).toHaveTextContent("const x = 1;");
  expect(screen.getByRole("link", { name: "문서" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  expect(screen.queryByRole("link", { name: "파일" })).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "파일 경로 복사: /repo/file.ts:12" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("복사됨"),
  );
  expect(writeText).toHaveBeenCalledWith("/repo/file.ts:12");
});
it("HTML·실행 URL·프로토콜 상대 경로·이미지의 자동 네트워크 요청을 차단한다", () => {
  const { container } = render(
    <Markdown
      text={
        '<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel">\n\n[x](javascript:alert) [y](data:text/html,bad) [z](//tracker.example) ![추적](https://tracker.example/image)'
      }
    />,
  );
  expect(container.querySelector("script, iframe, img, a")).toBeNull();
  expect(screen.getByText(/자동 로드하지 않음/)).toBeVisible();
});
it("클립보드가 없는 환경에서는 복사할 경로를 표시한다", async () => {
  vi.stubGlobal("navigator", {});
  render(<Markdown text="[파일](src/file.ts)" />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("src/file.ts"),
  );
});
