import type { RealtimeClientMessage } from "~~/shared/types";
import { requireRecord } from "../../http/validation/common";
import { hostStore } from "../../state/hosts";
import { threadBroker } from "../../runtime/broker";
import { sendRealtimePeerMessage, type RealtimePeer } from "../peer-state";

export async function readThreadEdit(
  peer: RealtimePeer,
  message: Extract<RealtimeClientMessage, { type: "thread.edit.read" }>,
) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  const result = await threadBroker.edits.read(host, {
    threadId: message.threadId,
    turnId: message.turnId,
    itemId: message.itemId,
  });
  sendRealtimePeerMessage(peer, {
    type: "thread.edit.snapshot",
    requestId: message.requestId,
    ...result,
  });
}
export async function forkThread(
  peer: RealtimePeer,
  message: Extract<RealtimeClientMessage, { type: "thread.fork" }>,
) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  const result = await threadBroker.edits.fork(
    host,
    { threadId: message.threadId, turnId: message.beforeTurnId, itemId: message.itemId },
    message.editId,
  );
  sendRealtimePeerMessage(peer, {
    type: "thread.forked",
    requestId: message.requestId,
    hostId: host.id,
    threadId: result.threadId,
  });
}
export async function reviseTurn(
  peer: RealtimePeer,
  message: Extract<RealtimeClientMessage, { type: "turn.revise" }>,
) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  await threadBroker.edits.revise(
    host,
    message.threadId,
    { threadId: message.sourceThreadId, turnId: message.turnId, itemId: message.itemId },
    message.text,
  );
  sendRealtimePeerMessage(peer, {
    type: "turn.revise.accepted",
    requestId: message.requestId,
    hostId: host.id,
    threadId: message.threadId,
  });
}
