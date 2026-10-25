import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { createUuid } from "@/lib/uuid";
import { captureSessionEpoch } from "@/utils/session-epoch";
import { useGatewayRealtimeStore } from "@/stores/gateway-realtime";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { useGatewayBootstrapStore } from "@/stores/gateway-bootstrap";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { gatewayDomainEvents } from "@/stores/gateway/domain-events";
import { messageFromError } from "@/stores/gateway/thread-utils/identity";

export interface MessageEditTarget {
  hostId: number;
  threadId: string;
  turnId: string;
  itemId: string;
}
export interface MessageEditSession extends MessageEditTarget {
  editId: string;
  text: string;
  attachments: string[];
  loading: boolean;
  pending: boolean;
  blocked: boolean;
  sent: boolean;
  branchId: string | null;
}
export function messageEditKey(target: MessageEditTarget) {
  return JSON.stringify([target.hostId, target.threadId, target.turnId, target.itemId]);
}

export const useGatewayThreadEditStore = defineStore("gateway-thread-edit", () => {
  // Independent of composer drafts and virtual row lifetime. Never persisted as lineage.
  const sessions = ref<Record<string, MessageEditSession>>({});
  // updatedAt also invalidates changes to secrets, which the public Host DTO must not expose.
  const catalog = useGatewayCatalogStore();
  watch(
    () => catalog.hosts.map((host) => [host.id, JSON.stringify(host)] as const),
    (next, previous) => {
      const before = new Map(previous);
      const after = new Map(next);
      for (const [key, session] of Object.entries(sessions.value))
        if (before.get(session.hostId) !== after.get(session.hostId)) delete sessions.value[key];
    },
    { flush: "sync" },
  );
  gatewayDomainEvents.on("gateway-session-reset", () => {
    sessions.value = {};
  });
  gatewayDomainEvents.on("host-removed", ({ hostId }) => {
    for (const [key, session] of Object.entries(sessions.value))
      if (session.hostId === hostId) delete sessions.value[key];
  });
  function cancel(target: MessageEditTarget) {
    const key = messageEditKey(target);
    if (sessions.value[key]?.pending !== true) delete sessions.value[key];
  }
  async function begin(target: MessageEditTarget) {
    const key = messageEditKey(target);
    if (sessions.value[key]) return;
    const sessionIsCurrent = captureSessionEpoch();
    sessions.value[key] = {
      ...target,
      editId: createUuid(),
      text: "",
      attachments: [],
      loading: true,
      pending: false,
      blocked: false,
      sent: false,
      branchId: null,
    };
    const session = sessions.value[key];
    try {
      const result = await useGatewayRealtimeStore().request((requestId) => ({
        type: "thread.edit.read",
        requestId,
        ...target,
      }));
      if (!sessionIsCurrent() || sessions.value[key] !== session) return;
      if (result.type !== "thread.edit.snapshot") throw new Error("Unexpected edit response");
      session.text = result.text;
      session.attachments = result.attachments;
      session.loading = false;
    } catch (error) {
      if (!sessionIsCurrent() || sessions.value[key] !== session) return;
      delete sessions.value[key];
      report(error, target);
    }
  }
  async function submit(target: MessageEditTarget) {
    const session = sessions.value[messageEditKey(target)];
    if (
      !session ||
      session.pending ||
      session.loading ||
      session.blocked ||
      session.sent ||
      (session.text.trim() === "" && session.attachments.length === 0)
    )
      return;
    const navigation = useGatewayNavigationStore();
    const views = useGatewayThreadViewStore();
    const viewEpoch = views.viewEpoch;
    const sessionIsCurrent = captureSessionEpoch();
    const owned = () => sessionIsCurrent() && sessions.value[messageEditKey(target)] === session;
    const selected = () =>
      owned() &&
      views.viewEpoch === viewEpoch &&
      navigation.selectedHostId === target.hostId &&
      navigation.selectedThreadId === target.threadId;
    if (!selected()) return;
    session.pending = true;
    let forking = false;
    try {
      if (session.branchId === null) {
        forking = true;
        const result = await useGatewayRealtimeStore().request((requestId) => ({
          type: "thread.fork",
          requestId,
          hostId: target.hostId,
          threadId: target.threadId,
          beforeTurnId: target.turnId,
          itemId: target.itemId,
          editId: session.editId,
        }));
        if (!owned()) return;
        if (result.type !== "thread.forked") throw new Error("Unexpected branch response");
        session.branchId = result.threadId; // Commit identity before any later operation can fail.
        forking = false;
        if (!selected()) return;
      }
      await useGatewayRealtimeStore().request((requestId) => ({
        type: "turn.revise",
        requestId,
        hostId: target.hostId,
        threadId: session.branchId!,
        sourceThreadId: target.threadId,
        turnId: target.turnId,
        itemId: target.itemId,
        text: session.text,
      }));
      if (!owned()) return;
      session.sent = true;
      if (!selected()) return;
      await views.openThread(session.branchId, { hostId: target.hostId, replaceRoute: false });
      if (sessionIsCurrent() && navigation.selectedHostId === target.hostId)
        void navigation.listThreads();
    } catch (error) {
      if (!owned()) return;
      // Never automatically retry a fork, including ambiguous disconnects/timeouts. Explicit
      // retries after a created branch always target that identity; the server deduplicates sends.
      if (forking) session.blocked = true;
      report(error, target);
    } finally {
      if (owned()) session.pending = false;
    }
  }
  return { sessions, begin, cancel, submit };
});
function report(error: unknown, target: MessageEditTarget) {
  const gateway = useGatewayBootstrapStore();
  gateway.setError(
    messageFromError(error, gateway.t("app.editMessageFailed"), gateway.errorLabels),
    target,
  );
}
