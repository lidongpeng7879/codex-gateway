import { gatewayApi } from "@/utils/gateway-api";
import type { GatewayThread } from "~~/shared/types";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { useGatewayConfigStore } from "@/stores/gateway-config";
import { useGatewayBootstrapStore } from "@/stores/gateway-bootstrap";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadActivityStore } from "@/stores/gateway-thread-activity";
import { useGatewayThreadRuntimeStore } from "@/stores/gateway-thread-runtime";
import type { ThreadListResponse } from "@/stores/gateway/types";
import { messageFromError, sortThreads } from "@/stores/gateway/thread-utils/identity";
import { runtimeStatusFromAppThreadStatus } from "@/stores/gateway/thread-utils/status";
import { isAppServerSubAgentThread } from "~~/shared/runtime/app-server";
import { captureSessionEpoch } from "@/utils/session-epoch";

export function createThreadListActions() {
  async function loadHostOverview(hostId: number) {
    const catalog = useGatewayCatalogStore();
    const sessionIsCurrent = captureSessionEpoch();
    const observations = captureThreadObservations();
    const response = await gatewayApi<ThreadListResponse>("/api/threads", {
      query: { hostId, limit: 50 },
    });
    if (!sessionIsCurrent()) return false;
    if (response.projects !== undefined) catalog.mergeProjects(response.projects);
    applyThreadObservations(response.data ?? [], catalog.projects, observations);
    return true;
  }

  return {
    async ensureThreadListForSelection() {
      const navigation = useGatewayNavigationStore();
      const scope = navigation.threadListScope;
      if (
        navigation.selectedHostId === null ||
        navigation.loadingThreads ||
        (scope?.hostId === navigation.selectedHostId &&
          scope.cwd === navigation.selectedCwd &&
          scope.searchTerm === "")
      )
        return;
      await navigation.listThreads();
    },
    async connectAllHosts() {
      const catalog = useGatewayCatalogStore();
      const config = useGatewayConfigStore();
      const bootstrap = useGatewayBootstrapStore();
      const sessionIsCurrent = captureSessionEpoch();
      await Promise.all(
        catalog.hosts.map(async (host) => {
          catalog.setHostConnectionStatus(host.id, "connecting");
          try {
            if (!(await loadHostOverview(host.id)) || !sessionIsCurrent()) return;
            catalog.setHostConnectionStatus(host.id, "connected");
          } catch (error: unknown) {
            if (!sessionIsCurrent()) return;
            catalog.setHostConnectionStatus(
              host.id,
              "failed",
              messageFromError(error, bootstrap.t("app.connectHostFailed"), bootstrap.errorLabels),
            );
          }
        }),
      );
      if (!sessionIsCurrent()) return;
      config.setCatalog(catalog.hosts);
    },
    refreshHostProjects: loadHostOverview,
    async listThreads(searchTerm = "") {
      const catalog = useGatewayCatalogStore();
      const config = useGatewayConfigStore();
      const bootstrap = useGatewayBootstrapStore();
      const navigation = useGatewayNavigationStore();
      const hostId = navigation.selectedHostId;
      const cwd = navigation.selectedCwd;
      if (hostId === null) return;
      const sessionIsCurrent = captureSessionEpoch();
      const requestEpoch = ++navigation.threadListEpoch;
      const observations = captureThreadObservations();
      const current = () =>
        sessionIsCurrent() &&
        navigation.threadListEpoch === requestEpoch &&
        navigation.selectedHostId === hostId &&
        navigation.selectedCwd === cwd;
      navigation.loadingThreads = true;
      bootstrap.clearError();
      try {
        const query: Record<string, unknown> = { hostId, limit: 50 };
        if (cwd !== null && cwd !== "") query.cwd = cwd;
        if (searchTerm !== "") query.searchTerm = searchTerm;
        const response = await gatewayApi<ThreadListResponse>("/api/threads", { query });
        if (!current()) return;
        if (response.projects !== undefined) catalog.mergeProjects(response.projects);
        applyThreadObservations(response.data ?? [], catalog.projects, observations);
        catalog.setHostConnectionStatus(hostId, "connected");
        // Sub-agent threads remain addressable by their explicit panel links, but they are not
        // top-level navigation entries. Filter once at the catalog boundary so every sidebar
        // projection cannot accidentally reintroduce them with a slightly different predicate.
        const mainThreads = (response.data ?? []).filter(
          (thread) => !isAppServerSubAgentThread(thread),
        );
        // `/api/threads` is the sole AppServerThread -> GatewayThread boundary. Do not overlay
        // browser config here: doing so creates two pin authorities and makes cross-tab updates
        // dependent on which request happened last.
        navigation.threads = sortThreads(mainThreads);
        navigation.threadListScope = { hostId, cwd, searchTerm };
        config.setCatalog(catalog.hosts);
      } catch (error: unknown) {
        if (!current()) return;
        const message = messageFromError(
          error,
          bootstrap.t("app.listThreadsFailed"),
          bootstrap.errorLabels,
        );
        catalog.setHostConnectionStatus(hostId, "failed", message);
        bootstrap.setError(message, { hostId, cwd, threadId: navigation.selectedThreadId });
      } finally {
        if (current()) navigation.loadingThreads = false;
      }
    },
  };
}

function captureThreadObservations() {
  return {
    summaries: useGatewayThreadActivityStore().summariesByKey,
    statuses: useGatewayThreadRuntimeStore().threadStatusRevisions,
  };
}
function applyThreadObservations(
  threads: GatewayThread[],
  projects: ReturnType<typeof useGatewayCatalogStore>["projects"],
  before: ReturnType<typeof captureThreadObservations>,
) {
  const activity = useGatewayThreadActivityStore();
  const runtime = useGatewayThreadRuntimeStore();
  for (const thread of threads) {
    const key = `${thread.hostId}:${thread.id}`;
    // A list response describes request-start state. It cannot rewind observations made while
    // it was in flight, even if a newer request has not replaced that same-scope request.
    if (activity.summariesByKey[key] === before.summaries[key])
      activity.upsertGatewayThread(thread, projects);
    if (runtime.threadStatusRevisions[key] === before.statuses[key])
      runtime.setThreadStatus(
        thread.hostId,
        thread.id,
        runtimeStatusFromAppThreadStatus(thread.status),
      );
  }
}
