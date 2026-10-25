import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/remote-workspace";
import { authenticatedFetch, openApp, resetGatewayConfig } from "./helpers/app";
import { addRemoteHost, execRemoteSsh } from "./helpers/remote-codex";
import { sendRealtimeRawRequest, sendRealtimeRequest } from "./helpers/realtime";
import {
  createEditHistory,
  openHistory,
  readTimeline,
  userTexts,
  verifyEditHistory,
} from "./helpers/thread-edit";
import {
  parseRealtimeClientMessage,
  parseRealtimeServerMessage,
} from "../../shared/runtime/realtime";
import { shellQuote } from "../../server/utils/gateway/infra/ssh/shell";
import type { Page } from "@playwright/test";
import type { RealtimeClientMessage } from "../../shared/types";
import { AGENT_OUTPUT_TIMEOUT_MS } from "./helpers/timeouts";

type History = Awaited<ReturnType<typeof createEditHistory>>;
async function forkBoundary(page: Page, hostId: number, history: History, index = 1) {
  const result = await sendRealtimeRequest(page, {
    type: "thread.fork",
    requestId: randomUUID(),
    hostId,
    threadId: history.threadId,
    beforeTurnId: history.turnIds[index]!,
    itemId: history.userItemIds[index]!,
    editId: randomUUID(),
  });
  if (result.type !== "thread.forked") throw new Error("Expected official fork identity");
  return result.threadId;
}
function revision(
  hostId: number,
  branchId: string,
  history: History,
  text: string,
): Extract<RealtimeClientMessage, { type: "turn.revise" }> {
  return {
    type: "turn.revise",
    requestId: randomUUID(),
    hostId,
    threadId: branchId,
    sourceThreadId: history.threadId,
    turnId: history.turnIds[1]!,
    itemId: history.userItemIds[1]!,
    text,
  };
}
async function waitCompleted(page: Page, hostId: number, threadId: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await sendRealtimeRequest(page, {
          type: "thread.activate",
          requestId: randomUUID(),
          hostId,
          threadId,
        });
        return snapshot.type === "thread.snapshot" && snapshot.runtimeStatus === "completed";
      },
      { timeout: AGENT_OUTPUT_TIMEOUT_MS, intervals: [2000, 5000] },
    )
    .toBe(true);
}

test("pre-dispatch real history/connection failure can retry the SAME branch", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const history = await createEditHistory(remoteWorkspace.remote, { structuredReferences: true });
  const original = await verifyEditHistory(page, host.id, history);
  // Restart recovery may append official launch metadata to a loaded rollout; compare its
  // conversation semantically below and hash workspace files independently.
  const hash = await history.workspaceHash();
  const branchId = await forkBoundary(page, host.id, history);
  const request = revision(
    host.id,
    branchId,
    history,
    "Only reply OK. Do not use tools or change files.",
  );
  // A real missing rollout after a daemon restart fails subscription/read before turn/start.
  // Only this new isolated branch is moved. The source and its inherited model context stay intact.
  const backup = `/tmp/gateway-edit-offline-${branchId}.jsonl`;
  const pathFile = `/tmp/gateway-edit-offline-${branchId}.path`;
  await execRemoteSsh(
    remoteWorkspace.remote,
    `set -eu\np=$(find "\${CODEX_HOME:-$HOME/.codex}/sessions" -name '*-${branchId}.jsonl' -print -quit)\ntest -n "$p"\nprintf '%s' "$p" > ${shellQuote(pathFile)}\nmv "$p" ${shellQuote(backup)}`,
  );
  try {
    await sendRealtimeRequest(page, {
      type: "host.daemon.restart",
      requestId: randomUUID(),
      hostId: host.id,
    });
    const failed = await sendRealtimeRawRequest(page, request);
    expect(failed.type).toBe("error");
  } finally {
    await execRemoteSsh(
      remoteWorkspace.remote,
      `set -eu\np=$(cat ${shellQuote(pathFile)})\nmv ${shellQuote(backup)} "$p"\nrm ${shellQuote(pathFile)}`,
    );
    await sendRealtimeRequest(page, {
      type: "host.daemon.restart",
      requestId: randomUUID(),
      hostId: host.id,
    });
  }
  expect(userTexts(await readTimeline(page, host.id, branchId))).toEqual([history.texts[0]]);
  expect((await sendRealtimeRequest(page, request)).type).toBe("turn.revise.accepted");
  await waitCompleted(page, host.id, branchId);
  const revisedHistory = await readTimeline(page, host.id, branchId);
  expect(userTexts(revisedHistory)).toEqual([history.texts[0], request.text]);
  const structured = (entries: typeof original, turnId?: string) =>
    entries.flatMap((entry) => {
      if (
        entry.type !== "item" ||
        entry.item.type !== "userMessage" ||
        entry.turnId === history.turnIds[0] ||
        (turnId !== undefined && entry.turnId !== turnId)
      )
        return [];
      const parts: unknown[] = Array.isArray(entry.item.content) ? entry.item.content : [];
      return parts.filter(
        (part) =>
          part !== null && typeof part === "object" && "type" in part && part.type !== "text",
      );
    });
  expect(structured(revisedHistory)).toEqual(structured(original, history.turnIds[1]));
  expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
  expect(await history.workspaceHash()).toBe(hash);
});

