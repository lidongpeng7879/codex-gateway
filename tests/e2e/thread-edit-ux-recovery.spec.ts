import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp } from "./helpers/app";
import { z } from "zod";
import { gatewayThreadSchema } from "../../shared/runtime/app-server";
import {
  createEditHistory,
  openHistory,
  readTimeline,
  verifyEditHistory,
} from "./helpers/thread-edit";
import { paintedFrames, startEditUxTrace, stopEditUxTrace } from "./helpers/edit-ux-trace";
import {
  parseRealtimeClientMessage,
  parseRealtimeServerMessage,
} from "../../shared/runtime/realtime";
import { AGENT_OUTPUT_TIMEOUT_MS } from "./helpers/timeouts";
import { execRemoteSsh, selectSidebarThread } from "./helpers/remote-codex";
import { shellQuote } from "../../server/utils/gateway/infra/ssh/shell";
import { randomUUID } from "node:crypto";

import { prepareManagedDaemon } from "./helpers/host-daemon";

// Focused experience runs provision the verified official fixture independently of upgrade tests.
test.beforeEach(async ({ remoteWorkspace }) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
});

test("a fresh browser restores the official thread directory and its sibling rows after default-directory bootstrap", async ({
  browser,
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const suffix = randomUUID();
  const other = await createEditHistory(remoteWorkspace.remote, {
    cwd: `/home/codex/aa-bootstrap-${suffix}`,
  });
  const source = await createEditHistory(remoteWorkspace.remote, {
    cwd: `/home/codex/zz-restored-${suffix}`,
  });
  const sibling = await createEditHistory(remoteWorkspace.remote, { cwd: source.cwd });
  for (const history of [other, source, sibling]) await verifyEditHistory(page, host.id, history);
  await page.evaluate(
    (hostId) => window.__codexGatewayE2e!.navigation.refreshHostProjects(hostId),
    host.id,
  );
  await openHistory(page, host.id, source.threadId);
  await expect(page).toHaveURL((url) => url.searchParams.get("cwd") === source.cwd);
  const context = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    const restored = await context.newPage();
    let restoredDirectoryRequests = 0;
    restored.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/threads" && url.searchParams.get("cwd") === source.cwd)
        restoredDirectoryRequests++;
    });
    // A fresh browser starts at /, so bootstrap must first choose a default directory before
    // restoring browser-local last-open identity from its authoritative official snapshot.
    await openApp(restored, { resetConfig: false, interceptRealtime: false });
    await expect(restored).toHaveURL(
      (url) =>
        url.searchParams.get("threadId") === source.threadId &&
        url.searchParams.get("cwd") === source.cwd,
    );
    await expect(restored.getByTestId(`thread-button-${sibling.threadId}`)).toBeVisible();
    await expect(restored.getByTestId(`thread-button-${other.threadId}`)).toHaveCount(0);
    expect(restoredDirectoryRequests).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("two official empty conversations remain reachable while awaiting durable index membership", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const { project } = await remoteWorkspace.provision();
  const first = await remoteWorkspace.startThread(project.remotePath);
  const second = await remoteWorkspace.startThread(project.remotePath);
  await expect(page.getByTestId(`thread-button-${first}`)).toBeVisible();
  await expect(page.getByTestId(`thread-button-${second}`)).toBeVisible();
  await selectSidebarThread(page, first);
  await page.getByTestId(`project-button-${project.remotePath}`).click();
  await expect(page.getByTestId(`project-thread-row-${first}`)).toBeVisible();
  await expect(page.getByTestId(`project-thread-row-${second}`)).toBeVisible();
  await selectSidebarThread(page, second);
});

