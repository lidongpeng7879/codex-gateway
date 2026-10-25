import { hostWorkspacePath } from "../../state/directory-aliases";
import type { RealtimeClientMessage } from "~~/shared/types";
import { firstNonEmptyString, trimmedOrNull } from "~~/shared/utils/strings";
import { requireRecord } from "../../http/validation/common";
import { hostStore } from "../../state/hosts";
import { threadMetadataStore } from "../../state/thread-metadata";
import { terminalEventBus } from "../../terminal/events";
import { terminalManager } from "../../terminal/terminal-manager";
import {
  authenticatedUserId,
  sendRealtimePeerMessage,
  stateFor,
  type RealtimePeer,
} from "../peer-state";
import { TerminalPeerStream } from "../../terminal/terminal-peer-stream";

export async function openTerminal(
  peer: RealtimePeer,
  request: Extract<RealtimeClientMessage, { type: "terminal.open" }>,
) {
  const userId = authenticatedUserId(peer);
  const host = requireRecord(hostStore.getWithSecret(request.hostId), "Host not found");
  const target = {
    ...request,
    threadId: request.threadId ?? null,
    cwd: resolveTerminalCwd(request),
    title: trimmedOrNull(request.title) ?? terminalTitle(request),
  };
  const session = await terminalManager.open(userId, host, target);
  sendRealtimePeerMessage(peer, { type: "terminal.opened", requestId: request.requestId, session });
}

export function listTerminals(
  peer: RealtimePeer,
  request: Extract<RealtimeClientMessage, { type: "terminal.list" }>,
) {
  const userId = authenticatedUserId(peer);
  sendRealtimePeerMessage(peer, {
    type: "terminal.snapshot",
    requestId: request.requestId,
    sessions: terminalManager.list(userId),
  });
}

export function writeTerminalInput(
  peer: RealtimePeer,
  request: Extract<RealtimeClientMessage, { type: "terminal.input" }>,
) {
  terminalManager.input(authenticatedUserId(peer), request.sessionId, request.data);
}

export function resizeTerminal(
  peer: RealtimePeer,
  request: Extract<RealtimeClientMessage, { type: "terminal.resize" }>,
) {
  terminalManager.resize(authenticatedUserId(peer), request.sessionId, request.cols, request.rows);
}

export function closeTerminal(
  peer: RealtimePeer,
  request: Extract<RealtimeClientMessage, { type: "terminal.close" }>,
) {
  terminalManager.close(authenticatedUserId(peer), request.sessionId);
  sendRealtimePeerMessage(peer, {
    type: "terminal.closed",
    requestId: request.requestId,
    sessionId: request.sessionId,
  });
}

export function subscribeTerminalEvents(peer: RealtimePeer) {
  const state = stateFor(peer);
  state.terminalUnsubscribe?.();
  state.terminalOutputStream?.dispose();
  const outputStream = new TerminalPeerStream(peer);
  state.terminalOutputStream = outputStream;
  state.terminalUnsubscribe = terminalEventBus.subscribe(authenticatedUserId(peer), (event) => {
    if (event.type === "terminal.output.binary") {
      outputStream.send(event.frame);
      return;
    }
    sendRealtimePeerMessage(peer, event);
  });
}

function resolveTerminalCwd(request: Extract<RealtimeClientMessage, { type: "terminal.open" }>) {
  const requestedCwd = trimmedOrNull(request.cwd);
  if (requestedCwd !== null) {
    return hostWorkspacePath(request.hostId, requestedCwd);
  }
  if (typeof request.threadId === "string" && request.threadId.length > 0) {
    const metadata = threadMetadataStore.get(request.hostId, request.threadId);
    const metadataCwd = trimmedOrNull(metadata?.cwd);
    if (metadataCwd !== null) {
      return hostWorkspacePath(request.hostId, metadataCwd);
    }
  }
  return null;
}

function terminalTitle(request: Extract<RealtimeClientMessage, { type: "terminal.open" }>) {
  if (request.scope === "thread") {
    const metadata =
      typeof request.threadId === "string" && request.threadId.length > 0
        ? threadMetadataStore.get(request.hostId, request.threadId)
        : null;
    return (
      firstNonEmptyString([metadata?.title, metadata?.name, request.threadId]) ?? "Thread terminal"
    );
  }
  if (request.scope === "project") {
    return trimmedOrNull(request.cwd) ?? "Project terminal";
  }
  return "Host terminal";
}
