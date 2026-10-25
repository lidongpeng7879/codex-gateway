import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  AppServerThread,
  GatewayThread,
  ProjectRecord,
  ThreadRuntimeStatus,
} from "~~/shared/types";
import { pinnedKey, threadRecency } from "../gateway/thread-utils/identity";
import { firstNonEmptyString, trimmedOrNull } from "~~/shared/utils/strings";
import { isAppServerSubAgentThread } from "~~/shared/runtime/app-server";
import { canonicalDirectoryPath, threadWorkspaceCwd } from "~~/shared/directory-aliases";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";

export interface ThreadActivitySummary {
  hostId: number;
  threadId: string;
  title: string;
  cwd: string | null;
  projectName: string | null;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  isSubAgent: boolean;
  updatedAt: number;
}

export interface ThreadActivityMetadata {
  id: string;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  title: string | null;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  recencyAt: number | null;
  updatedAt: number;
}

export const useGatewayThreadActivityStore = defineStore("gateway-thread-activity", () => {
  const summariesByKey = ref<Record<string, ThreadActivitySummary>>({});
  const observedRunningThreadKeys = ref<string[]>([]);
  const observedRunningThreadKeySet = computed(() => new Set(observedRunningThreadKeys.value));

  function ingestGatewayThreads(threads: GatewayThread[], projects: ProjectRecord[]) {
    for (const thread of threads) {
      upsertGatewayThread(thread, projects);
    }
  }

  function upsertGatewayThread(thread: GatewayThread, projects: ProjectRecord[]) {
    upsertSummary(summaryFromGatewayThread(thread, projects));
  }

  function upsertAppServerThread(
    hostId: number,
    thread: AppServerThread,
    projects: ProjectRecord[],
  ) {
    upsertSummary(summaryFromAppServerThread(hostId, thread, projects));
  }

  function ingestMetadata(
    hostId: number,
    records: ThreadActivityMetadata[],
    projects: ProjectRecord[],
  ) {
    const aliases = useGatewayCatalogStore().hosts.find(
      (host) => host.id === hostId,
    )?.directoryAliases;
    for (const record of records) {
      const cwd = record.cwd === null ? null : canonicalDirectoryPath(record.cwd, aliases);
      const project = projects.find(
        (candidate) => candidate.hostId === hostId && candidate.remotePath === cwd,
      );
      upsertSummary({
        hostId,
        threadId: record.id,
        title: firstNonEmptyString([record.title, record.name, record.preview]) ?? record.id,
        cwd,
        projectName: project?.name ?? null,
        parentThreadId: stringOrNull(record.parentThreadId),
        agentNickname: stringOrNull(record.agentNickname),
        agentRole: stringOrNull(record.agentRole),
        isSubAgent:
          stringOrNull(record.parentThreadId) !== null ||
          stringOrNull(record.agentRole) !== null ||
          stringOrNull(record.agentNickname) !== null,
        updatedAt: record.recencyAt ?? record.updatedAt,
      });
    }
  }

  function upsertSummary(summary: ThreadActivitySummary) {
    const key = pinnedKey(summary.hostId, summary.threadId);
    const existing = summariesByKey.value[key];
    if (existing !== undefined && summary.updatedAt < existing.updatedAt) {
      // Structural subagent classification remains sticky even if its late metadata is older.
      if (summary.isSubAgent && !existing.isSubAgent)
        summariesByKey.value = {
          ...summariesByKey.value,
          [key]: {
            ...existing,
            isSubAgent: true,
            parentThreadId: summary.parentThreadId ?? existing.parentThreadId,
            agentNickname: summary.agentNickname ?? existing.agentNickname,
            agentRole: summary.agentRole ?? existing.agentRole,
          },
        };
      return;
    }
    summariesByKey.value = {
      ...summariesByKey.value,
      [key]: {
        ...existing,
        ...summary,
        cwd: summary.cwd ?? existing?.cwd ?? null,
        projectName: summary.projectName ?? existing?.projectName ?? null,
        parentThreadId: summary.parentThreadId ?? existing?.parentThreadId ?? null,
        agentNickname: summary.agentNickname ?? existing?.agentNickname ?? null,
        agentRole: summary.agentRole ?? existing?.agentRole ?? null,
        // Classification is sticky because `thread/started` can contain agent metadata before a
        // later `thread/read` supplies parentThreadId.
        isSubAgent: summary.isSubAgent || existing?.isSubAgent === true,
      },
    };
  }

  function recordRuntimeStatus(hostId: number, threadId: string, status: ThreadRuntimeStatus) {
    if (status !== "running") return;
    const key = pinnedKey(hostId, threadId);
    if (observedRunningThreadKeySet.value.has(key)) return;
    // This key set is intentionally sticky for the browser page lifetime. The
    // authoritative status may later complete, but the row remains discoverable
    // until a real page/session reset clears this store.
    observedRunningThreadKeys.value = [...observedRunningThreadKeys.value, key];
  }

  function updateTitle(hostId: number, threadId: string, title: string) {
    const key = pinnedKey(hostId, threadId);
    const existing = summariesByKey.value[key];
    if (existing === undefined) return;
    summariesByKey.value = {
      ...summariesByKey.value,
      [key]: { ...existing, title },
    };
  }

  function resetState() {
    summariesByKey.value = {};
    observedRunningThreadKeys.value = [];
  }

  return {
    summariesByKey,
    observedRunningThreadKeys,
    ingestGatewayThreads,
    ingestMetadata,
    upsertGatewayThread,
    upsertAppServerThread,
    recordRuntimeStatus,
    updateTitle,
    resetState,
  };
});

