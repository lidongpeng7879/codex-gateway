import type { DirectoryAlias } from "./types";

/** Only explicit, exact paths are equivalent. A shared basename is never sufficient. */
export function canonicalDirectoryPath(cwd: string, aliases: readonly DirectoryAlias[] = []) {
  return aliases.find((alias) => alias.originalPath === cwd)?.workspacePath ?? cwd;
}

/** Let Codex own the union, ordering and cursor instead of merging independent pages. */
export function directoryPathsForListing(cwd: string, aliases: readonly DirectoryAlias[] = []) {
  const canonical = canonicalDirectoryPath(cwd, aliases);
  return [
    canonical,
    ...aliases
      .filter((alias) => alias.workspacePath === canonical)
      .map((alias) => alias.originalPath),
  ];
}

export function threadWorkspaceCwd(
  thread: { cwd: string | null; workspaceCwd?: string } | null | undefined,
) {
  return thread?.workspaceCwd ?? thread?.cwd ?? null;
}

export function withThreadWorkspace<T extends { cwd: string; workspaceCwd?: string }>(
  thread: T,
  aliases: readonly DirectoryAlias[] = [],
): T {
  const source = { ...thread };
  delete source.workspaceCwd;
  const workspaceCwd = canonicalDirectoryPath(thread.cwd, aliases);
  return { ...source, ...(workspaceCwd === thread.cwd ? {} : { workspaceCwd }) };
}
