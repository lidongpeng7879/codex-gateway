import type { AppServerThread, GatewayThread } from "~~/shared/types";
import { currentGatewayMemoryState } from "../state/memory";
import { hostWorkspacePath } from "../state/directory-aliases";

/**
 * The browser boundary is the only place that enriches an official app-server Thread. Runtime
 * snapshots must retain the exact upstream DTO so user-scoped Gateway pins can never leak back
 * into RPC state or be mistaken for Codex's app-server-global section membership.
 */
export function gatewayThreadFromAppServer(hostId: number, thread: AppServerThread): GatewayThread {
  const pinned = currentGatewayMemoryState().pinnedThreads.find(
    (candidate) => candidate.hostId === hostId && candidate.threadId === thread.id,
  );
  const workspaceCwd = hostWorkspacePath(hostId, thread.cwd);
  return {
    ...thread,
    hostId,
    pinned: pinned !== undefined,
    title: pinned?.title ?? thread.name,
    ...(workspaceCwd === thread.cwd ? {} : { workspaceCwd }),
  };
}
