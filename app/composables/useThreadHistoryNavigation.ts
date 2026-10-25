import { useEventListener } from "@vueuse/core";
import { useAuthStore } from "@/stores/auth";
import { useGatewayBootstrapStore } from "@/stores/gateway-bootstrap";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import { readGatewayRouteSelection } from "@/stores/gateway/route-state";

/** Restore canonical thread state when Back/Forward changes a branch URL. */
export function useThreadHistoryNavigation() {
  const auth = useAuthStore();
  const bootstrap = useGatewayBootstrapStore();
  const catalog = useGatewayCatalogStore();
  const navigation = useGatewayNavigationStore();
  const views = useGatewayThreadViewStore();
  useEventListener("popstate", () => {
    if (!auth.isAuthenticated || bootstrap.initializing) return;
    const target = readGatewayRouteSelection();
    if (
      target.hostId === null ||
      target.threadId === null ||
      !catalog.hosts.some((host) => host.id === target.hostId) ||
      (navigation.selectedHostId === target.hostId &&
        navigation.selectedThreadId === target.threadId)
    )
      return;
    // Thread opening already owns session/view epochs, scoped subscriptions and error reporting.
    // Replace only the entry being restored; never grow history in response to popstate.
    void views.openThread(target.threadId, { hostId: target.hostId, replaceRoute: true });
  });
}
