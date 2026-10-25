import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp, reloadApp } from "./helpers/app";
import { sendRealtimeRawRequest, sendRealtimeRequest } from "./helpers/realtime";
import {
  createEditHistory,
  openHistory,
  primaryUser,
  readTimeline,
  userTexts,
  verifyEditHistory,
} from "./helpers/thread-edit";
import {
  parseRealtimeClientMessage,
  parseRealtimeServerMessage,
} from "../../shared/runtime/realtime";
import { AGENT_OUTPUT_TIMEOUT_MS } from "./helpers/timeouts";

for (const historyMode of ["paginated"] as const) {
  test(`forks first, middle and older paginated boundaries from real ${historyMode} history without changing source or files`, async ({
    page,
    remoteWorkspace,
  }) => {
    await openApp(page, { interceptRealtime: false });
    const { host } = await remoteWorkspace.provision();
    const history = await createEditHistory(remoteWorkspace.remote, { count: 40, historyMode });
    const original = await verifyEditHistory(page, host.id, history);
    await openHistory(page, host.id, history.threadId);
    expect(original.length).toBeGreaterThan(100);
    expect(userTexts(original)).toEqual(history.texts);
    const hash = await history.hash();
    for (const index of [0, 20, 2]) {
      const turnId = history.turnIds[index]!;
      const item = primaryUser(original, turnId);
      const request = {
        type: "thread.fork" as const,
        requestId: randomUUID(),
        hostId: host.id,
        threadId: history.threadId,
        beforeTurnId: turnId,
        itemId: item.id,
        editId: randomUUID(),
      };
      const response = await sendRealtimeRequest(page, request);
      if (response.type !== "thread.forked") throw new Error("Expected real branch");
      const repeated = await sendRealtimeRequest(page, request);
      expect(repeated.type === "thread.forked" && repeated.threadId).toBe(response.threadId);
      const opened = await sendRealtimeRequest(page, {
        type: "thread.activate",
        requestId: randomUUID(),
        hostId: host.id,
        threadId: response.threadId,
      });
      if (opened.type !== "thread.snapshot") throw new Error("Expected official branch snapshot");
      expect(opened.thread.forkedFromId).toBe(history.threadId);
      expect(opened.thread.parentThreadId).toBeNull();
      expect(opened.runtimeStatus).not.toBe("running");
      expect(userTexts(await readTimeline(page, host.id, response.threadId))).toEqual(
        history.texts.slice(0, index),
      );
      // Middle branch hydration must retain its real older-page cursor, not an empty creation snapshot.
      if (index === 20) expect(opened.oldestTimelineCursor).not.toBeNull();
    }
    expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
    expect(await history.hash()).toBe(hash);
  });
}

test("inline edit cancels accessibly, retains separate draft/uploads and survives virtual unmount; rejects foreign and steer identities", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const history = await createEditHistory(remoteWorkspace.remote, {
    count: 45,
    attachments: true,
    steer: true,
  });
  const original = await verifyEditHistory(page, host.id, history);
  await openHistory(page, host.id, history.threadId);
  const sourceHash = await history.hash();
  const draft = page.getByPlaceholder("输入后续修改要求");
  await draft.fill("Keep this independent composer draft");
  await page.getByRole("button", { name: "附加文件或图片" }).click();
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/uploads" && response.request().method() === "POST",
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft attachment"),
  });
  expect((await uploaded).ok()).toBe(true);
  await expect(page.getByText("draft.txt", { exact: true })).toBeVisible();
  const targetTurn = history.turnIds.at(-1)!;
  await page.evaluate(async () => {
    const driver = window.__codexGatewayE2e!;
    while (driver.views.oldestTimelineCursor !== null) await driver.turns.loadOlderTurns();
  });
  // Locate by the canonical turn attribute rather than timeline row position.
  const target = page.locator(`[data-testid="user-message"][data-turn-id="${targetTurn}"]`);
  await target.getByTestId("edit-user-message").click();
  const input = page.getByTestId("user-message-edit-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(history.texts.at(-1)!);
  await expect(page.getByTestId("edit-context-warning")).toBeVisible();
  await page
    .getByTestId("user-message-editor")
    .screenshot({ path: testInfo.outputPath("desktop-editor.png") });
  await input.fill("   ");
  await expect(page.getByTestId("save-message-edit")).toBeDisabled();
  await input.fill("A separate revision");
  await input.press("Enter");
  await expect(input).toHaveValue("A separate revision\n");
  await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
  await expect(input).toBeVisible();
  // Force the edited virtual row offscreen and back using the real timeline scroll viewport.
  const viewport = page
    .getByTestId("chat-scroll-area")
    .locator('[data-slot="scroll-area-viewport"]');
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(input).toHaveCount(0);
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(input).toHaveValue("A separate revision\n");
  await input.press("Escape");
  await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
  await expect(target.getByTestId("edit-user-message")).toBeFocused();
  await expect(draft).toHaveText("Keep this independent composer draft");
  await expect(page.getByText("draft.txt", { exact: true })).toBeVisible();
  const turnId = history.turnIds[1]!;
  const primary = primaryUser(original, turnId);
  const secondary = original.find(
    (entry) =>
      entry.type === "item" &&
      entry.turnId === turnId &&
      entry.item.type === "userMessage" &&
      entry.item.id !== primary.id,
  );
  if (!secondary || secondary.type !== "item") throw new Error("Missing real steer item");
  for (const invalid of [
    { hostId: host.id + 100000, threadId: history.threadId, turnId, itemId: primary.id },
    { hostId: host.id, threadId: history.threadId, turnId: randomUUID(), itemId: primary.id },
    {
      hostId: host.id,
      threadId: history.threadId,
      turnId: `client-${randomUUID()}`,
      itemId: primary.id,
    },
    { hostId: host.id, threadId: history.threadId, turnId, itemId: secondary.item.id },
  ]) {
    expect(
      (
        await sendRealtimeRawRequest(page, {
          type: "thread.edit.read",
          requestId: randomUUID(),
          ...invalid,
        })
      ).type,
    ).toBe("error");
    expect(
      (
        await sendRealtimeRawRequest(page, {
          type: "thread.fork",
          requestId: randomUUID(),
          hostId: invalid.hostId,
          threadId: invalid.threadId,
          beforeTurnId: invalid.turnId,
          itemId: invalid.itemId,
          editId: randomUUID(),
        })
      ).type,
    ).toBe("error");
  }
  expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
  expect(await history.hash()).toBe(sourceHash);
});

