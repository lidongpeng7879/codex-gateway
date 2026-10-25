import { canonicalDirectoryPath, directoryPathsForListing } from "~~/shared/directory-aliases";
import { currentGatewayMemoryState } from "./memory";

export function hostDirectoryAliases(hostId: number) {
  return (
    currentGatewayMemoryState().hosts.find((host) => host.id === hostId)?.directoryAliases ?? []
  );
}

export function hostWorkspacePath(hostId: number, cwd: string) {
  return canonicalDirectoryPath(cwd, hostDirectoryAliases(hostId));
}

export function hostDirectoryListFilter(hostId: number, cwd: string | null) {
  if (cwd === null) return undefined;
  const paths = directoryPathsForListing(cwd, hostDirectoryAliases(hostId));
  return paths.length === 1 ? paths[0] : paths;
}
