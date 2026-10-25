import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp, reloadApp } from "./helpers/app";
import {
  createEditHistory,
  openHistory,
  readTimeline,
  verifyEditHistory,
} from "./helpers/thread-edit";
import { prepareManagedDaemon } from "./helpers/host-daemon";
import { execRemoteSsh, sendTextTurn } from "./helpers/remote-codex";
import { AGENT_OUTPUT_TIMEOUT_MS } from "./helpers/timeouts";
import { shellQuote } from "../../server/utils/gateway/infra/ssh/shell";
import { gatewayThreadSchema } from "../../shared/runtime/app-server";
import type { DirectoryAlias, GatewayThread } from "../../shared/types";

test.beforeEach(async ({ remoteWorkspace }) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
});

async function configureAliases(page: Page, hostId: number, aliases: DirectoryAlias[]) {
  await page.getByTestId("settings-toggle").click();
  await page.getByRole("tab", { name: "主机", exact: true }).click();
  await page.getByTestId(`host-edit-toggle-${hostId}`).click();
  const form = page.getByTestId(`host-edit-form-${hostId}`);
  await form.getByText("统一迁移前后的目录", { exact: true }).click();
  while ((await form.getByRole("button", { name: "移除此对应关系" }).count()) > 0) {
    await form.getByRole("button", { name: "移除此对应关系" }).first().click();
  }
  for (const alias of aliases) {
    await form.getByRole("button", { name: "添加目录对应关系" }).click();
    await form.getByLabel("旧目录的完整路径").last().fill(alias.originalPath);
    await form.getByLabel("当前目录的完整路径").last().fill(alias.workspacePath);
  }
  await form.getByRole("button", { name: "保存主机", exact: true }).click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
}

const pageSchema = z
  .object({ data: z.array(gatewayThreadSchema), nextCursor: z.string().nullable() })
  .loose();
async function allDirectoryThreads(page: Page, hostId: number, cwd: string) {
  let cursor: string | null = null;
  const threads: GatewayThread[] = [];
  const cursors = new Set<string>();
  do {
    const query: URLSearchParams = new URLSearchParams({
      hostId: String(hostId),
      cwd,
      limit: "2",
      ...(cursor === null ? {} : { cursor }),
    });
    const result: z.infer<typeof pageSchema> = await authenticatedFetch(
      page,
      { url: `/api/threads?${query}` },
      (value) => pageSchema.parse(value),
    );
    threads.push(...result.data);
    cursor = result.nextCursor;
    if (cursor !== null) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return threads;
}

test("explicit directory mappings produce one real group with native union pagination and unchanged histories", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const root = `/home/codex/unify-${randomUUID()}`;
  const paths = ["current", "old-user", "old-location"].map((part) => `${root}/${part}/Thesis`);
  const histories: Array<{ threadId: string; cwd: string; texts: string[] }> = [];
  const before = new Map<string, Awaited<ReturnType<typeof readTimeline>>>();
  await execRemoteSsh(remoteWorkspace.remote, `mkdir -p ${paths.map(shellQuote).join(" ")}`);
  // Imported histories all share a fixture timestamp. Exercise native cursor membership using
  // actual indexed thread/start + model turns, as the existing pagination regression does.
  for (const cwd of paths) {
    await remoteWorkspace.addProject(host.id, "Thesis", cwd);
    for (let n = 0; n < (cwd === paths[0] ? 2 : 1); n++) {
      const threadId = await remoteWorkspace.startThread(cwd);
      const marker = `union-${randomUUID()}`;
      await sendTextTurn(page, `Only reply ${marker}. Do not use tools or change files.`);
      await expect(page.getByTestId("chat-scroll-area")).toContainText(marker, {
        timeout: AGENT_OUTPUT_TIMEOUT_MS,
      });
      await expect(page.getByTestId("send-turn-button")).toHaveAttribute("aria-label", "已完成", {
        timeout: AGENT_OUTPUT_TIMEOUT_MS,
      });
      const history = { threadId, cwd, texts: [marker] };
      before.set(threadId, await readTimeline(page, host.id, threadId));
      histories.push(history);
    }
  }
  const oldUserHistory = histories.find((history) => history.cwd === paths[1])!;
  const unrelated = await createEditHistory(remoteWorkspace.remote, {
    cwd: `${root}/unrelated/Thesis`,
    count: 1,
  });
  await verifyEditHistory(page, host.id, unrelated);
  await page.evaluate(
    (hostId) => window.__codexGatewayE2e!.navigation.refreshHostProjects(hostId),
    host.id,
  );
  await openHistory(page, host.id, histories[0]!.threadId);
  await configureAliases(
    page,
    host.id,
    paths.slice(1).map((originalPath) => ({ originalPath, workspacePath: paths[0]! })),
  );
  await execRemoteSsh(remoteWorkspace.remote, `rm -rf ${paths.slice(1).map(shellQuote).join(" ")}`);
  for (const cwd of paths.slice(1))
    await expect(page.getByTestId(`project-button-${cwd}`)).toHaveCount(0);
  await expect(page.getByTestId(`project-button-${paths[0]}`)).toHaveCount(1);
  await expect(page.getByTestId(`project-button-${unrelated.cwd}`)).toHaveCount(1);
  const rows = await allDirectoryThreads(page, host.id, paths[0]!);
  expect(rows.map((thread) => thread.id).sort()).toEqual(
    histories.map((history) => history.threadId).sort(),
  );
  expect(new Set(rows.map((thread) => thread.id)).size).toBe(rows.length);
  expect(rows.find((thread) => thread.id === oldUserHistory.threadId)?.cwd).toBe(paths[1]);
  expect(rows.find((thread) => thread.id === oldUserHistory.threadId)?.workspaceCwd).toBe(paths[0]);
  expect(
    (await allDirectoryThreads(page, host.id, paths[1]!)).map((thread) => thread.id).sort(),
  ).toEqual(rows.map((thread) => thread.id).sort());
  for (const history of histories) {
    await openHistory(page, host.id, history.threadId);
    await expect(page).toHaveURL((url) => url.searchParams.get("cwd") === paths[0]);
    await expect(page.getByTestId("chat-scroll-area")).toContainText(history.texts[0]!);
    expect(await readTimeline(page, host.id, history.threadId)).toEqual(
      before.get(history.threadId),
    );
  }
  await reloadApp(page);
  await expect(page.getByTestId(`project-button-${paths[0]}`)).toHaveCount(1);
  for (const cwd of paths.slice(1))
    await expect(page.getByTestId(`project-button-${cwd}`)).toHaveCount(0);
  await expect(page).toHaveURL((url) => url.searchParams.get("cwd") === paths[0]);
  await page.screenshot({ path: testInfo.outputPath("one-canonical-directory.png") });
  await configureAliases(page, host.id, []);
  for (const cwd of paths) await expect(page.getByTestId(`project-button-${cwd}`)).toHaveCount(1);
  await openHistory(page, host.id, oldUserHistory.threadId);
  await expect(page).toHaveURL((url) => url.searchParams.get("cwd") === paths[1]);
});

