# Unify directory groups after a project move

In Settings → Hosts → Edit, open **Unify directories after a move**. Add each full original
directory and its full current workspace directory, then save. These mappings are part of the
user's Host configuration, persisted in the encrypted SQLite config and included in config
export/import. They apply only to that Host.

Only add mappings after confirming the paths belong to the same project. Matching names alone
do not establish that two checkouts are equivalent. Without an explicit mapping, distinct paths
remain distinct and retain their existing path hints. Removing a mapping makes the original
groups discoverable again; it does not delete or rewrite conversations.

Configured groups have one canonical sidebar row. Existing links using an original path resolve
to the current directory, and opening or pinning an older conversation retains that directory
in navigation and URL restoration. Old histories stay accessible even if the original directory
no longer exists. The thread view shows both the current workspace and the original directory.

The official Codex `thread.cwd` and timeline remain unchanged. Gateway exposes the configured
navigation directory separately as optional `workspaceCwd`. It passes the current directory and
all explicitly mapped original paths to native `thread/list` in one query, keeping Codex's own
ordering, limit and opaque cursor. It does not concatenate independently paginated lists.

New conversations, file references, workspace files and terminals use the configured current
directory. For a new turn or an edited branch, the server resolves the mapping from official
thread metadata and passes it to `turn/start`. An arbitrary browser cwd hint cannot move a thread.
Steering a turn already running retains that turn's execution context.

Mappings require absolute paths. Duplicate original paths, self mappings, chains and cycles are
rejected. They do not move project files, edit imported rollouts, change official project IDs,
merge conversation identities, or restart the Codex backend.

`tests/e2e/directory-aliases.spec.ts` covers the real SSH/Codex path: explicit settings, one sidebar
group, unrelated names kept separate, native union pagination, missing old directories, unchanged
timelines, reload and pin restoration, and actual model turns and edited branches reading a file
available only in the current workspace.
