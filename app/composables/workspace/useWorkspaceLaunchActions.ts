import { threadWorkspaceCwd } from "~~/shared/directory-aliases";
import { storeToRefs } from "pinia";
import { computed } from "vue";
import { useGatewayTerminalTransport } from "@/composables/terminal/useGatewayTerminalTransport";
import { createUuid } from "@/lib/uuid";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { hostById, projectForDirectory } from "@/stores/gateway-catalog/selectors";
import { useGatewayBrowserStore } from "@/stores/gateway-browser";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { useGatewayWorkspaceLayoutStore } from "@/stores/gateway-workspace-layout";
import { titleForThread } from "@/stores/gateway/thread-utils/identity";
import { browserWorkspacePanelId } from "@/stores/gateway/workspace-panels";
import { HOST_METRICS_WORKSPACE_PANEL_ID } from "@/stores/gateway/workspace-panels";
import { useGatewayHostMetricsPanelStore } from "@/stores/gateway-host-metrics/panels";
import { workspaceLayoutScopeKey } from "@/stores/gateway-workspace-layout";

export function useWorkspaceLaunchActions() {
  const gateway = useGatewayCatalogStore();
  const navigation = useGatewayNavigationStore();
  const threadView = useGatewayThreadViewStore();
  const browser = useGatewayBrowserStore();
  const layout = useGatewayWorkspaceLayoutStore();
  const terminal = useGatewayTerminalTransport();
  const hostMetricsPanels = useGatewayHostMetricsPanelStore();
  const { hosts, projects } = storeToRefs(gateway);
  const { selectedHostId, selectedCwd, selectedThreadId } = storeToRefs(navigation);
  const selectedHost = computed(() => hostById(hosts.value, selectedHostId.value));
  const selectedProject = computed(() =>
    projectForDirectory(projects.value, selectedHostId.value, selectedCwd.value),
  );

  function openTerminal() {
    if (selectedHostId.value === null || selectedHost.value === null) return;
    if (selectedThreadId.value !== null) {
      const thread = threadView.currentThread;
      void terminal.openTerminal({
        scope: "thread",
        hostId: selectedHostId.value,
        threadId: selectedThreadId.value,
        cwd: threadWorkspaceCwd(thread) ?? selectedCwd.value,
        title: titleForThread(thread ?? { id: selectedThreadId.value }),
      });
      return;
    }
    if (selectedCwd.value !== null) {
      void terminal.openTerminal({
        scope: "project",
        hostId: selectedHostId.value,
        cwd: selectedCwd.value,
        title: selectedProject.value?.name ?? selectedCwd.value,
      });
      return;
    }
    void terminal.openTerminal({
      scope: "host",
      hostId: selectedHostId.value,
      title: selectedHost.value.name,
    });
  }

  function openBrowser(targetUrl: string) {
    if (selectedHostId.value === null) return;
    const panelId = createUuid();
    browser.addPanel({
      panelId,
      title: browserTitle(targetUrl),
      targetUrl,
      hostId: selectedHostId.value,
      cwd: selectedCwd.value,
      threadId: selectedThreadId.value,
    });
    layout.requestPanelActivation(browserWorkspacePanelId(panelId));
  }

  function openHostMonitor() {
    if (selectedHostId.value === null) return;
    const scopeKey = workspaceLayoutScopeKey(
      selectedHostId.value,
      selectedCwd.value,
      selectedThreadId.value,
    );
    hostMetricsPanels.open(scopeKey);
    layout.requestPanelActivation(HOST_METRICS_WORKSPACE_PANEL_ID);
  }

  return {
    canLaunch: computed(() => selectedHostId.value !== null),
    selectedHostTitle: computed(() => selectedHost.value?.name ?? "Codex Gateway"),
    openTerminal,
    openBrowser,
    openHostMonitor,
  };
}

function browserTitle(targetUrl: string) {
  try {
    return new URL(/:\/\//.test(targetUrl) ? targetUrl : `http://${targetUrl}`).host;
  } catch {
    return targetUrl;
  }
}
