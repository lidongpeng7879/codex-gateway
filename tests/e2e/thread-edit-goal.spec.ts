import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { openRemoteRpc } from "./helpers/remote-rpc";
import {
  createEditHistory,
  openHistory,
  readTimeline,
  userTexts,
  verifyEditHistory,
} from "./helpers/thread-edit";
import { sendRealtimeRequest } from "./helpers/realtime";
import { parseThreadReadResult } from "../../shared/runtime/app-server";
import { execRemoteSsh } from "./helpers/remote-codex";
import { shellQuote } from "../../server/utils/gateway/infra/ssh/shell";
import { AGENT_OUTPUT_TIMEOUT_MS } from "./helpers/timeouts";

import { prepareManagedDaemon } from "./helpers/host-daemon";

// Focused experience runs provision the verified official fixture independently of upgrade tests.
test.beforeEach(async ({ remoteWorkspace }) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
});

test("an inherited active goal stays deferred during real fork and history activation until the explicit revision", async ({
  page,
  remoteWorkspace,
}) => {
  test.setTimeout(6 * 60_000);
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const source = await createEditHistory(remoteWorkspace.remote);
  await verifyEditHistory(page, host.id, source);
  // Match the official thread_fork.rs fixture: seed an active persisted goal without invoking
  // its source's idle hook. Inheritance, activation and the revised model turn all use the real
  // daemon below. This touches only this freshly created container thread's official database.
  const seed = `const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const home=process.env.HOME+'/.codex';
const goalPath=home+'/goals_1.sqlite';
if(!fs.statSync(goalPath).isFile()) throw new Error('Expected the official goals database');
const db=new DatabaseSync(goalPath);
db.exec('PRAGMA busy_timeout=10000');
const now=Date.now();
db.prepare('INSERT INTO thread_goals (thread_id,goal_id,objective,status,token_budget,tokens_used,time_used_seconds,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)').run(
${JSON.stringify(source.threadId)},${JSON.stringify(randomUUID())},
'Reply exactly to the explicit revised input, then complete this goal. Never use shell or file tools.',
'active',4000,0,0,now,now);
db.close();`;
  await execRemoteSsh(
    remoteWorkspace.remote,
    `/opt/codex-preview-runtime/bin/node -e ${shellQuote(seed)}`,
  );
  const rpc = await openRemoteRpc(remoteWorkspace.remote);
  let branchId: string | null = null;
  try {
    const sourceRead = parseThreadReadResult(
      await rpc.request("thread/read", { threadId: source.threadId, includeTurns: false }),
    );
    expect(sourceRead.thread.status.type).not.toBe("active");
    const fork = await sendRealtimeRequest(page, {
      type: "thread.fork",
      requestId: randomUUID(),
      hostId: host.id,
      threadId: source.threadId,
      beforeTurnId: source.turnIds[1]!,
      itemId: source.userItemIds[1]!,
      editId: randomUUID(),
    });
    if (fork.type !== "thread.forked") throw new Error("Expected official deferred-goal fork");
    branchId = fork.threadId;
    await openHistory(page, host.id, branchId);
    const inheritedGoal = await sendRealtimeRequest(page, {
      type: "thread.goal.get",
      requestId: randomUUID(),
      hostId: host.id,
      threadId: branchId,
    });
    expect(inheritedGoal.type === "thread.goal.snapshot" && inheritedGoal.goal?.status).toBe(
      "active",
    );
    expect(userTexts(await readTimeline(page, host.id, branchId))).toEqual([source.texts[0]]);
    expect(
      parseThreadReadResult(
        await rpc.request("thread/read", { threadId: branchId, includeTurns: false }),
      ).thread.status.type,
    ).not.toBe("active");
    const marker = `goal-revision-${Date.now()}`;
    const revised = `Only reply ${marker}, then complete the goal. Do not use shell or file tools.`;
    const accepted = await sendRealtimeRequest(page, {
      type: "turn.revise",
      requestId: randomUUID(),
      hostId: host.id,
      threadId: branchId,
      sourceThreadId: source.threadId,
      turnId: source.turnIds[1]!,
      itemId: source.userItemIds[1]!,
      text: revised,
    });
    expect(accepted.type).toBe("turn.revise.accepted");
    await expect(
      page.getByTestId("chat-scroll-area").locator(".is-assistant").last(),
    ).toContainText(marker, { timeout: AGENT_OUTPUT_TIMEOUT_MS });
    expect(userTexts(await readTimeline(page, host.id, branchId))).toEqual([
      source.texts[0],
      revised,
    ]);
  } finally {
    // Mutate through the official protocol without resuming the still-unloaded source.
    await rpc.request("thread/goal/set", {
      threadId: source.threadId,
      status: "paused",
      origin: "user",
    });
    if (branchId !== null)
      await rpc.request("thread/goal/set", {
        threadId: branchId,
        status: "paused",
        origin: "user",
      });
    rpc.close();
  }
  expect(userTexts(await readTimeline(page, host.id, source.threadId))).toEqual(source.texts);
});
