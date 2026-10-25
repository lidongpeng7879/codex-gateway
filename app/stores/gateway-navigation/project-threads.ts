import type { GatewayThread } from "~~/shared/types";
import { threadWorkspaceCwd } from "~~/shared/directory-aliases";
import { isAppServerSubAgentThread } from "~~/shared/runtime/app-server";
import { sortThreads } from "@/stores/gateway/thread-utils/identity";
import type { ThreadViewState } from "@/stores/gateway/types";

/** Empty official threads may not enter Codex's durable index until their first turn. */
export function emptyThreadSnapshots(views: Readonly<Record<string, ThreadViewState>>) {
  return Object.values(views).flatMap((view) =>
    view.currentThread !== null &&
    view.history !== null &&
    view.history.thread.turns.length === 0 &&
    view.oldestTimelineCursor === null
      ? [view.currentThread]
      : [],
  );
}

/** Display-only union of official snapshots and a native HTTP page. Never alters page/cursors. */
export function projectDirectoryThreads(input: {
  threads: readonly GatewayThread[];
  snapshots: readonly GatewayThread[];
  hostId: number | null;
  cwd: string | null;
  selectedThreadId: string | null;
  excludedIds?: ReadonlySet<string>;
  limit?: number;
}) {
  const byId = new Map<string, GatewayThread>();
  for (const thread of [...input.threads, ...input.snapshots]) {
    if (
      thread.hostId !== input.hostId ||
      threadWorkspaceCwd(thread) !== input.cwd ||
      input.excludedIds?.has(thread.id) === true ||
      isAppServerSubAgentThread(thread)
    )
      continue;
    const existing = byId.get(thread.id);
    if (existing === undefined || thread.updatedAt > existing.updatedAt)
      byId.set(thread.id, thread);
  }
  const sorted = sortThreads([...byId.values()]);
  const limit = input.limit ?? sorted.length;
  const visible = sorted.slice(0, limit);
  const selected = byId.get(input.selectedThreadId ?? "");
  if (selected && limit > 0 && !visible.some((thread) => thread.id === selected.id))
    return [...visible.slice(0, limit - 1), selected];
  return visible;
}
