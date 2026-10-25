/** Directory identity is scoped to a host; paths themselves can contain separators. */
export function workspaceDirectoryKey(hostId: number, cwd: string) {
  return `${hostId}:${encodeURIComponent(cwd)}`;
}

/** A display hint only: historical cwd values remain the exact navigation identity. */
export function workspaceDirectoryHint(cwd: string) {
  const parts = cwd.split("/").filter(Boolean);
  parts.pop();
  const parent = parts.join("/");
  const appleHome = /^Users\/([^/]+)\/(.*)$/.exec(parent);
  if (appleHome) {
    const homePath = appleHome[2]!.replace(
      /^Library\/Mobile Documents\/com~apple~CloudDocs(?:\/|$)/,
      "iCloud/",
    );
    return `~${appleHome[1]}/${homePath}`;
  }
  return cwd.startsWith("/") ? `/${parent}` : parent || ".";
}

export function workspaceDirectoryHints(
  projects: ReadonlyArray<{ hostId: number; name: string; remotePath: string }>,
) {
  const groups = new Map<string, Set<string>>();
  for (const project of projects) {
    const key = `${project.hostId}:${project.name.toLowerCase()}`;
    const paths = groups.get(key) ?? new Set<string>();
    paths.add(project.remotePath);
    groups.set(key, paths);
  }
  const hints = new Map<string, string | null>();
  for (const project of projects) {
    const paths = [...groups.get(`${project.hostId}:${project.name.toLowerCase()}`)!];
    let hint: string | null = null;
    if (paths.length > 1) {
      const compact = paths.map(workspaceDirectoryHint);
      // A literal iCloud directory and Apple's cloud root may compact to the same hint.
      // In that case use the original paths so display shortening never invents equivalence.
      const labels = new Set(compact).size === paths.length ? compact : paths;
      const index = paths.indexOf(project.remotePath);
      const parts = labels[index]!.split("/").filter(Boolean);
      hint = labels[index]!;
      for (let length = 1; length <= parts.length; length++) {
        const suffix = parts.slice(-length).join("/");
        if (
          labels.every(
            (label, other) =>
              other === index ||
              label.split("/").filter(Boolean).slice(-length).join("/") !== suffix,
          )
        ) {
          hint = suffix;
          break;
        }
      }
    }
    hints.set(workspaceDirectoryKey(project.hostId, project.remotePath), hint);
  }
  return hints;
}
