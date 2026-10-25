import assert from "node:assert/strict";
import { test } from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { ref, computed, watch } from "vue";
// Standalone source tests supply Nuxt compile-time auto-imports from the real Vue implementation.
Object.assign(globalThis, { ref, computed, watch });
import { gatewayThreadSchema } from "../../shared/runtime/app-server.ts";
import type { GatewayThread } from "../../shared/types.ts";
import { projectDirectoryThreads } from "../../app/stores/gateway-navigation/project-threads.ts";
import { sortThreads } from "../../app/stores/gateway/thread-utils/identity.ts";
import { workspaceDirectoryHints, workspaceDirectoryKey } from "../../shared/utils/workspace.ts";

void test("same-name historical directories stay distinct with visible home and location hints", () => {
  const paths = [
    "/Users/alice/Documents/output/0-Thesis-SCUT",
    "/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/MyDocuments/output/0-Thesis-SCUT",
    "/Users/bob/Library/Mobile Documents/com~apple~CloudDocs/MyDocuments/output/0-Thesis-SCUT",
  ];
  const projects = paths.map((remotePath) => ({ hostId: 1, name: "0-Thesis-SCUT", remotePath }));
  const hints = workspaceDirectoryHints([
    ...projects,
    projects[0]!,
    { hostId: 2, name: "0-Thesis-SCUT", remotePath: paths[0]! },
  ]);
  assert.deepEqual(
    paths.map((path) => hints.get(workspaceDirectoryKey(1, path))),
    ["Documents/output", "~alice/iCloud/MyDocuments/output", "~bob/iCloud/MyDocuments/output"],
  );
  assert.equal(hints.get(workspaceDirectoryKey(2, paths[0]!)), null);
  assert.deepEqual(
    projects.map((project) => project.remotePath),
    paths,
  );
});

