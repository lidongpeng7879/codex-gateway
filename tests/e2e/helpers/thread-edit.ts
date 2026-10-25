import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { AppServerTimelineEntry } from "../../../shared/types";
import { execRemoteSsh, type RemoteCodexEnv } from "./remote-codex";
import { shellQuote } from "../../../server/utils/gateway/infra/ssh/shell";
import { sendRealtimeRequest } from "./realtime";

/** Real stored rollouts, consumed by the supported official app-server, never browser state. */
export async function createEditHistory(
  remote: RemoteCodexEnv,
  options: {
    count?: number;
    cwd?: string;
    historyMode?: "legacy" | "paginated";
    attachments?: boolean;
    steer?: boolean;
    audio?: boolean;
    textSpans?: boolean;
    structuredReferences?: boolean;
    attachmentOnly?: boolean;
  } = {},
) {
  const threadId = randomUUID();
  const turnIds = Array.from({ length: options.count ?? 3 }, () => randomUUID());
  const userItemIds = turnIds.map(() => randomUUID());
  const agentItemIds = turnIds.map(() => randomUUID());
  const cwd = options.cwd ?? `/home/codex/edit-${threadId}`;
  const texts = turnIds.map((_, index) =>
    options.attachmentOnly === true && index === 1
      ? ""
      : `Historical input ${index + 1} ${threadId}${options.attachments === true && index === 1 ? `\n\nReference: ${cwd}/keep.txt` : ""}`,
  );
  const timestamp = "2026-01-03T03:04:05Z";
  const lines: Array<Record<string, unknown>> = [];
  const add = (type: string, payload: unknown) => lines.push({ timestamp, type, payload });
  add("session_meta", {
    id: threadId,
    session_id: threadId,
    forked_from_id: null,
    parent_thread_id: null,
    timestamp,
    cwd,
    originator: "codex",
    cli_version: remote.supportedCodexVersion ?? "0.164.0",
    source: "cli",
    model_provider: "openai",
    history_mode: options.historyMode ?? "paginated",
    base_instructions: null,
    dynamic_tools: null,
    git: null,
  });
  for (const [index, turnId] of turnIds.entries()) {
    add("event_msg", {
      type: "task_started",
      turn_id: turnId,
      started_at: 1767410000 + index,
      model_context_window: null,
    });
    add("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: texts[index] }],
    });
    add("event_msg", {
      type: "user_message",
      message: texts[index],
      images: null,
      local_images: options.attachments === true && index === 1 ? [remote.imagePath] : [],
      audio: options.audio === true && index === 1 ? ["https://example.invalid/audio.wav"] : null,
      text_elements: [],
    });
    // Paginated .164 histories project canonical ItemCompleted events, not legacy user_message
    // or response_item records. Match the pinned official thread_timeline.rs fixture exactly.
    // Keep response_item too: real fork/resume/model context is reconstructed from those records.
    const content: Array<Record<string, unknown>> = [];
    if (texts[index] !== "")
      content.push({
        type: "text",
        text: texts[index],
        text_elements:
          options.textSpans === true && index === 1
            ? [{ byte_range: { start: 0, end: 10 }, placeholder: "Historical" }]
            : [],
      });
    if ((options.attachments === true || options.attachmentOnly === true) && index === 1)
      content.push({ type: "local_image", path: remote.imagePath });
    if (options.audio === true && index === 1)
      content.push({ type: "audio", audio_url: "https://example.invalid/audio.wav" });
    if (options.structuredReferences === true && index === 1)
      content.push(
        { type: "mention", name: "keep.txt", path: `${cwd}/keep.txt` },
        { type: "skill", name: "fixture-skill", path: `${cwd}/SKILL.md` },
      );
    const complete = (item: Record<string, unknown>) =>
      add("event_msg", {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turnId,
        item,
        started_at_ms: (1767410000 + index) * 1000,
        completed_at_ms: (1767410000 + index) * 1000 + 500,
      });
    complete({ type: "UserMessage", id: userItemIds[index], content });
    if (options.steer === true && index === 1) {
      complete({
        type: "UserMessage",
        id: randomUUID(),
        content: [{ type: "text", text: "Secondary steer input", text_elements: [] }],
      });
      add("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Secondary steer input" }],
      });
      add("event_msg", {
        type: "user_message",
        message: "Secondary steer input",
        images: null,
        local_images: [],
        text_elements: [],
      });
    }
    add("event_msg", {
      type: "agent_message",
      message: `Historical answer ${index + 1}`,
      phase: "final_answer",
    });
    add("response_item", {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: `Historical answer ${index + 1}` }],
    });
    complete({
      type: "AgentMessage",
      id: agentItemIds[index],
      phase: "final_answer",
      content: [{ type: "Text", text: `Historical answer ${index + 1}` }],
    });
    add("event_msg", {
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: `Historical answer ${index + 1}`,
      started_at: 1767410000 + index,
      completed_at: 1767410001 + index,
      duration_ms: 1000,
    });
  }
  if (options.historyMode !== "legacy")
    lines.forEach((line, ordinal) => {
      line.ordinal = ordinal;
    });
  const fileName = `rollout-2026-01-03T03-04-05-${threadId}.jsonl`;
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await execRemoteSsh(
    remote,
    `set -eu\nmkdir -p ${shellQuote(cwd)} "\${CODEX_HOME:-$HOME/.codex}/sessions/2026/01/03"\nprintf 'keep workspace unchanged\\n' > ${shellQuote(`${cwd}/keep.txt`)}\nprintf '%s' ${shellQuote("---\nname: fixture-skill\ndescription: Respond briefly without tools for the isolated editing test.\n---\nReply briefly. Do not modify files.\n")} > ${shellQuote(`${cwd}/SKILL.md`)}\nprintf '%s' ${shellQuote(body)} > "\${CODEX_HOME:-$HOME/.codex}/sessions/2026/01/03/${fileName}"`,
  );
  const hash = async () =>
    (
      await execRemoteSsh(
        remote,
        `sha256sum ${shellQuote(`${cwd}/keep.txt`)} ${shellQuote(`${cwd}/SKILL.md`)} "\${CODEX_HOME:-$HOME/.codex}/sessions/2026/01/03/${fileName}"`,
      )
    ).stdout;
  const workspaceHash = async () =>
    (
      await execRemoteSsh(
        remote,
        `sha256sum ${shellQuote(`${cwd}/keep.txt`)} ${shellQuote(`${cwd}/SKILL.md`)}`,
      )
    ).stdout;
  return { threadId, turnIds, userItemIds, agentItemIds, texts, cwd, hash, workspaceHash };
}

