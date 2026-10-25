# Edit-to-branch experience and regression gates

## Required interaction contract

Edit is a command transaction, not a rewind of the source or its files. Separate three lifetimes:

1. **Editor draft:** loading, editing, then fork pending. Keep the ordinary composer draft/uploads independent.
2. **Branch operation:** retain immutable submitted input, source identity, edit capability, official branch metadata, acceptance/failure and recovery identity after the editor unmounts.
3. **Selected view:** only its captured view epoch authorizes automatic navigation. Completing an older operation must never steal a later user selection.

Once the official fork reply establishes identity, retire the original editor and show ordinary original content again. If the source still owns selection, commit the new branch's real metadata, cwd and URL immediately, with a sending status. Do not manufacture an empty history or a null pagination cursor. Do not resume the fork merely to make the UI look ready before its explicit revision is accepted. After the real `turn.revise.accepted`, hydrate normally. Acceptance is distinct from model completion and from snapshot loading.

A late fork while the user is elsewhere completes the explicitly requested operation in the background without changing selection. Opening history can fail independently of sending: retry opening the branch, not creating another branch or sending another revision.

## Failure semantics

- A known pre-dispatch failure or definite upstream rejection is retryable with the same branch and immutable input.
- A connection failure while waiting for acknowledgement permits checking the existing capability/receipt. It never creates a new branch automatically.
- An ambiguous upstream post-dispatch failure is not an enabled endless Retry loop. Preserve the deduplication promise and offer the existing branch for inspection.
- Lost/uncertain fork acknowledgements remain conservative: no automatic new edit identity or repeated fork.
- Auth reset, host deletion/configuration changes invalidate drafts and operations. A late response cannot restore them in another scope.

Server capabilities remain disposable, user/host/config scoped and bounded; a Gateway restart or capability expiry is not durable exactly-once delivery. Existing official branches survive.

## Sidebar/catalog contract

- Native HTTP pages and cursors retain their own membership. A display-only projection may union the actual selected official snapshot/fork DTO and empty official conversations in the bounded view cache, never insert them into pagination. Empty conversations can remain absent from the durable index until their first turn; switching to a second conversation must preserve access to the first. Interactive lists use the official complete listing semantics, since an index-only request can miss historical rollouts or incomplete index metadata.
- Filter host/cwd, pins and true subagents before deduplication/limiting. Fork ancestry is not subagent ancestry.
- Use one ordering for missing and indexed selected threads. Official creation time counts as activity for a new fork that inherits older turn recency; equal ranks use deterministic identity tie breakers. Keep the selected row discoverable beyond the display cap.
- Every list request owns a generation. Newer requests and synchronous scope changes, including away-and-back, invalidate older success, errors and loading completion.
- Catalog loading is separate from conversation loading; sidebar refresh must not remount/blank the conversation.
- A native page records its host/directory/search scope. Restoring a URL or last-open thread refreshes a mismatched directory page after the official snapshot establishes cwd, independently of history loading; it does not reuse bootstrap's unrelated default-directory list.
- Capture per-thread summary observations and runtime revisions before HTTP requests. A response cannot rewind metadata or running/completed observations received while it was pending.

## Reproducible checks

`pnpm test:edit-ui` runs deterministic schema-validated DTO projection units and actual Vue/Pinia state tests. These are not evidence of a real Codex integration.

`pnpm test:e2e -- tests/e2e/thread-edit-ux.spec.ts tests/e2e/thread-edit-branch.spec.ts tests/e2e/thread-edit-branch-safety.spec.ts tests/e2e/thread-edit-branch.mobile.spec.ts tests/e2e/sidebar-tree.spec.ts` runs the real Docker/Nuxt/SSH/Codex harness. Transport gates delay/release genuine server responses rather than inventing model output or histories in browser state.

New real-link cases record painted frame traces, not only eventual visibility:

- Fork metadata commits URL/cwd and retires the editor before delayed acceptance and hydration; one fork/send, no duplicate/vanishing selected row, source/draft/files preserved.
- Late successful fork after another conversation is selected does not hijack navigation or leave a dead source editor.
- Two real HTTP pages completed in reverse order do not roll back rows or reload the conversation.
- Directory away-and-back invalidates pending HTTP; old-directory rows never paint under the new directory.
- A delayed idle HTTP page cannot overwrite a real revised turn's newer running observation.
- Existing real lost-ack coverage now uses explicit receipt reconciliation rather than a stuck read-only editor.

Before deployment, run the complete `pnpm test:e2e` suite, including the acceptance routes below, and the focused experience cases against the semantically merged production source. Unit coverage and unexecuted test definitions do not replace passing real integration results.

## Same-name directory navigation

Directory identity remains the exact `hostId + cwd` pair. Same-name directories can be an existing project, an older location or another user's historical path; a matching basename alone never authorizes merging their conversations. The sidebar removes exact duplicate identities and gives name collisions the shortest distinct parent-path hint. macOS home and iCloud hints are compacted for display, with original paths retained as tooltips and navigation targets. Names on different hosts do not create false collisions.

`project-name-disambiguation.spec.ts` creates real same-name directory histories and opens every corresponding original thread. `thread-edit-ux-recovery.spec.ts` covers native HTTP page size and cursor membership, reversed search responses, actual host/project selection chains, and a transport failure after an accepted revision. The late-fork case also checks an unselected branch's completion attention. Mobile coverage includes an actual revised send. `thread-edit-goal.spec.ts` seeds an isolated persisted active goal, following the official fork-goal fixture, then verifies inheritance, history activation and an actual explicit revised model turn through the official daemon. Cross-tab pin/unpin coverage remains in `realtime-multi-client.spec.ts`.

## Container dependency setup

The runner sets `COREPACK_HOME=/opt/corepack` so build and browser containers use the same verified pinned pnpm installation even when their HOME differs. When a build network needs an HTTP proxy, `E2E_BUILD_PROXY` explicitly passes it only as Docker build arguments. Docker CLI registry metadata uses the CLI's own proxy environment independently. `E2E_BUILD_MEMORY_LIMIT` can increase only the build container's native-memory headroom (default `2g`); the application heap and browser runtime limits stay unchanged. Run builds serially on constrained hosts. The application and browser still run in their separate containers through `pnpm test:e2e`; no mock app-server is involved. The login helper waits for the trusted-session probe's visible outcome before deciding whether the isolated password fixture needs login.

Focused experience specs establish the existing verified official daemon fixture before adding a Gateway host; the separate upgrade tests retain their empty-runtime coverage.

The full regression also checks that Tmux panel visibility survives a reload. Session reset clears its runtime monitor/scanner data while retaining the account-scoped panel preference, matching the saved workspace layout's lifetime.
