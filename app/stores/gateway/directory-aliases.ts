import {
  canonicalDirectoryPath,
  threadWorkspaceCwd,
  withThreadWorkspace,
} from "~~/shared/directory-aliases";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { useGatewayThreadActivityStore } from "@/stores/gateway-thread-activity";
import { writeGatewayRouteSelection } from "./route-state";

/** Refresh navigation metadata without resetting the current timeline. */
export function reconcileHostDirectoryAliases(hostId: number) {
  const catalog = useGatewayCatalogStore();
  const navigation = useGatewayNavigationStore();
  const views = useGatewayThreadViewStore();
  const aliases = catalog.hosts.find((host) => host.id === hostId)?.directoryAliases ?? [];
  navigation.threads = navigation.threads.map((thread) =>
    thread.hostId === hostId ? withThreadWorkspace(thread, aliases) : thread,
  );
  for (const view of Object.values(views.threadViews)) {
    if (view.hostId !== hostId || view.currentThread === null) continue;
    view.currentThread = withThreadWorkspace(view.currentThread, aliases);
    view.cwd = threadWorkspaceCwd(view.currentThread);
  }
  if (views.currentThread?.hostId === hostId)
    views.currentThread = withThreadWorkspace(views.currentThread, aliases);
  const activity = useGatewayThreadActivityStore();
  for (const summary of Object.values(activity.summariesByKey)) {
    if (summary.hostId === hostId && summary.cwd !== null)
      summary.cwd = canonicalDirectoryPath(summary.cwd, aliases);
  }
  catalog.mergeProjects([]);
  if (navigation.selectedHostId !== hostId) return;
  navigation.threadListEpoch++;
  navigation.loadingThreads = false;
  navigation.threadListScope = null;
  navigation.selectedCwd =
    threadWorkspaceCwd(views.currentThread) ??
    (navigation.selectedCwd === null
      ? null
      : canonicalDirectoryPath(navigation.selectedCwd, aliases));
  writeGatewayRouteSelection(
    { hostId, cwd: navigation.selectedCwd, threadId: navigation.selectedThreadId },
    { replace: true },
  );
}
