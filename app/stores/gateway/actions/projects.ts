import type {
  ModelListResult,
  ProjectCreateInput,
  ProjectRecord,
  RemoteDirectoryEntry,
} from "~~/shared/types";
import { gatewayApi } from "@/utils/gateway-api";
import { canonicalDirectoryPath } from "~~/shared/directory-aliases";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { useGatewayBootstrapStore } from "@/stores/gateway-bootstrap";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { writeGatewayRouteSelection } from "../route-state";
import { cacheSelectedThreadView, beginViewTransition } from "../thread-open/view-state";
import { messageFromError } from "../thread-utils/identity";
import { captureSessionEpoch } from "@/utils/session-epoch";

export function createProjectActions() {
  let pendingModelRequest: {
    hostId: number;
    promise: Promise<void>;
    sessionIsCurrent: () => boolean;
  } | null = null;

  function clearThreadSelection() {
    const navigation = useGatewayNavigationStore();
    cacheSelectedThreadView();
    beginViewTransition();
    navigation.selectedThreadId = null;
    useGatewayThreadViewStore().resetCurrentView();
    useGatewayBootstrapStore().clearError();
  }

  async function loadModels(hostId: number) {
    const sessionIsCurrent = captureSessionEpoch();
    const catalog = useGatewayCatalogStore();
    const bootstrap = useGatewayBootstrapStore();
    const navigation = useGatewayNavigationStore();
    catalog.loadingModels = true;
    const cwd = navigation.selectedCwd;
    const threadId = navigation.selectedThreadId;
    try {
      const response = await gatewayApi<ModelListResult>("/api/models", {
        query: { hostId, includeHidden: false, limit: 50 },
      });
      if (!sessionIsCurrent() || navigation.selectedHostId !== hostId) return;
      catalog.models = response.data ?? [];
      catalog.modelsHostId = hostId;
    } catch (error: unknown) {
      if (!sessionIsCurrent()) return;
      bootstrap.setError(
        messageFromError(error, bootstrap.t("app.listModelsFailed"), bootstrap.errorLabels),
        { hostId, cwd, threadId },
      );
    } finally {
      if (sessionIsCurrent() && navigation.selectedHostId === hostId) catalog.loadingModels = false;
    }
  }

  return {
    async selectProject(cwd: string) {
      const navigation = useGatewayNavigationStore();
      clearThreadSelection();
      navigation.selectedCwd = cwd;
      writeGatewayRouteSelection({ hostId: navigation.selectedHostId, cwd, threadId: null });
      await navigation.listThreads();
    },

    async listRemoteDirectories(path = "~", hostId = useGatewayNavigationStore().selectedHostId) {
      if (hostId === null) return { path, entries: [] as RemoteDirectoryEntry[] };
      return gatewayApi<{ path: string; entries: RemoteDirectoryEntry[] }>(
        "/api/remote/directories",
        { query: { hostId, path } },
      );
    },

    async listModels() {
      const catalog = useGatewayCatalogStore();
      const hostId = useGatewayNavigationStore().selectedHostId;
      if (hostId === null) {
        catalog.models = [];
        catalog.modelsHostId = null;
        return;
      }
      if (pendingModelRequest?.hostId === hostId && pendingModelRequest.sessionIsCurrent())
        return pendingModelRequest.promise;
      const sessionIsCurrent = captureSessionEpoch();
      const promise = loadModels(hostId).finally(() => {
        if (pendingModelRequest?.promise === promise) pendingModelRequest = null;
      });
      pendingModelRequest = { hostId, promise, sessionIsCurrent };
      return promise;
    },

    async ensureSelectedHostModels() {
      const catalog = useGatewayCatalogStore();
      const hostId = useGatewayNavigationStore().selectedHostId;
      if (hostId === null || catalog.modelsHostId === hostId) return;
      await catalog.listModels();
    },

    async createProject(input: ProjectCreateInput) {
      const sessionIsCurrent = captureSessionEpoch();
      const catalog = useGatewayCatalogStore();
      const navigation = useGatewayNavigationStore();
      const project = await gatewayApi<ProjectRecord>("/api/projects", {
        method: "POST",
        body: input,
      });
      if (!sessionIsCurrent()) return project;
      catalog.mergeProjects([project]);
      clearThreadSelection();
      navigation.selectedHostId = project.hostId;
      navigation.selectedCwd = project.remotePath;
      writeGatewayRouteSelection({
        hostId: project.hostId,
        cwd: project.remotePath,
        threadId: null,
      });
      // Creating a project explicitly navigates to it, including when its host was registered
      // without being selected. Load that host's models here instead of relying on host creation
      // to have navigated and populated the composer as an unrelated side effect.
      await Promise.all([catalog.listModels(), navigation.listThreads()]);
      return project;
    },

    mergeProjects(projects: ProjectRecord[]) {
      const catalog = useGatewayCatalogStore();
      const groups = new Map<string, ProjectRecord>();
      for (const project of [...catalog.projects, ...projects]) {
        const host = catalog.hosts.find((candidate) => candidate.id === project.hostId);
        const remotePath = canonicalDirectoryPath(project.remotePath, host?.directoryAliases);
        groups.set(JSON.stringify([project.hostId, remotePath]), {
          ...project,
          remotePath,
          name:
            remotePath === project.remotePath
              ? project.name
              : (remotePath.split("/").filter(Boolean).at(-1) ?? "root"),
        });
      }
      catalog.projects = [...groups.values()];
    },

    ensureSelectedProject() {
      const catalog = useGatewayCatalogStore();
      const navigation = useGatewayNavigationStore();
      if (navigation.selectedHostId === null || navigation.selectedCwd !== null) return;
      navigation.selectedCwd =
        catalog.projects.find((project) => project.hostId === navigation.selectedHostId)
          ?.remotePath ?? null;
    },
  };
}