/** Fail at fixture establishment, not at a later missing UI edit button. */
export async function verifyEditHistory(
  page: Page,
  hostId: number,
  history: Awaited<ReturnType<typeof createEditHistory>>,
) {
  // Files imported after daemon startup must be activated before paginated store reads.
  // Reading the timeline first does not register/materialize this external rollout.
  await sendRealtimeRequest(page, {
    type: "thread.activate",
    requestId: randomUUID(),
    hostId,
    threadId: history.threadId,
  });
  const entries = await readTimeline(page, hostId, history.threadId);
  for (const [index, turnId] of history.turnIds.entries()) {
    const user = primaryUser(entries, turnId);
    if (user.id !== history.userItemIds[index])
      throw new Error("Official user item identity mismatch");
    if (
      !entries.some(
        (entry) =>
          entry.type === "item" &&
          entry.turnId === turnId &&
          entry.item.type === "agentMessage" &&
          entry.item.id === history.agentItemIds[index],
      )
    )
      throw new Error("Missing official canonical agent item");
  }
  return entries;
}

export async function readTimeline(page: Page, hostId: number, threadId: string) {
  const entries: AppServerTimelineEntry[] = [];
  let cursor: string | null = null;
  do {
    const response = await sendRealtimeRequest(page, {
      type: "thread.timeline.load",
      requestId: randomUUID(),
      hostId,
      threadId,
      cursor,
      limit: 100,
    });
    if (response.type !== "thread.timeline.page")
      throw new Error("Expected official timeline page");
    entries.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor !== null);
  return entries.sort((a, b) => a.position - b.position);
}
export function primaryUser(entries: AppServerTimelineEntry[], turnId: string) {
  const entry = entries.find(
    (entry) =>
      entry.type === "item" && entry.turnId === turnId && entry.item.type === "userMessage",
  );
  if (!entry || entry.type !== "item") throw new Error("Missing official primary user message");
  return entry.item;
}
export function userTexts(entries: AppServerTimelineEntry[]) {
  return entries.flatMap((entry) =>
    entry.type === "item" && entry.item.type === "userMessage" && Array.isArray(entry.item.content)
      ? entry.item.content.flatMap((part: unknown) =>
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
      : [],
  );
}
export async function openHistory(page: Page, hostId: number, threadId: string) {
  await page.goto(`/?hostId=${hostId}&threadId=${threadId}`);
  await page.getByPlaceholder("输入后续修改要求").waitFor({ state: "visible" });
}