test("rejects unsupported original structured input and unrelated revision destinations", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const history = await createEditHistory(remoteWorkspace.remote, { audio: true });
  const original = await verifyEditHistory(page, host.id, history);
  await openHistory(page, host.id, history.threadId);
  const turnId = history.turnIds[1]!;
  const item = primaryUser(original, turnId);
  const response = await sendRealtimeRawRequest(page, {
    type: "thread.fork",
    requestId: randomUUID(),
    hostId: host.id,
    threadId: history.threadId,
    beforeTurnId: turnId,
    itemId: item.id,
    editId: randomUUID(),
  });
  expect(response.type).toBe("error");
  expect(
    (
      await sendRealtimeRawRequest(page, {
        type: "turn.revise",
        requestId: randomUUID(),
        hostId: host.id,
        threadId: history.threadId,
        sourceThreadId: history.threadId,
        turnId,
        itemId: item.id,
        text: "Never send to original",
      })
    ).type,
  ).toBe("error");
  expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
});

test("real revised send preserves attachment/source/draft, retries lost acknowledgement on the same branch, and restores origin after reload", async ({
  page,
  context,
  browser,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  let dropAcknowledgement = true;
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
    upstream.onMessage((raw) => {
      if (typeof raw === "string") {
        const message = parseRealtimeServerMessage(JSON.parse(raw));
        if (message.type === "turn.revise.accepted" && dropAcknowledgement) {
          dropAcknowledgement = false;
          // Inject only a transport failure AFTER the real SSH/app-server accepted the send.
          void route.close({ code: 1011, reason: "E2E lost revised-send acknowledgement" });
          void upstream.close();
          return;
        }
      }
      route.send(raw);
    });
  });
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const history = await createEditHistory(remoteWorkspace.remote, { attachments: true });
  const original = await verifyEditHistory(page, host.id, history);
  await openHistory(page, host.id, history.threadId);
  const hash = await history.hash();
  const observerContext = await browser.newContext({ storageState: await context.storageState() });
  const observer = await observerContext.newPage();
  await openApp(observer, { resetConfig: false, interceptRealtime: false });
  await openHistory(observer, host.id, history.threadId);
  await page.getByPlaceholder("输入后续修改要求").fill("Original draft must stay here");
  const sourceSettings = await page.evaluate(
    () => window.__codexGatewayE2e!.composer.selectedThreadSettings,
  );
  await page.getByRole("button", { name: "附加文件或图片" }).click();
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/uploads" && response.request().method() === "POST",
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "source-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("source draft attachment"),
  });
  expect((await uploaded).ok()).toBe(true);
  await expect(page.getByText("source-draft.txt", { exact: true })).toBeVisible();
  const turnId = history.turnIds[1]!;
  const bubble = page.locator(`[data-testid="user-message"][data-turn-id="${turnId}"]`);
  await bubble.getByTestId("edit-user-message").click();
  const input = page.getByTestId("user-message-edit-input");
  await expect(input).toHaveValue(history.texts[1]!);
  await expect(bubble.getByTestId("thread-image-attachment")).toBeVisible();
  const marker = `revision-${Date.now()}`;
  const revised = `${history.texts[1]}\n\nOnly reply exactly ${marker}. Do not run tools or modify any files.`;
  await input.fill(revised);
  await input.press("Control+Enter");
  // Pending UI suppresses repeated keyboard submission; no new fork or steer is issued.
  await input.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
  await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
  await expect(page.getByTestId("check-revision-status")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("check-revision-status").click();
  await expect(page.getByTestId("thread-revision-status")).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId("thread-branch-origin")).toBeVisible({ timeout: 120_000 });
  await expect(page).toHaveURL((url) => {
    const selected = url.searchParams.get("threadId");
    return selected !== null && selected !== history.threadId;
  });
  const branchId = new URL(page.url()).searchParams.get("threadId");
  expect(branchId).not.toBe(history.threadId);
  expect(branchId).not.toBeNull();
  expect(forks).toBe(1);
  expect(revisions).toBe(2);
  await expect(page.getByTestId("chat-scroll-area").locator(".is-assistant").last()).toContainText(
    marker,
    { timeout: AGENT_OUTPUT_TIMEOUT_MS },
  );
  await expect(page.getByTestId("send-turn-button")).toHaveAttribute("aria-label", "已完成", {
    timeout: AGENT_OUTPUT_TIMEOUT_MS,
  });
  const branch = await readTimeline(page, host.id, branchId!);
  expect(userTexts(branch)).toEqual([history.texts[0], revised]);
  const revisedItem = branch.find(
    (entry) =>
      entry.type === "item" &&
      entry.item.type === "userMessage" &&
      entry.turnId !== history.turnIds[0],
  );
  if (!revisedItem || revisedItem.type !== "item")
    throw new Error("Missing revised official user input");
  const originalItem = primaryUser(original, turnId);
  const nonText = (value: unknown): unknown[] => {
    const parts: unknown[] = Array.isArray(value) ? value : [];
    return parts.filter(
      (part) => part !== null && typeof part === "object" && "type" in part && part.type !== "text",
    );
  };
  expect(nonText(revisedItem.item.content)).toEqual(nonText(originalItem.content));
  expect(await readTimeline(observer, host.id, history.threadId)).toEqual(original);
  expect(await history.hash()).toBe(hash);
  await page.getByTestId("return-to-original").click();
  await expect(page).toHaveURL(new RegExp(`threadId=${history.threadId}`));
  await expect(page.getByPlaceholder("输入后续修改要求")).toHaveText(
    "Original draft must stay here",
  );
  await expect(page.getByText("source-draft.txt", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => window.__codexGatewayE2e!.composer.selectedThreadSettings),
  ).toEqual(sourceSettings);
  await page.goBack();
  await expect(page.getByTestId("thread-branch-origin")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`threadId=${history.threadId}`));
  await expect(page.getByTestId("thread-branch-origin")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByTestId("thread-branch-origin")).toBeVisible();
  await reloadApp(page);
  await expect(page.getByTestId("return-to-original")).toBeVisible();
  await page.getByTestId("return-to-original").click();
  await expect(page).toHaveURL(new RegExp(`threadId=${history.threadId}`));
  await observer.evaluate(() => window.__codexGatewayE2e!.navigation.listThreads());
  expect(
    await observer.evaluate(
      (branchId) =>
        window.__codexGatewayE2e!.navigation.threads.some(
          (thread) => thread.id === branchId && thread.parentThreadId === null,
        ),
      branchId,
    ),
  ).toBe(true);
  await page.goBack();
  await expect(page.getByTestId("thread-branch-origin")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`threadId=${history.threadId}`));
  await observerContext.close();
});

test("legacy history is explicitly rejected by the pinned app-server without creating a branch", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const history = await createEditHistory(remoteWorkspace.remote, { historyMode: "legacy" });
  const hash = await history.hash();
  const timeline = await sendRealtimeRawRequest(page, {
    type: "thread.timeline.load",
    requestId: randomUUID(),
    hostId: host.id,
    threadId: history.threadId,
    cursor: null,
    limit: 100,
  });
  expect(timeline.type).toBe("error");
  if (timeline.type === "error") expect(timeline.message).toContain("not supported yet");
  const fork = await sendRealtimeRawRequest(page, {
    type: "thread.fork",
    requestId: randomUUID(),
    hostId: host.id,
    threadId: history.threadId,
    beforeTurnId: history.turnIds[1]!,
    itemId: history.userItemIds[1]!,
    editId: randomUUID(),
  });
  expect(fork.type).toBe("error");
  if (fork.type === "error") expect(fork.message).toContain("legacy conversation is not supported");
  expect(await history.hash()).toBe(hash);
});