test("ordinary send and revision serialize across authenticated aliases; busy source is rejected", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const alias = await remoteWorkspace.addHost(`edit-alias-${Date.now()}`);
  const history = await createEditHistory(remoteWorkspace.remote);
  const original = await verifyEditHistory(page, host.id, history);
  const branchId = await forkBoundary(page, host.id, history);
  const ordinary = "Run the shell command sleep 15, then only reply NORMAL. Do not change files.";
  const revised = "Only reply REVISION. Do not use tools or change files.";
  // Dispatch both in one browser task. The shared-remote queue covers distinct Host controllers.
  const results = await page.evaluate(
    async ({ hostId, aliasId, branchId, source, ordinary, revised }) => {
      const realtime = window.__codexGatewayE2e!.realtime;
      const normal = realtime.request((requestId) => ({
        type: "turn.start",
        requestId,
        hostId: aliasId,
        threadId: branchId,
        text: ordinary,
      }));
      const revision = realtime.request((requestId) => ({
        type: "turn.revise",
        requestId,
        hostId,
        threadId: branchId,
        sourceThreadId: source.threadId,
        turnId: source.turnIds[1]!,
        itemId: source.userItemIds[1]!,
        text: revised,
      }));
      return Promise.all(
        [normal, revision].map((promise) =>
          promise.then(
            () => "accepted",
            () => "rejected",
          ),
        ),
      );
    },
    {
      hostId: host.id,
      aliasId: alias.id,
      branchId,
      source: {
        threadId: history.threadId,
        turnIds: history.turnIds,
        userItemIds: history.userItemIds,
      },
      ordinary,
      revised,
    },
  );
  expect(results[0]).toBe("accepted");
  const busyFork = await sendRealtimeRawRequest(page, {
    type: "thread.fork",
    requestId: randomUUID(),
    hostId: host.id,
    threadId: branchId,
    beforeTurnId: history.turnIds[0]!,
    itemId: history.userItemIds[0]!,
    editId: randomUUID(),
  });
  expect(busyFork.type).toBe("error");
  if (busyFork.type === "error") expect(busyFork.message).toContain("finish before editing");
  await waitCompleted(page, host.id, branchId);
  const entries = await readTimeline(page, host.id, branchId);
  if (results[1] === "rejected") expect(userTexts(entries)).toEqual([history.texts[0], ordinary]);
  else {
    // Revision may win the queue. The subsequent normal send may legally steer it; a revision
    // must NEVER become a steer on an ordinary turn that won first.
    expect(userTexts(entries)).toEqual([history.texts[0], revised, ordinary]);
    const revisedEntry = entries.find(
      (entry) =>
        entry.type === "item" &&
        entry.item.type === "userMessage" &&
        Array.isArray(entry.item.content) &&
        entry.item.content.some(
          (part: unknown) =>
            part !== null && typeof part === "object" && "text" in part && part.text === revised,
        ),
    );
    if (!revisedEntry || revisedEntry.type !== "item")
      throw new Error("Missing revised official item");
    expect(revisedEntry.turnId).not.toBe(history.turnIds[0]);
  }
  expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
});

