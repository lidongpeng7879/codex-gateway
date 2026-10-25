import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { createUuid } from "@/lib/uuid";
import { captureSessionEpoch } from "@/utils/session-epoch";
import { useGatewayRealtimeStore } from "@/stores/gateway-realtime";
import { RealtimeRequestError } from "@/stores/gateway-realtime/request-errors";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { useGatewayBootstrapStore } from "@/stores/gateway-bootstrap";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { gatewayDomainEvents } from "@/stores/gateway/domain-events";
import { messageFromError } from "@/stores/gateway/thread-utils/identity";
import type { GatewayThread } from "~~/shared/types";

export interface MessageEditTarget {
  hostId: number;
  threadId: string;
  turnId: string;
  itemId: string;
}
export interface MessageEditSession extends MessageEditTarget {
  editId: string;
  text: string;
  submittedText: string | null;
  attachments: string[];
  loading: boolean;
  pending: boolean;
  blocked: boolean;
  sent: boolean;
  branchId: string | null;
  branch: GatewayThread | null;
  cwd: string | null;
  failure: "retryable" | "checkable" | "uncertain" | null;
}
export function messageEditKey(target: MessageEditTarget) {
  return JSON.stringify([target.hostId, target.threadId, target.turnId, target.itemId]);
}

export const useGatewayThreadEditStore = defineStore("gateway-thread-edit", () => {
  // Draft lifetime follows the editor; command lifetime survives editor/virtual-row teardown.
  // Neither is persisted as lineage or an alternative conversation history.
  const sessions = ref<Record<string, MessageEditSession>>({});
  const operations = ref<Record<string, MessageEditSession>>({});
  const catalog = useGatewayCatalogStore();
  function clearHost(hostId: number) {
    for (const entries of [sessions.value, operations.value])
      for (const [key, session] of Object.entries(entries))
        if (session.hostId === hostId) delete entries[key];
  }
  watch(
    () => catalog.hosts.map((host) => [host.id, JSON.stringify(host)] as const),
    (next, previous) => {
      const before = new Map(previous);
      const after = new Map(next);
      for (const session of [...Object.values(sessions.value), ...Object.values(operations.value)])
        if (before.get(session.hostId) !== after.get(session.hostId)) clearHost(session.hostId);
    },
    { flush: "sync" },
  );
  gatewayDomainEvents.on("gateway-session-reset", () => {
    sessions.value = {};
    operations.value = {};
  });
  gatewayDomainEvents.on("host-removed", ({ hostId }) => clearHost(hostId));
  function cancel(target: MessageEditTarget) {
    const key = messageEditKey(target);
    if (sessions.value[key]?.pending !== true) delete sessions.value[key];
  }
  async function begin(target: MessageEditTarget) {
    const key = messageEditKey(target);
    if (sessions.value[key] || operations.value[key]?.pending === true) return;
    delete operations.value[key];
    const sessionIsCurrent = captureSessionEpoch();
    sessions.value[key] = {
      ...target,
      editId: createUuid(),
      text: "",
      submittedText: null,
      attachments: [],
      loading: true,
      pending: false,
      blocked: false,
      sent: false,
      branchId: null,
      branch: null,
      cwd: useGatewayNavigationStore().selectedCwd,
      failure: null,
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
    const key = messageEditKey(target);
    const session = sessions.value[key] ?? operations.value[key];
    if (
      !session ||
      session.pending ||
      session.loading ||
      session.blocked ||
      session.sent ||
      session.failure === "uncertain" ||
      (session.text.trim() === "" && session.attachments.length === 0)
    )
      return;
    const navigation = useGatewayNavigationStore();
    const views = useGatewayThreadViewStore();
    const viewEpoch = views.viewEpoch;
    const sessionIsCurrent = captureSessionEpoch();
    const owned = () =>
      sessionIsCurrent() && (sessions.value[key] ?? operations.value[key]) === session;
    const selected = () =>
      owned() &&
      views.viewEpoch === viewEpoch &&
      navigation.selectedHostId === target.hostId &&
      (navigation.selectedThreadId === target.threadId ||
        navigation.selectedThreadId === session.branchId);
    if (!selected()) return;
    const submittedText = session.submittedText ?? session.text;
    session.submittedText = submittedText;
    session.pending = true;
    session.failure = null;
    let forking = false;
    let handoffEpoch: number | null = null;
    const ownsHandoff = () =>
      handoffEpoch !== null &&
      owned() &&
      views.viewEpoch === handoffEpoch &&
      navigation.selectedHostId === target.hostId &&
      navigation.selectedThreadId === session.branchId;
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
        if (
          result.type !== "thread.forked" ||
          result.hostId !== target.hostId ||
          result.threadId === target.threadId ||
          result.thread.id !== result.threadId ||
          result.thread.hostId !== target.hostId ||
          result.thread.forkedFromId !== target.threadId
        )
          throw new Error("Unexpected branch response");
        session.branchId = result.threadId;
        session.branch = result.thread;
        session.cwd = result.thread.cwd;
        forking = false;
      }
      const follow = selected();
      // Retire the original editor as soon as the official branch exists. The immutable operation
      // owns dedup/recovery, independent of the subsequent selection/snapshot/model lifetimes.
      operations.value[key] = session;
      delete sessions.value[key];
      if (follow && navigation.selectedThreadId !== session.branchId && session.branch !== null)
        handoffEpoch = views.selectCreatedThread(session.branch);
      else if (follow && navigation.selectedThreadId === session.branchId)
        handoffEpoch = views.viewEpoch;
      const result = await useGatewayRealtimeStore().request((requestId) => ({
        type: "turn.revise",
        requestId,
        hostId: target.hostId,
        threadId: session.branchId!,
        sourceThreadId: target.threadId,
        turnId: target.turnId,
        itemId: target.itemId,
        text: submittedText,
      }));
      if (!owned()) return;
      if (
        result.type !== "turn.revise.accepted" ||
        result.hostId !== target.hostId ||
        result.threadId !== session.branchId
      )
        throw new Error("Unexpected revision acceptance");
      session.sent = true;
      if (ownsHandoff()) {
        void views
          .openThread(session.branchId, {
            hostId: target.hostId,
            cwd: session.cwd,
            replaceRoute: true,
          })
          .catch((error: unknown) => {
            if (owned()) report(error, target);
          });
      }
      if (navigation.selectedHostId === target.hostId && navigation.selectedCwd === session.cwd)
        void navigation.listThreads();
    } catch (error) {
      if (!owned()) return;
      if (ownsHandoff()) views.loading = false;
      if (forking) session.blocked = true;
      else
        session.failure =
          error instanceof RealtimeRequestError && error.reason === "server"
            ? error.details.code === "REVISION_SEND_RETRYABLE"
              ? "retryable"
              : "uncertain"
            : "checkable";
      report(error, target);
    } finally {
      if (owned()) {
        session.pending = false;
        // Bound completed notices; never evict an in-flight operation or its recovery identity.
        const settled = Object.entries(operations.value).filter(([, operation]) => operation.sent);
        for (const [oldKey] of settled.slice(0, Math.max(0, settled.length - 40)))
          delete operations.value[oldKey];
      }
    }
  }
  return { sessions, operations, begin, cancel, submit };
});
function report(error: unknown, target: MessageEditTarget) {
  const gateway = useGatewayBootstrapStore();
  gateway.setError(
    messageFromError(error, gateway.t("app.editMessageFailed"), gateway.errorLabels),
    target,
  );
}
