import { getValidatedQuery } from "h3";
import { threadBroker } from "../../utils/gateway/runtime/broker";
import {
  defineGatewayEventHandler,
  hostLogContext,
  setGatewayRequestLogContext,
} from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { threadListSchema } from "../../utils/gateway/http/validation/threads";
import { hostStore } from "../../utils/gateway/state/hosts";
import { projectStore } from "../../utils/gateway/state/projects";
import { withAllThreadSources } from "../../utils/gateway/protocol/thread-list";
import { threadProjectDiscovery } from "../../utils/gateway/runtime/thread-project-discovery";
import type { AppServerThread, GatewayThread } from "~~/shared/types";
import { trimmedOrNull } from "~~/shared/utils/strings";
import { gatewayThreadFromAppServer } from "../../utils/gateway/protocol/gateway-thread";

export default defineGatewayEventHandler(async (event) => {
  const query = await getValidatedQuery(event, (body) => threadListSchema.parse(body));
  const host = requireRecord(hostStore.getWithSecret(query.hostId), "Host not found");
  const userId = event.context.auth?.user.id;
  const discoveryGeneration =
    userId === undefined ? null : threadProjectDiscovery.captureGeneration(userId, host.id);
  setGatewayRequestLogContext(event, "threads/list", {
    ...hostLogContext(host),
    cwd: query.cwd ?? null,
    limit: query.limit,
    cursor: query.cursor ?? null,
    searchTerm: query.searchTerm ?? null,
  });

  const listParams = withAllThreadSources({
    limit: query.limit,
    cursor: trimmedOrNull(query.cursor),
    cwd: trimmedOrNull(query.cwd) ?? undefined,
    searchTerm: trimmedOrNull(query.searchTerm) ?? undefined,
  });
  const page = await threadBroker.listThreads(host, listParams);
  if (userId !== undefined && discoveryGeneration !== null) {
    const current = threadProjectDiscovery.indexPageIfCurrent(
      userId,
      host.id,
      discoveryGeneration,
      page,
    );
    if (current && shouldDiscoverHostProjects(query)) {
      threadProjectDiscovery.schedule(userId, host, page, listParams, discoveryGeneration);
    }
  }
  const projects = projectStore.list(host.id);
  const gatewayThreads = gatewayThreadsForList(host.id, page.data, query.searchTerm ?? null);
  // Directory groups describe Codex conversations, including history from a removed cwd.
  // Listing them needs no SFTP existence check; actual file operations report their own errors.
  return {
    ...page,
    data: gatewayThreads,
    projects,
  };
});

function shouldDiscoverHostProjects(query: {
  cwd?: string | null;
  searchTerm?: string | null;
  cursor?: string | null;
}) {
  return (
    trimmedOrNull(query.cwd) === null &&
    trimmedOrNull(query.searchTerm) === null &&
    trimmedOrNull(query.cursor) === null
  );
}

function gatewayThreadsForList(
  hostId: number,
  remoteThreads: AppServerThread[],
  searchTerm: string | null,
) {
  const normalizedSearch = searchTerm?.trim().toLowerCase() ?? "";
  // The native page and cursor belong to Codex. The frontend independently projects its
  // selected official snapshot; appending cached snapshots here repeats rows on later pages.
  return remoteThreads
    .map((thread) => {
      return gatewayThreadFromAppServer(hostId, thread);
    })
    .filter((thread) => {
      if (!normalizedSearch) {
        return true;
      }
      return [thread.id, thread.title, thread.name, thread.preview, thread.cwd]
        .filter((value): value is string => typeof value === "string")
        .some((value) => String(value).toLowerCase().includes(normalizedSearch));
    })
    .sort(
      (left, right) =>
        Number(right.recencyAt ?? right.updatedAt ?? 0) -
        Number(left.recencyAt ?? left.updatedAt ?? 0),
    ) satisfies GatewayThread[];
}