// Schema-validated DTOs for deterministic projection units, not an app-server substitute.
function thread(id: string, overrides: Partial<GatewayThread> = {}) {
  return gatewayThreadSchema.parse({
    id,
    sessionId: id,
    hostId: 1,
    cwd: "/workspace/a",
    pinned: false,
    title: id,
    environments: null,
    extra: null,
    forkedFromId: null,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    model: null,
    reasoningEffort: null,
    createdAt: 100,
    updatedAt: 100,
    recencyAt: 100,
    status: { type: "idle" },
    path: null,
    cliVersion: "0.164.0",
    originator: "codex",
    name: null,
    source: "cli",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    daybreakEnabled: null,
    gitInfo: null,
    turns: [],
    ...overrides,
  });
}
function project(
  threads: GatewayThread[],
  snapshots: GatewayThread[] = [],
  selectedThreadId: string | null = null,
  limit = 20,
) {
  return projectDirectoryThreads({
    threads,
    snapshots,
    selectedThreadId,
    hostId: 1,
    cwd: "/workspace/a",
    limit,
  });
}
void test("scope filtering excludes old host/directory rows before overlaying the current thread", () => {
  assert.deepEqual(
    project([
      thread("a"),
      thread("other-host", { hostId: 2 }),
      thread("other-cwd", { cwd: "/workspace/b" }),
    ]).map((row) => row.id),
    ["a"],
  );
});
void test("ordinary fork ancestry is not classified as subagent ancestry", () => {
  const branch = thread("branch", { forkedFromId: "source", createdAt: 200, recencyAt: 1 });
  assert.deepEqual(
    project([], [branch], branch.id).map((row) => row.id),
    ["branch"],
  );
});
void test("actual subagent snapshots never enter project navigation", () => {
  assert.equal(project([], [thread("sub", { parentThreadId: "parent" })], "sub").length, 0);
});
void test("source-classified subagents are excluded even before parent metadata arrives", () => {
  assert.equal(project([], [thread("sub", { source: { subAgent: "review" } })], "sub").length, 0);
});
void test("missing/present/missing HTTP membership uses one stable fork rank", () => {
  const a = thread("a");
  const b = thread("b");
  const branch = thread("branch", {
    createdAt: 200,
    updatedAt: 200,
    recencyAt: 1,
    forkedFromId: "a",
  });
  const orders = [
    [a, b],
    [a, b, branch],
    [a, b],
  ].map((page) => project(page, [branch], branch.id).map((row) => row.id));
  assert.deepEqual(orders, [
    ["branch", "a", "b"],
    ["branch", "a", "b"],
    ["branch", "a", "b"],
  ]);
});
void test("newer official snapshot metadata wins without duplicating the HTTP row", () => {
  const result = project(
    [thread("a", { title: "old" })],
    [thread("a", { title: "new", updatedAt: 101 })],
    "a",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, "new");
});
void test("an older selected snapshot does not replace newer HTTP metadata", () => {
  assert.equal(
    project(
      [thread("a", { title: "new", updatedAt: 101 })],
      [thread("a", { title: "old" })],
      "a",
    )[0]?.title,
    "new",
  );
});
void test("selected older thread stays discoverable beyond the 20-row limit", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    thread(`row-${String(i).padStart(2, "0")}`, { createdAt: 100 + i, recencyAt: 100 + i }),
  );
  const visible = project(rows, [], "row-00");
  assert.equal(visible.length, 20);
  assert.equal(visible.at(-1)?.id, "row-00");
  assert.equal(new Set(visible.map((row) => row.id)).size, 20);
});
void test("equal recency has deterministic host/thread identity tie breakers", () => {
  const a = thread("a");
  const b = thread("b");
  const c = thread("a", { hostId: 2 });
  assert.deepEqual(
    sortThreads([c, b, a]).map((row) => `${row.hostId}:${row.id}`),
    ["1:a", "1:b", "2:a"],
  );
  assert.deepEqual(sortThreads([a, b, c]), sortThreads([c, b, a]));
});
void test("configured pin exclusions also exclude selected snapshot overlays", () => {
  const a = thread("a");
  assert.deepEqual(
    projectDirectoryThreads({
      threads: [a],
      snapshots: [a],
      selectedThreadId: a.id,
      hostId: 1,
      cwd: a.cwd,
      excludedIds: new Set([a.id]),
      limit: 20,
    }),
    [],
  );
});
void test("display projection does not mutate native page membership or official snapshots", () => {
  const rows = [thread("b"), thread("a")];
  const snapshots = [thread("new", { createdAt: 200 })];
  const before = JSON.stringify({ rows, snapshots });
  projectDirectoryThreads({
    threads: Object.freeze(rows),
    snapshots: Object.freeze(snapshots),
    selectedThreadId: "new",
    hostId: 1,
    cwd: "/workspace/a",
    limit: 20,
  });
  assert.equal(JSON.stringify({ rows, snapshots }), before);
});
void test("zero display limit never reintroduces a selected snapshot", () => {
  assert.equal(project([], [thread("a")], "a", 0).length, 0);
});
void test("actual Vue/Pinia scope watcher synchronously invalidates host and directory ABA", async () => {
  const { useGatewayNavigationStore } =
    await import("../../app/stores/gateway-navigation/index.ts");
  setActivePinia(createPinia());
  const navigation = useGatewayNavigationStore();
  navigation.selectedHostId = 1;
  navigation.selectedCwd = "/workspace/a";
  const epoch = ++navigation.threadListEpoch;
  navigation.loadingThreads = true;
  navigation.selectedCwd = "/workspace/b";
  assert.equal(navigation.loadingThreads, false);
  navigation.selectedCwd = "/workspace/a";
  assert(navigation.threadListEpoch > epoch);
  const directoryEpoch = navigation.threadListEpoch;
  navigation.selectedHostId = 2;
  navigation.selectedHostId = 1;
  assert(navigation.threadListEpoch > directoryEpoch);
});

