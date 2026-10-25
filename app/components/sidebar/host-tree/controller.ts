import type { InjectionKey, Ref } from "vue";
import type { ThreadRuntimeStatus } from "@/stores/gateway/types";
import type { HostRecord, ProjectRecord, SidebarThread } from "../sidebar-types";
import type { LongPressContextMenuHandlers } from "@/composables/interactions/useLongPressContextMenu";

export interface HostTreeController {
  hosts: HostRecord[];
  projectsByHost: Map<number, ProjectRecord[]>;
  projectDirectoryHints: Map<string, string | null>;
  projectThreads: SidebarThread[];
  expandedHostIds: Set<number>;
  expandedProjectKeys: Set<string>;
  selectedHostId: number | null;
  selectedCwd: string | null;
  selectedThreadId: string | null;
  hostConnectionStatuses: Record<number, { status: string; message?: string | null }>;
  longPressHandlers?: LongPressContextMenuHandlers;
  selectHost: (hostId: number) => void;
  addProject: (host: HostRecord) => void;
  deleteHost: (hostId: number) => void;
  monitorHost: (hostId: number) => void;
  selectProject: (project: ProjectRecord, event: MouseEvent) => void;
  startThreadInProject: (project: ProjectRecord) => void;
  openThread: (threadId: string, context: { hostId: number; cwd: string }) => void;
  toggleThreadPin: (threadId: string, pinned: boolean) => void;
  rename: (thread: SidebarThread & { hostId: number }) => void;
  threadRuntimeStatus: (hostId: number, threadId: string) => ThreadRuntimeStatus;
  threadCompletionAttention: (hostId: number, threadId: string) => boolean;
}

export const HOST_TREE_CONTROLLER: InjectionKey<Ref<HostTreeController>> =
  Symbol("host-tree-controller");

export function requireHostTreeController() {
  const controller = inject(HOST_TREE_CONTROLLER);
  if (!controller) throw new Error("Host tree controller is unavailable");
  return controller;
}