test("native HTTP pages keep their size and membership when several official snapshots are cached", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const cwd = `/home/codex/pagination-${randomUUID()}`;
  await execRemoteSsh(remoteWorkspace.remote, `mkdir -p ${shellQuote(cwd)}`);
  const { host } = await remoteWorkspace.provision({ remotePath: cwd });
  const threadIds: string[] = [];
  // Establish actual indexed conversations through thread/start + a real model turn. Imported
  // rollouts with identical fixture timestamps do not define native cursor membership reliably.
  for (let index = 0; index < 4; index++) {
    threadIds.push(await remoteWorkspace.startThread(cwd));
    const marker = `pagination-${index}-${Date.now()}`;
    await page
      .getByPlaceholder("输入后续修改要求")
      .fill(`Only reply ${marker}. Do not use tools or change files.`);
    await page.getByTestId("send-turn-button").click();
    await expect(
      page.getByTestId("chat-scroll-area").locator(".is-assistant").last(),
    ).toContainText(marker, { timeout: AGENT_OUTPUT_TIMEOUT_MS });
    await expect(page.getByTestId("send-turn-button")).toHaveAttribute("aria-label", "已完成", {
      timeout: AGENT_OUTPUT_TIMEOUT_MS,
    });
  }
  await openHistory(page, host.id, threadIds[0]!);
  const schema = z.object({
    data: z.array(gatewayThreadSchema),
    nextCursor: z.string().nullable(),
  });
  let cursor: string | null = null;
  const seen = new Set<string>();
  const cursors = new Set<string>();
  do {
    const query = new URLSearchParams({ hostId: String(host.id), cwd, limit: "2" });
    if (cursor !== null) query.set("cursor", cursor);
    const response = await authenticatedFetch(page, { url: `/api/threads?${query}` }, (value) =>
      schema.parse(value),
    );
    expect(response.data.length).toBeLessThanOrEqual(2);
    for (const thread of response.data) {
      expect(thread.cwd).toBe(cwd);
      expect(seen.has(thread.id)).toBe(false);
      seen.add(thread.id);
    }
    cursor = response.nextCursor;
    if (cursor !== null) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
  } while (cursor !== null);
  expect([...seen].sort()).toEqual(threadIds.sort());
});

test("a real search response delivered after the unfiltered page cannot replace the newer directory list", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const source = await createEditHistory(remoteWorkspace.remote);
  const other = await createEditHistory(remoteWorkspace.remote, { cwd: source.cwd });
  await verifyEditHistory(page, host.id, source);
  await verifyEditHistory(page, host.id, other);
  await openHistory(page, host.id, source.threadId);
  const gate = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let held = false;
  await page.route("**/api/threads?**", async (route) => {
    if (!held && new URL(route.request().url()).searchParams.has("searchTerm")) {
      held = true;
      const response = await route.fetch();
      captured.resolve();
      await gate.promise;
      await route.fulfill({ response });
      delivered.resolve();
    } else await route.continue();
  });
  try {
    await page.evaluate((term) => {
      void window.__codexGatewayE2e!.navigation.listThreads(term);
    }, source.threadId);
    await captured.promise;
    await page.evaluate(() => window.__codexGatewayE2e!.navigation.listThreads());
    await expect(page.getByTestId(`thread-button-${other.threadId}`)).toBeVisible();
    gate.resolve();
    await delivered.promise;
    await paintedFrames(page);
    await expect(page.getByTestId(`thread-button-${other.threadId}`)).toBeVisible();
    expect(await page.evaluate(() => window.__codexGatewayE2e!.views.loading)).toBe(false);
  } finally {
    gate.resolve();
  }
});

