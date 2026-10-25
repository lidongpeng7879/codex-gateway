import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { sendRealtimeRequest } from "./helpers/realtime";
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

import { prepareManagedDaemon } from "./helpers/host-daemon";

// Focused experience runs provision the verified official fixture independently of upgrade tests.
test.beforeEach(async ({ remoteWorkspace }) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
});

test("fork confirmation retires the editor, commits the branch URL and keeps the directory/sidebar stable before delayed acceptance", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  test.setTimeout(6 * 60_000);
  const ack = Promise.withResolvers<void>();
  const snapshot = Promise.withResolvers<void>();
  let branchId = "";
  let forks = 0;
  let revisions = 0;
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
    upstream.onMessage(async (raw) => {
      if (typeof raw === "string") {
        const message = parseRealtimeServerMessage(JSON.parse(raw));
        if (message.type === "thread.forked") branchId = message.threadId;
        if (message.type === "turn.revise.accepted") await ack.promise;
        if (message.type === "thread.snapshot" && message.thread.id === branchId)
          await snapshot.promise;
      }
      route.send(raw);
    });
  });
  try {
    await openApp(page, { interceptRealtime: false });
    const { host } = await remoteWorkspace.provision();
    const history = await createEditHistory(remoteWorkspace.remote, { attachments: true });
    const original = await verifyEditHistory(page, host.id, history);
    await openHistory(page, host.id, history.threadId);
    const workspaceHash = await history.workspaceHash();
    await page.getByPlaceholder("输入后续修改要求").fill("Keep this source draft");
    const bubble = page.locator(
      `[data-testid="user-message"][data-turn-id="${history.turnIds[1]}"]`,
    );
    await bubble.getByTestId("edit-user-message").click();
    const input = page.getByTestId("user-message-edit-input");
    const marker = `ux-${Date.now()}`;
    await input.fill(`Only reply ${marker}. Do not use tools or change files.`);
    await startEditUxTrace(page);
    await input.evaluate((element) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("threadId") === branchId && branchId !== "",
      { timeout: 120_000 },
    );
    await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
    await expect(page.getByTestId("thread-revision-status")).toHaveAttribute(
      "data-state",
      "pending",
    );
    await expect(page.getByTestId(`thread-button-${branchId}`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    await paintedFrames(page);
    // Identity is committed without resuming the fork. The real acceptance starts hydration;
    // keep that snapshot delayed too, without fabricating either response.
    ack.resolve();
    await expect(page.getByTestId("thread-revision-status")).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId(`thread-button-${branchId}`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    await paintedFrames(page);
    snapshot.resolve();
    await expect(page.getByTestId("thread-branch-origin")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
    await paintedFrames(page);
    await expect(page.getByTestId("thread-revision-status")).toHaveCount(0, { timeout: 120_000 });
    await expect(
      page.getByTestId("chat-scroll-area").locator(".is-assistant").last(),
    ).toContainText(marker, { timeout: AGENT_OUTPUT_TIMEOUT_MS });
    await paintedFrames(page);
    const frames = await stopEditUxTrace(page);
    await testInfo.attach("painted-handoff-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(frames.length).toBeGreaterThan(2);
    expect(frames.every((frame) => frame.hostId === host.id && frame.cwd === history.cwd)).toBe(
      true,
    );
    const branchFrames = frames.filter((frame) => frame.threadId === branchId);
    expect(branchFrames.length).toBeGreaterThan(2);
    expect(
      branchFrames.every(
        (frame) =>
          frame.rows.filter((id) => id === branchId).length === 1 &&
          frame.selected.includes(branchId),
      ),
    ).toBe(true);
    expect(new Set(branchFrames.map((frame) => frame.rows.indexOf(branchId))).size).toBe(1);
    expect(forks).toBe(1);
    expect(revisions).toBe(1);
    await page.getByTestId("return-to-original").click();
    await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
    await expect(bubble).toContainText(history.texts[1]!);
    await expect(page.getByPlaceholder("输入后续修改要求")).toHaveText("Keep this source draft");
    expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
    expect(await history.workspaceHash()).toBe(workspaceHash);
  } finally {
    ack.resolve();
    snapshot.resolve();
  }
});

test("a late successful fork finishes without stealing a different user-selected conversation or restoring its editor", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  const forkGate = Promise.withResolvers<void>();
  const forkSeen = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  let branchId = "";
  await page.routeWebSocket(/\/api\/realtime$/, (route) => {
    const upstream = route.connectToServer();
    route.onMessage((raw) => upstream.send(raw));
    upstream.onMessage(async (raw) => {
      if (typeof raw === "string") {
        const message = parseRealtimeServerMessage(JSON.parse(raw));
        if (message.type === "thread.forked") {
          branchId = message.threadId;
          forkSeen.resolve();
          await forkGate.promise;
        }
        if (message.type === "turn.revise.accepted") accepted.resolve();
      }
      route.send(raw);
    });
  });
  try {
    await openApp(page, { interceptRealtime: false });
    const { host } = await remoteWorkspace.provision();
    const source = await createEditHistory(remoteWorkspace.remote);
    const other = await createEditHistory(remoteWorkspace.remote, { cwd: source.cwd });
    await verifyEditHistory(page, host.id, source);
    await verifyEditHistory(page, host.id, other);
    await openHistory(page, host.id, source.threadId);
    await page.evaluate(() => window.__codexGatewayE2e!.navigation.listThreads());
    const bubble = page.locator(
      `[data-testid="user-message"][data-turn-id="${source.turnIds[1]}"]`,
    );
    await bubble.getByTestId("edit-user-message").click();
    await page
      .getByTestId("user-message-edit-input")
      .fill("Only reply OK. Do not use tools or change files.");
    await page.getByTestId("save-message-edit").click();
    await forkSeen.promise;
    await page.getByTestId(`thread-button-${other.threadId}`).click();
    await expect(page).toHaveURL(new RegExp(`threadId=${other.threadId}`));
    forkGate.resolve();
    await accepted.promise;
    await paintedFrames(page);
    await expect(page).toHaveURL(new RegExp(`threadId=${other.threadId}`));
    await expect
      .poll(
        () =>
          page.evaluate(
            (key) => window.__codexGatewayE2e!.runtime.unviewedCompletedThreadKeys.includes(key),
            `${host.id}:${branchId}`,
          ),
        { timeout: AGENT_OUTPUT_TIMEOUT_MS },
      )
      .toBe(true);
    await page.evaluate(() => window.__codexGatewayE2e!.navigation.listThreads());
    await expect(
      page.getByTestId(`thread-button-${branchId}`).getByLabel("已完成，待查看"),
    ).toBeVisible();
    await page.getByTestId(`thread-button-${source.threadId}`).click();
    await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
    await expect(page.getByTestId("open-revision-branch")).toBeVisible();
    await page.getByTestId("open-revision-branch").click();
    await expect(page).toHaveURL(new RegExp(`threadId=${branchId}`));
    expect(
      await page.evaluate(
        (key) => window.__codexGatewayE2e!.runtime.unviewedCompletedThreadKeys.includes(key),
        `${host.id}:${branchId}`,
      ),
    ).toBe(false);
  } finally {
    forkGate.resolve();
  }
});

test("same-directory HTTP refreshes completed in reverse order never roll back sidebar rows or reload the conversation", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const source = await createEditHistory(remoteWorkspace.remote);
  await verifyEditHistory(page, host.id, source);
  await openHistory(page, host.id, source.threadId);
  const gate = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let hold = true;
  await page.route("**/api/threads?**", async (route) => {
    const url = new URL(route.request().url());
    if (hold && url.searchParams.get("cwd") === source.cwd) {
      hold = false;
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
    expect(await page.evaluate(() => window.__codexGatewayE2e!.views.loading)).toBe(false);
    const newer = await createEditHistory(remoteWorkspace.remote, { cwd: source.cwd });
    await verifyEditHistory(page, host.id, newer);
    await page.evaluate(() => window.__codexGatewayE2e!.navigation.listThreads());
    await expect(page.getByTestId(`thread-button-${newer.threadId}`)).toBeVisible();
    await startEditUxTrace(page);
    gate.resolve();
    await delivered.promise;
    await paintedFrames(page);
    await paintedFrames(page);
    const frames = await stopEditUxTrace(page);
    await testInfo.attach("reverse-response-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.rows.includes(newer.threadId) && !frame.loading)).toBe(
      true,
    );
    await expect(page.getByTestId(`thread-button-${newer.threadId}`)).toBeVisible();
  } finally {
    gate.resolve();
  }
});

test("directory away-and-back invalidates an in-flight page and never paints old-directory sessions under the new directory", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const source = await createEditHistory(remoteWorkspace.remote);
  const other = await createEditHistory(remoteWorkspace.remote);
  await verifyEditHistory(page, host.id, source);
  await verifyEditHistory(page, host.id, other);
  await openHistory(page, host.id, source.threadId);
  const gate = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let hold = true;
  await page.route("**/api/threads?**", async (route) => {
    if (hold && new URL(route.request().url()).searchParams.get("cwd") === source.cwd) {
      hold = false;
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
    // The held page predates this sibling. A fresh page after returning must contain it;
    // accepting the obsolete response would now observably remove a real conversation.
    const newer = await createEditHistory(remoteWorkspace.remote, { cwd: source.cwd });
    await verifyEditHistory(page, host.id, newer);
    await startEditUxTrace(page);
    await page.evaluate(
      ({ hostId, threadId, cwd }) =>
        window.__codexGatewayE2e!.views.openThread(threadId, { hostId, cwd }),
      { hostId: host.id, threadId: other.threadId, cwd: other.cwd },
    );
    await paintedFrames(page);
    await expect(page.getByTestId(`thread-button-${source.threadId}`)).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          loading: window.__codexGatewayE2e!.navigation.loadingThreads,
          ids: window.__codexGatewayE2e!.navigation.threads.map((thread) => thread.id),
        })),
      )
      .toEqual({ loading: false, ids: [other.threadId] });
    await page.evaluate(
      ({ hostId, threadId, cwd }) =>
        window.__codexGatewayE2e!.views.openThread(threadId, { hostId, cwd }),
      { hostId: host.id, threadId: source.threadId, cwd: source.cwd },
    );
    // Opening cached history finishes independently of its directory refresh. Wait for that
    // genuine replacement page, rather than comparing against the previous directory's page.
    await expect
      .poll(() =>
        page.evaluate(() => ({
          loading: window.__codexGatewayE2e!.navigation.loadingThreads,
          ids: window.__codexGatewayE2e!.navigation.threads.map((thread) => thread.id).sort(),
        })),
      )
      .toEqual({ loading: false, ids: [source.threadId, newer.threadId].sort() });
    const before = await page.evaluate(() =>
      window.__codexGatewayE2e!.navigation.threads.map((thread) => thread.id),
    );
    gate.resolve();
    await delivered.promise;
    await paintedFrames(page);
    await paintedFrames(page);
    expect(
      await page.evaluate(() =>
        window.__codexGatewayE2e!.navigation.threads.map((thread) => thread.id),
      ),
    ).toEqual(before);
    const frames = await stopEditUxTrace(page);
    await testInfo.attach("scope-transition-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(
      frames
        .filter((frame) => frame.cwd === other.cwd)
        .every((frame) => !frame.rows.includes(source.threadId)),
    ).toBe(true);
  } finally {
    gate.resolve();
  }
});

