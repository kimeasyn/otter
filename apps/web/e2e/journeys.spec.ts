import { test, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

test("project, worktree, synthetic team workflow, history search and restart", async ({
  page,
}) => {
  const temp = await mkdtemp(join(tmpdir(), "otter-browser-"));
  const repo = join(temp, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Otter Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "baseline",
  );
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exit = new Promise((resolve) => child!.once("exit", resolve));
      child.kill("SIGINT");
      await exit;
    }
  };
  const start = async () => {
    child = spawn(resolve("../../artifacts/dev/otterd"), [], {
      env: {
        ...process.env,
        OTTER_AUTO_IMPORT: "0",
        OTTER_DATA_DIR: join(temp, "data"),
        OTTER_WEB_DIR: resolve("dist"),
        OTTER_BIND: "127.0.0.1:0",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        const c = JSON.parse(
          await readFile(join(temp, "data/connection.json"), "utf8"),
        );
        if (c.pid === child.pid) return c as { url: string; token: string };
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Daemon did not start");
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    let connection = await start();
    await page.goto(`${connection.url}/#token=${connection.token}`);
    await expect(page.getByText("Local daemon connected")).toBeVisible();
    await page.getByLabel("Repository path", { exact: true }).fill(temp);
    await page
      .getByRole("button", { name: "Browse folders…", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Choose a Git repository",
      exact: true,
    });
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole("button", { name: "Select repository", exact: true }),
    ).toBeDisabled();
    await picker
      .getByRole("button", { name: "Open folder repo", exact: true })
      .click();
    await expect(
      picker.getByLabel("Folder location", { exact: true }),
    ).toHaveValue(repo);
    await expect(
      picker.getByRole("button", { name: "Select repository", exact: true }),
    ).toBeEnabled();
    await mkdir(resolve("../../artifacts/screenshots"), { recursive: true });
    await page.screenshot({
      path: resolve("../../artifacts/screenshots/repository-picker.png"),
    });
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByLabel("Repository path", { exact: true }),
    ).toHaveValue(temp);
    await page
      .getByRole("button", { name: "Browse folders…", exact: true })
      .click();
    await picker
      .getByRole("button", { name: "Open folder repo", exact: true })
      .click();
    await picker
      .getByRole("button", { name: "Select repository", exact: true })
      .click();
    await expect(picker).toHaveCount(0);
    await expect(
      page.getByLabel("Repository path", { exact: true }),
    ).toHaveValue(repo);
    await page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Workspace Map" }),
    ).toBeVisible();
    await expect(page.getByText("↑0 ↓0")).toBeVisible();
    await page.getByRole("button", { name: "▦ Projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Registered projects (1)" })).toBeVisible();
    await page.getByLabel("Repository path", { exact: true }).fill(repo);
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Workspace Map" })).toBeVisible();
    await page
      .getByRole("button", { name: "+ New Work Unit", exact: true })
      .click();
    await page.getByLabel("Task title").fill("River parser recovery");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Recover truncated JSONL records and preserve source history.");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByLabel("Feature branch")).toHaveValue(
      "otter/river-parser-recovery",
    );
    await page
      .getByLabel("Worktree path", { exact: true })
      .fill(join(temp, "feature"));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("button", { name: "Create Work Unit", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "River parser recovery", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "+ Agent", exact: true }).click();
    await page.getByLabel("Agent name", { exact: true }).fill("Scout");
    await page
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill("Inspect the task and report risks.");
    await page
      .getByRole("button", { name: "Save reusable profile", exact: true })
      .click();
    await expect(
      page.getByRole("option", { name: "Scout · fake · builder", exact: true }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Save agent", exact: true }).click();
    const scout = page.locator(".agent-card").filter({ hasText: "Scout" });
    await expect(scout).toHaveCount(1);
    await scout.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Agent name", { exact: true }).fill("ScoutTwo");
    await page.getByRole("button", { name: "Save agent", exact: true }).click();
    await expect(scout).toContainText("ScoutTwo");
    page.once("dialog", (dialog) => dialog.accept());
    await scout.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(scout).toHaveCount(0);
    for (const role of ["Planner", "Builder", "Reviewer"]) {
      await page
        .getByRole("button", { name: `Start ${role}`, exact: true })
        .click();
      await expect(
        page.getByText(`${role.toLowerCase()} result`, { exact: true }),
      ).toBeVisible({ timeout: 15000 });
    }
    await expect(
      page.getByRole("button", { name: "Workflow complete", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("NO COMMITS TO MERGE", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("completed (synthetic)", { exact: true }),
    ).toBeVisible();
    const apiGet = async (path: string) => {
      const r = await fetch(connection.url + "/api" + path, {
        headers: { Authorization: `Bearer ${connection.token}` },
      });
      expect(r.status).toBe(200);
      return r.json();
    };
    const unit = (await apiGet("/work-units"))[0];
    const detail = await apiGet(`/work-units/${unit.id}`);
    await page
      .getByRole("button", { name: "Open worktree terminal", exact: true })
      .click();
    await expect(
      page.getByText("Running · Runs as your local user", { exact: true }),
    ).toBeVisible();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("printf 'OTTER_%s\\n' 'PTY_OK'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-accessibility")).toContainText(
      "OTTER_PTY_OK",
    );
    await page
      .getByRole("button", { name: "Close terminal", exact: true })
      .click();
    expect(detail.handoffs).toHaveLength(2);
    expect(detail.artifacts).toHaveLength(3);
    await mkdir(resolve("../../artifacts/screenshots"), { recursive: true });
    await page.screenshot({
      path: resolve("../../artifacts/screenshots/work-unit.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "⌕ Search", exact: true }).click();
    await page
      .getByLabel("Search history", { exact: true })
      .fill("River parser");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".list-row")).not.toHaveCount(0);
    await page
      .locator(".list-row")
      .filter({ hasText: "assistant.message" })
      .first()
      .click();
    await expect(
      page.getByRole("tab", { name: "Timeline", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".event.focused")).toHaveCount(1);
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await expect(page.locator(".event")).not.toHaveCount(0);
    await page.getByRole("tab", { name: "Raw", exact: true }).click();
    await expect(
      page.getByText("Source record 0", { exact: true }),
    ).toBeVisible();
    await stop();
    connection = await start();
    await page.goto(`${connection.url}/#token=${connection.token}`);
    await page
      .getByRole("button", { name: "▤ Work Units", exact: true })
      .click();
    await page.getByRole("button", { name: /River parser recovery/ }).click();
    await expect(
      page.getByRole("button", { name: "Workflow complete", exact: true }),
    ).toBeDisabled();
    const restored = await apiGet(`/work-units/${unit.id}`);
    expect(restored.handoffs).toHaveLength(2);
    expect(restored.artifacts).toHaveLength(3);
    await page.getByRole("button", { name: "◷ Sessions", exact: true }).click();
    await expect(page.locator(".list-row")).toHaveCount(3);
    await page
      .getByText("Import a specific session file", { exact: true })
      .click();
    const codexSessions = join(temp, "sessions");
    await mkdir(codexSessions);
    const codexSession = join(codexSessions, "history.jsonl");
    await writeFile(
      codexSession,
      await readFile(resolve("../../fixtures/codex/history.jsonl")),
    );
    await writeFile(
      join(temp, "session_index.jsonl"),
      JSON.stringify({
        id: "synthetic-codex-history",
        thread_name: "파서 경계 처리 개선",
      }) + "\n",
    );
    await page
      .getByLabel("JSONL path on daemon machine")
      .fill(codexSession);
    await page
      .getByRole("button", { name: "Import session", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "파서 경계 처리 개선",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "◷ Sessions", exact: true }).click();
    const subject = page.locator(".session-subject strong", { hasText: "파서 경계 처리 개선" });
    await expect(subject).toHaveAttribute("title", "파서 경계 처리 개선");
    await page.screenshot({
      path: resolve("../../artifacts/screenshots/session-titles.png"),
      fullPage: true,
    });
    await subject.click();
    for (const tab of [
      "Conversation",
      "Actions",
      "Files",
      "Commands",
      "Timeline",
      "Raw",
    ]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(page.locator(".event")).not.toHaveCount(0);
    }
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await expect(
      page.locator(".event .badge").filter({ hasText: /tool\./ }),
    ).toHaveCount(0);
    const userMessage = page.locator(".conversation-user");
    const assistantMessages = page.locator(".conversation-assistant");
    await expect(userMessage).toHaveCount(1);
    await expect(assistantMessages).toHaveCount(2);
    await expect(page.locator(".conversation-reasoning .badge")).toHaveText(
      "Assistant · Reasoning Summary",
    );
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      const userBox = (await userMessage.boundingBox())!;
      const assistantBox = (await assistantMessages.last().boundingBox())!;
      expect(userBox.x).toBeGreaterThan(assistantBox.x + 10);
      expect(userBox.x + userBox.width).toBeGreaterThan(
        assistantBox.x + assistantBox.width + 10,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: resolve("../../artifacts/screenshots/conversation.png"),
      fullPage: true,
    });
    const imported = await fetch(connection.url + "/api/history/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "codex",
        path: codexSession,
      }),
    });
    expect((await imported.json()).inserted).toBe(0);
    const claude = await fetch(connection.url + "/api/history/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "claude",
        path: resolve("../../fixtures/claude/history.jsonl"),
      }),
    });
    expect((await claude.json()).inserted).toBe(7);
    await page
      .getByRole("button", { name: "▤ Work Units", exact: true })
      .click();
    await page.getByRole("button", { name: /River parser recovery/ }).click();
    await page
      .getByLabel("Request", { exact: true })
      .fill("@REVIEWER inspect the current task");
    await page
      .getByRole("button", { name: "Send request", exact: true })
      .click();
    const reviewer = page
      .locator(".agent-card")
      .filter({ hasText: "Reviewer" });
    await reviewer.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(reviewer.locator(".badge")).toHaveText("stopped");
    await reviewer
      .getByRole("button", { name: "Session", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "▦ Projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Registered projects (1)" })).toBeVisible();
    await page.getByRole("button", { name: "Remove repo from Otter", exact: true }).click();
    await expect(page.getByText(/Only the registration is removed/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".registered-project")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove repo from Otter", exact: true }).click();
    await page.screenshot({
      path: resolve("../../artifacts/screenshots/registered-projects.png"),
      fullPage: true,
    });
    const headBeforeRemoval = git("rev-parse", "HEAD").toString();
    const worktreesBeforeRemoval = git("worktree", "list", "--porcelain").toString();
    await page.getByRole("button", { name: "Remove registration", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Files and history were kept");
    await expect(page.getByRole("heading", { name: "Registered projects (0)" })).toBeVisible();
    expect(git("rev-parse", "HEAD").toString()).toBe(headBeforeRemoval);
    expect(git("worktree", "list", "--porcelain").toString()).toBe(worktreesBeforeRemoval);
    expect((await apiGet(`/work-units/${unit.id}`)).work_unit.id).toBe(unit.id);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Registered projects (0)" })).toBeVisible();
    await page.getByLabel("Repository path", { exact: true }).fill(repo);
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Workspace Map" })).toBeVisible();
    expect(await apiGet("/projects")).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await stop();
    await rm(temp, { recursive: true, force: true });
  }
});