for (const [phase, transition] of [
  ["fork", "navigate"],
  ["fork", "logout"],
  ["fork", "lost-fork-ack"],
  ["revision", "navigate"],
  ["revision", "logout"],
] as const) {
  test(`pending ${phase} ${transition} never redirects or duplicates stale revisions`, async ({
    page,
    remoteWorkspace,
  }) => {
    const state: { forks: number; revisions: number; branchId?: string; release?: () => void } = {
      forks: 0,
      revisions: 0,
    };
    await page.routeWebSocket(/\/api\/realtime$/, (route) => {
      const upstream = route.connectToServer();
      route.onMessage((raw) => {
        if (typeof raw === "string") {
          const message = parseRealtimeClientMessage(JSON.parse(raw));
          if (message.type === "thread.fork") state.forks++;
          if (message.type === "turn.revise") state.revisions++;
        }
        upstream.send(raw);
      });
      upstream.onMessage((raw) => {
        if (typeof raw === "string") {
          const message = parseRealtimeServerMessage(JSON.parse(raw));
          if (message.type === "thread.forked") state.branchId = message.threadId;
          if (
            (phase === "fork" && message.type === "thread.forked") ||
            (phase === "revision" && message.type === "turn.revise.accepted")
          ) {
            state.release = () => {
              if (transition === "lost-fork-ack") {
                void route.close({ code: 1011, reason: "E2E lost real fork acknowledgement" });
                void upstream.close();
              } else if (transition !== "logout") route.send(raw);
              // Logout closes the authenticated socket; a late fork acknowledgement cannot be delivered.
            };
            return;
          }
        }
        route.send(raw);
      });
    });
    await openApp(page, { interceptRealtime: false });
    const { host } = await remoteWorkspace.provision();
    const history = await createEditHistory(remoteWorkspace.remote);
    const original = await verifyEditHistory(page, host.id, history);
    const hash = await history.hash();
    const other = await createEditHistory(remoteWorkspace.remote, { count: 1 });
    await verifyEditHistory(page, host.id, other);
    await openHistory(page, host.id, history.threadId);
    await page
      .locator(`[data-testid="user-message"][data-turn-id="${history.turnIds[1]}"]`)
      .getByTestId("edit-user-message")
      .click();
    const text = "Only reply STALE. Do not run tools or modify any files.";
    await page.getByTestId("user-message-edit-input").fill(text);
    await page.getByTestId("save-message-edit").click();
    await expect.poll(() => state.release).toBeTruthy();
    await expect(page.getByTestId("save-message-edit")).toBeDisabled();
    if (transition === "navigate") {
      await page.evaluate(
        ({ hostId, threadId }) => window.__codexGatewayE2e!.views.openThread(threadId, { hostId }),
        { hostId: host.id, threadId: other.threadId },
      );
    } else if (transition === "logout") {
      await authenticatedFetch(page, { url: "/api/auth/logout", method: "POST" }, () => undefined);
      await expect(page.getByTestId("login-form")).toBeVisible();
    }
    state.release!();
    if (transition === "lost-fork-ack") {
      await expect(page.getByTestId("user-message-editor")).toContainText("未能确认分支创建结果");
      await expect(page.getByTestId("save-message-edit")).toBeDisabled();
      await page
        .getByTestId("user-message-edit-input")
        .dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
      expect(new URL(page.url()).searchParams.get("threadId")).toBe(history.threadId);
    } else if (transition === "navigate") {
      await expect(page).toHaveURL(new RegExp(`threadId=${other.threadId}`));
    } else {
      await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
      // Reauthenticate to inspect the real result, not a local-only branch record.
      await openApp(page, { resetConfig: false, interceptRealtime: false });
    }
    if (phase === "revision") await waitCompleted(page, host.id, state.branchId!);
    expect(userTexts(await readTimeline(page, host.id, state.branchId!))).toEqual(
      phase === "fork" ? [history.texts[0]] : [history.texts[0], text],
    );
    expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
    expect(await history.hash()).toBe(hash);
    expect(state.forks).toBe(1);
    expect(state.revisions).toBe(phase === "fork" ? 0 : 1);
    if (transition === "navigate")
      await expect(page).toHaveURL(new RegExp(`threadId=${other.threadId}`));
  });
}