test("a delayed idle HTTP snapshot cannot overwrite a real revised turn's running observation", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const history = await createEditHistory(remoteWorkspace.remote);
  await verifyEditHistory(page, host.id, history);
  const fork = await sendRealtimeRequest(page, {
    type: "thread.fork",
    requestId: randomUUID(),
    hostId: host.id,
    threadId: history.threadId,
    beforeTurnId: history.turnIds[1]!,
    itemId: history.userItemIds[1]!,
    editId: randomUUID(),
  });
  if (fork.type !== "thread.forked") throw new Error("Expected official fork");
  await openHistory(page, host.id, fork.threadId);
  const gate = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let hold = true;
  await page.route("**/api/threads?**", async (route) => {
    if (hold && new URL(route.request().url()).searchParams.get("cwd") === history.cwd) {
      hold = false;
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
    await sendRealtimeRequest(page, {
      type: "turn.revise",
      requestId: randomUUID(),
      hostId: host.id,
      threadId: fork.threadId,
      sourceThreadId: history.threadId,
      turnId: history.turnIds[1]!,
      itemId: history.userItemIds[1]!,
      text: "Run the shell command sleep 15, then only reply DONE. Do not modify files.",
    });
    const key = `${host.id}:${fork.threadId}`;
    await expect
      .poll(() =>
        page.evaluate(
          (key) =>
            window.__codexGatewayE2e!.runtime.statusFor(
              Number(key.split(":")[0]),
              key.split(":").slice(1).join(":"),
            ),
          key,
        ),
      )
      .toBe("running");
    await startEditUxTrace(page);
    gate.resolve();
    await delivered.promise;
    await paintedFrames(page);
    await paintedFrames(page);
    const frames = await stopEditUxTrace(page);
    await testInfo.attach("http-versus-live-status-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.statuses[key] === "running")).toBe(true);
    await expect(page.getByTestId("send-turn-button")).toHaveAttribute("aria-label", "已完成", {
      timeout: AGENT_OUTPUT_TIMEOUT_MS,
    });
  } finally {
    gate.resolve();
  }
});