test("actual host and project clicks invalidate an old page across an away-and-back selection", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  await openApp(page, { interceptRealtime: false });
  const first = await remoteWorkspace.addHost();
  const source = await createEditHistory(remoteWorkspace.remote);
  await verifyEditHistory(page, first.id, source);
  const second = await remoteWorkspace.addHost();
  const other = await createEditHistory(remoteWorkspace.remote);
  await verifyEditHistory(page, second.id, other);
  await openHistory(page, first.id, source.threadId);
  const gate = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let held = false;
  await page.route("**/api/threads?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      !held &&
      url.searchParams.get("hostId") === String(first.id) &&
      url.searchParams.get("cwd") === source.cwd
    ) {
      held = true;
      const response = await route.fetch();
      captured.resolve();
      await gate.promise;
      await route.fulfill({ response });
      delivered.resolve();
    } else await route.continue();
  });
  try {
    await page.evaluate(() => {
      void window.__codexGatewayE2e!.navigation.listThreads();
    });
    await captured.promise;
    const newer = await createEditHistory(remoteWorkspace.remote, { cwd: source.cwd });
    await verifyEditHistory(page, first.id, newer);
    await startEditUxTrace(page);
    await page.getByTestId(`host-button-${second.id}`).click();
    await page
      .getByTestId(`host-tree-${second.id}`)
      .getByTestId(`project-button-${other.cwd}`)
      .click();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("hostId") === String(second.id) &&
        url.searchParams.get("cwd") === other.cwd,
    );
    await expect(page.getByTestId(`thread-button-${source.threadId}`)).toHaveCount(0);
    await paintedFrames(page);
    await page.getByTestId(`host-button-${first.id}`).click();
    await page
      .getByTestId(`host-tree-${first.id}`)
      .getByTestId(`project-button-${source.cwd}`)
      .click();
    await expect(page.getByTestId(`thread-button-${newer.threadId}`)).toBeVisible();
    gate.resolve();
    await delivered.promise;
    await paintedFrames(page);
    await expect(page.getByTestId(`thread-button-${newer.threadId}`)).toBeVisible();
    const frames = await stopEditUxTrace(page);
    await testInfo.attach("actual-host-selection-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(
      frames
        .filter((frame) => frame.hostId === second.id && frame.cwd === other.cwd)
        .every((frame) => !frame.rows.includes(source.threadId)),
    ).toBe(true);
  } finally {
    gate.resolve();
  }
});

test("a lost history response after accepted revision recovers without a second fork or send", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  let branchId = "";
  let forks = 0;
  let revisions = 0;
  let accepted = false;
  let dropped = false;
  const failureSeen = Promise.withResolvers<void>();
  await page.routeWebSocket(/\/api\/realtime$/, (route) => {
    const upstream = route.connectToServer();
    route.onMessage((raw) => {
      if (typeof raw === "string") {
        const message = parseRealtimeClientMessage(JSON.parse(raw));
        if (message.type === "thread.fork") forks++;
        if (message.type === "turn.revise") revisions++;
      }
      upstream.send(raw);
    });
    upstream.onMessage((raw) => {
      if (typeof raw === "string") {
        const message = parseRealtimeServerMessage(JSON.parse(raw));
        if (message.type === "thread.forked") branchId = message.threadId;
        if (message.type === "turn.revise.accepted") accepted = true;
        if (
          accepted &&
          !dropped &&
          message.type === "thread.snapshot" &&
          message.thread.id === branchId
        ) {
          dropped = true;
          void route.close({
            code: 1011,
            reason: "E2E lost history response after accepted revision",
          });
          void upstream.close();
          failureSeen.resolve();
          return;
        }
      }
      route.send(raw);
    });
  });
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const source = await createEditHistory(remoteWorkspace.remote);
  const original = await verifyEditHistory(page, host.id, source);
  await openHistory(page, host.id, source.threadId);
  await page
    .locator(`[data-testid="user-message"][data-turn-id="${source.turnIds[1]}"]`)
    .getByTestId("edit-user-message")
    .click();
  const marker = `history-recovery-${Date.now()}`;
  await page
    .getByTestId("user-message-edit-input")
    .fill(`Only reply ${marker}. Do not use tools or modify files.`);
  await page.getByTestId("save-message-edit").click();
  await failureSeen.promise;
  await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
  await expect(page.getByTestId("retry-revision-send")).toHaveCount(0);
  await expect(page.getByTestId("check-revision-status")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__codexGatewayE2e!.realtime.connected))
    .toBe(true);
  // Re-open the same official identity through the normal view action, never resubmit the command.
  await page.evaluate(
    ({ hostId, threadId, cwd }) =>
      window.__codexGatewayE2e!.views.openThread(threadId, { hostId, cwd }),
    { hostId: host.id, threadId: branchId, cwd: source.cwd },
  );
  await expect(page).toHaveURL(new RegExp(`threadId=${branchId}`));
  await expect(page.getByTestId("chat-scroll-area").locator(".is-assistant").last()).toContainText(
    marker,
    { timeout: AGENT_OUTPUT_TIMEOUT_MS },
  );
  expect(forks).toBe(1);
  expect(revisions).toBe(1);
  expect(await readTimeline(page, host.id, source.threadId)).toEqual(original);
});