test("continuing an old-path thread uses the configured real workspace and restores that path after pin and reload", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const root = `/home/codex/continue-alias-${randomUUID()}`;
  const history = await createEditHistory(remoteWorkspace.remote, {
    cwd: `${root}/old/Thesis`,
    count: 1,
  });
  const before = await verifyEditHistory(page, host.id, history);
  const current = `${root}/current/Thesis`;
  const fileMarker = `FILE_${randomUUID()}`;
  await execRemoteSsh(
    remoteWorkspace.remote,
    `mkdir -p ${shellQuote(current)}; printf '%s' ${shellQuote(fileMarker)} > ${shellQuote(`${current}/keep.txt`)}`,
  );
  await openHistory(page, host.id, history.threadId);
  await configureAliases(page, host.id, [{ originalPath: history.cwd, workspacePath: current }]);
  await execRemoteSsh(remoteWorkspace.remote, `rm -rf ${shellQuote(history.cwd)}`);
  await sendTextTurn(
    page,
    "Execute pwd and read keep.txt from your actual working directory. Reply with the actual directory and the exact file contents. Do not modify files.",
  );
  await expect(page.getByTestId("chat-scroll-area")).toContainText(fileMarker, {
    timeout: AGENT_OUTPUT_TIMEOUT_MS,
  });
  await expect(page.getByTestId("chat-scroll-area")).toContainText(current);
  await expect(page.getByTestId("send-turn-button")).toHaveAttribute("aria-label", "已完成", {
    timeout: AGENT_OUTPUT_TIMEOUT_MS,
  });
  const after = await readTimeline(page, host.id, history.threadId);
  expect(after.slice(0, before.length)).toEqual(before);
  await page.getByTestId(`thread-button-${history.threadId}`).click({ button: "right" });
  await page.getByRole("menuitem", { name: /置顶/ }).click();
  await reloadApp(page);
  await page.getByTestId(`pinned-thread-button-${history.threadId}`).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("cwd") === current);
  await expect(page.getByTestId(`project-button-${history.cwd}`)).toHaveCount(0);
  await expect(page.getByTestId("chat-scroll-area")).toContainText(fileMarker);
});

test("editing a mapped historical thread keeps its original timeline and runs the real branch in the canonical workspace", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const root = `/home/codex/edit-alias-${randomUUID()}`;
  const history = await createEditHistory(remoteWorkspace.remote, { cwd: `${root}/old/Thesis` });
  const before = await verifyEditHistory(page, host.id, history);
  const current = `${root}/current/Thesis`;
  const fileMarker = `BRANCH_FILE_${randomUUID()}`;
  await execRemoteSsh(
    remoteWorkspace.remote,
    `mkdir -p ${shellQuote(current)}; printf '%s' ${shellQuote(fileMarker)} > ${shellQuote(`${current}/keep.txt`)}`,
  );
  await openHistory(page, host.id, history.threadId);
  await configureAliases(page, host.id, [{ originalPath: history.cwd, workspacePath: current }]);
  await execRemoteSsh(remoteWorkspace.remote, `rm -rf ${shellQuote(history.cwd)}`);
  const bubble = page.locator(`[data-testid="user-message"][data-turn-id="${history.turnIds[1]}"]`);
  await bubble.getByTestId("edit-user-message").click();
  const input = page.getByTestId("user-message-edit-input");
  await input.fill(
    "Execute pwd and read keep.txt from your actual working directory. Reply with the actual directory and exact file contents. Do not modify files.",
  );
  await input.press("Control+Enter");
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("threadId") !== history.threadId &&
      url.searchParams.get("cwd") === current,
    { timeout: 120_000 },
  );
  await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
  await expect(page.getByTestId("chat-scroll-area")).toContainText(fileMarker, {
    timeout: AGENT_OUTPUT_TIMEOUT_MS,
  });
  await expect(page.getByTestId("chat-scroll-area")).toContainText(current);
  expect(await readTimeline(page, host.id, history.threadId)).toEqual(before);
  await page.getByTestId("return-to-original").click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("threadId") === history.threadId &&
      url.searchParams.get("cwd") === current,
  );
  await expect(page.getByTestId(`project-button-${history.cwd}`)).toHaveCount(0);
});