test("host replacement, deletion and reused IDs invalidate capabilities; another real account cannot reuse them", async ({
  page,
  browser,
  remoteWorkspace,
}) => {
  test.setTimeout(4 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  const history = await createEditHistory(remoteWorkspace.remote);
  const original = await verifyEditHistory(page, host.id, history);
  const branchId = await forkBoundary(page, host.id, history);
  const context = await browser.newContext();
  const collaborator = await context.newPage();
  try {
    await collaborator.goto("/");
    await collaborator.getByTestId("login-username").fill("e2e-collaborator");
    await collaborator.getByTestId("login-password").fill("codex-gateway-collaborator-password");
    await collaborator.getByTestId("login-submit").click();
    await expect(collaborator.getByTestId("login-form")).toBeHidden();
    await openApp(collaborator, { interceptRealtime: false });
    const alias = await addRemoteHost(
      collaborator,
      remoteWorkspace.remote,
      "Edit capability other-account host",
    );
    // Prove this account really authenticates and reads the same official branch, not a missing host.
    expect(userTexts(await readTimeline(collaborator, alias.id, branchId))).toEqual([
      history.texts[0],
    ]);
    expect(
      (
        await sendRealtimeRawRequest(
          collaborator,
          revision(alias.id, branchId, history, "Unauthorized capability reuse"),
        )
      ).type,
    ).toBe("error");
    await openHistory(page, host.id, history.threadId);
    const bubble = page.locator(
      `[data-testid="user-message"][data-turn-id="${history.turnIds[1]}"]`,
    );
    await bubble.getByTestId("edit-user-message").click();
    await expect(page.getByTestId("user-message-edit-input")).toHaveValue(history.texts[1]!);
    // A valid equivalent SSH configuration still replaces the connection identity/generation.
    const remote = remoteWorkspace.remote;
    await page.evaluate(
      async ({ hostId, input }) => window.__codexGatewayE2e!.catalog.updateHost(hostId, input),
      {
        hostId: host.id,
        input: {
          name: host.name,
          sshHost: remote.host,
          port: Number(remote.port),
          username: remote.username,
          authMode: "password" as const,
          password: remote.password,
          proxyUrl: remote.proxyUrl ?? null,
          privateKeyPath: "/tmp/unused-edit-key",
        },
      },
    );
    await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
    expect(
      (
        await sendRealtimeRawRequest(
          page,
          revision(host.id, branchId, history, "Obsolete host capability"),
        )
      ).type,
    ).toBe("error");
    const replacementBranch = await forkBoundary(page, host.id, history);
    await page.evaluate((hostId) => window.__codexGatewayE2e!.catalog.deleteHost(hostId), host.id);
    const reused = await addRemoteHost(page, remote, "Reused host id");
    expect(reused.id).toBe(host.id);
    expect(
      (
        await sendRealtimeRawRequest(
          page,
          revision(reused.id, replacementBranch, history, "Deleted host capability"),
        )
      ).type,
    ).toBe("error");
    expect(await readTimeline(page, reused.id, history.threadId)).toEqual(original);
    expect(userTexts(await readTimeline(page, reused.id, branchId))).toEqual([history.texts[0]]);
    expect(userTexts(await readTimeline(page, reused.id, replacementBranch))).toEqual([
      history.texts[0],
    ]);
  } finally {
    await resetGatewayConfig(collaborator);
    await context.close();
  }
});

test("canonical attachment-only, mention/skill and text-span inputs are not silently flattened", async ({
  page,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const { host } = await remoteWorkspace.provision();
  for (const options of [
    { attachmentOnly: true },
    { structuredReferences: true },
    { textSpans: true },
  ]) {
    const history = await createEditHistory(remoteWorkspace.remote, options);
    const original = await verifyEditHistory(page, host.id, history);
    const response = await sendRealtimeRawRequest(page, {
      type: "thread.edit.read",
      requestId: randomUUID(),
      hostId: host.id,
      threadId: history.threadId,
      turnId: history.turnIds[1]!,
      itemId: history.userItemIds[1]!,
    });
    if (options.textSpans === true) {
      expect(response.type).toBe("error");
      if (response.type === "error") expect(response.message).toContain("structured input");
    } else {
      if (response.type !== "thread.edit.snapshot")
        throw new Error("Expected canonical editable input");
      if (options.structuredReferences === true)
        expect(response.attachments).toEqual(["keep.txt", "fixture-skill"]);
      else {
        expect(response.text).toBe("");
        expect(response.attachments).toEqual([remoteWorkspace.remote.imagePath]);
        await openHistory(page, host.id, history.threadId);
        await page
          .locator(`[data-testid="user-message"][data-turn-id="${history.turnIds[1]}"]`)
          .getByTestId("edit-user-message")
          .click();
        await expect(page.getByTestId("save-message-edit")).toBeEnabled();
      }
      await forkBoundary(page, host.id, history);
    }
    expect(await readTimeline(page, host.id, history.threadId)).toEqual(original);
  }
});