void test("restored selection refreshes a different native page without repeating a current request", async () => {
  const { useGatewayNavigationStore } =
    await import("../../app/stores/gateway-navigation/index.ts");
  setActivePinia(createPinia());
  const navigation = useGatewayNavigationStore();
  navigation.selectedHostId = 1;
  navigation.selectedCwd = "/workspace/restored";
  navigation.threadListScope = { hostId: 1, cwd: "/workspace/bootstrap", searchTerm: "" };
  let requests = 0;
  // Observe the actual action's decision in isolation; real transport is covered by E2E.
  navigation.listThreads = async () => {
    requests++;
    navigation.threadListScope = {
      hostId: navigation.selectedHostId!,
      cwd: navigation.selectedCwd,
      searchTerm: "",
    };
  };
  await navigation.ensureThreadListForSelection();
  assert.equal(requests, 1);
  await navigation.ensureThreadListForSelection();
  assert.equal(requests, 1);
  navigation.selectedCwd = "/workspace/pending";
  navigation.loadingThreads = true;
  await navigation.ensureThreadListForSelection();
  assert.equal(requests, 1);
  navigation.loadingThreads = false;
  await navigation.ensureThreadListForSelection();
  assert.equal(requests, 2);
  navigation.threadListScope = { hostId: 1, cwd: navigation.selectedCwd, searchTerm: "filtered" };
  await navigation.ensureThreadListForSelection();
  assert.equal(requests, 3);
  navigation.resetState();
  assert.equal(navigation.threadListScope, null);
});

void test("activity cannot rewind recency/title from an older index DTO", async () => {
  const { useGatewayThreadActivityStore } =
    await import("../../app/stores/gateway-thread-activity/index.ts");
  setActivePinia(createPinia());
  const activity = useGatewayThreadActivityStore();
  activity.upsertGatewayThread(
    thread("a", { createdAt: 200, updatedAt: 200, recencyAt: 200, title: "fresh" }),
    [],
  );
  activity.upsertGatewayThread(
    thread("a", { createdAt: 100, updatedAt: 100, recencyAt: 100, title: "stale" }),
    [],
  );
  assert.equal(activity.summariesByKey["1:a"]?.title, "fresh");
  assert.equal(activity.summariesByKey["1:a"]?.updatedAt, 200);
});
void test("late structural subagent classification remains authoritative without rewinding fresh display metadata", async () => {
  const { useGatewayThreadActivityStore } =
    await import("../../app/stores/gateway-thread-activity/index.ts");
  setActivePinia(createPinia());
  const activity = useGatewayThreadActivityStore();
  activity.upsertGatewayThread(thread("a", { createdAt: 200, updatedAt: 200, title: "fresh" }), []);
  activity.upsertGatewayThread(thread("a", { parentThreadId: "parent", title: "stale" }), []);
  assert.equal(activity.summariesByKey["1:a"]?.isSubAgent, true);
  assert.equal(activity.summariesByKey["1:a"]?.title, "fresh");
});
void test("per-thread observation identities distinguish a rename from unrelated activity updates", async () => {
  const { useGatewayThreadActivityStore } =
    await import("../../app/stores/gateway-thread-activity/index.ts");
  setActivePinia(createPinia());
  const activity = useGatewayThreadActivityStore();
  activity.upsertGatewayThread(thread("a"), []);
  const before = activity.summariesByKey;
  activity.upsertGatewayThread(thread("b"), []);
  assert.equal(activity.summariesByKey["1:a"], before["1:a"]);
  activity.updateTitle(1, "a", "renamed");
  assert.notEqual(activity.summariesByKey["1:a"], before["1:a"]);
});
void test("actual runtime revision counters detect running/completed/running ABA, including same-status observations", async () => {
  const { useGatewayThreadRuntimeStore } =
    await import("../../app/stores/gateway-thread-runtime/index.ts");
  setActivePinia(createPinia());
  const runtime = useGatewayThreadRuntimeStore();
  runtime.setThreadStatus(1, "a", "running", { turnId: "turn" });
  const before = runtime.threadStatusRevisions;
  const previousVersion = before["1:a"];
  assert(previousVersion !== undefined);
  runtime.setThreadStatus(1, "a", "completed");
  runtime.setThreadStatus(1, "a", "running", { turnId: "another-turn" });
  assert.equal(runtime.statusFor(1, "a"), "running");
  assert.equal(runtime.threadStatusRevisions["1:a"], previousVersion + 2);
  runtime.setThreadStatus(1, "a", "running");
  assert.equal(runtime.threadStatusRevisions["1:a"], previousVersion + 3);
});