function summaryFromGatewayThread(
  thread: GatewayThread,
  projects: ProjectRecord[],
): ThreadActivitySummary {
  const project = projects.find(
    (candidate) =>
      candidate.remotePath === threadWorkspaceCwd(thread) && candidate.hostId === thread.hostId,
  );
  return summaryFromThread(thread.hostId, thread, project, thread.title);
}

function summaryFromAppServerThread(
  hostId: number,
  thread: AppServerThread,
  projects: ProjectRecord[],
): ThreadActivitySummary {
  const aliases = useGatewayCatalogStore().hosts.find(
    (host) => host.id === hostId,
  )?.directoryAliases;
  const workspaceCwd = canonicalDirectoryPath(thread.cwd, aliases);
  const project = projects.find(
    (candidate) => candidate.hostId === hostId && candidate.remotePath === workspaceCwd,
  );
  return summaryFromThread(hostId, thread, project, null);
}

function summaryFromThread(
  hostId: number,
  thread: Pick<
    AppServerThread,
    | "id"
    | "parentThreadId"
    | "agentNickname"
    | "agentRole"
    | "name"
    | "preview"
    | "cwd"
    | "source"
    | "recencyAt"
    | "updatedAt"
    | "createdAt"
  >,
  project: ProjectRecord | undefined,
  gatewayTitle: string | null,
): ThreadActivitySummary {
  const parentThreadId = stringOrNull(thread.parentThreadId);
  const agentNickname = stringOrNull(thread.agentNickname);
  const agentRole = stringOrNull(thread.agentRole);
  const sourceCwd = threadWorkspaceCwd(thread);
  const aliases = useGatewayCatalogStore().hosts.find(
    (host) => host.id === hostId,
  )?.directoryAliases;
  return {
    hostId,
    threadId: thread.id,
    title: firstNonEmptyString([gatewayTitle, thread.name, thread.preview]) ?? thread.id,
    cwd: sourceCwd === null ? null : canonicalDirectoryPath(sourceCwd, aliases),
    projectName: project?.name ?? null,
    parentThreadId,
    agentNickname,
    agentRole,
    isSubAgent:
      isAppServerSubAgentThread(thread) ||
      parentThreadId !== null ||
      agentRole !== null ||
      agentNickname !== null,
    updatedAt: threadRecency(thread),
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? trimmedOrNull(value) : null;
}
