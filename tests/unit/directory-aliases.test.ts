import assert from "node:assert/strict";
import { test } from "node:test";
import { reactive } from "vue";
import { hostConnectionFormFromRecord } from "../../app/components/settings/host-connection/form.ts";
import {
  canonicalDirectoryPath,
  directoryPathsForListing,
  threadWorkspaceCwd,
  withThreadWorkspace,
} from "../../shared/directory-aliases.ts";
import { directoryAliasesSchema } from "../../server/utils/gateway/http/validation/directory-aliases.ts";
import { hostCreateSchema } from "../../server/utils/gateway/http/validation/hosts-projects.ts";
import { parseGatewayConfig } from "../../server/utils/gateway/http/validation/config.ts";
import { runWithGatewayUser } from "../../server/utils/gateway/state/memory.ts";
import { hostStore } from "../../server/utils/gateway/state/hosts.ts";
import { projectStore } from "../../server/utils/gateway/state/projects.ts";
import { hostDirectoryListFilter } from "../../server/utils/gateway/state/directory-aliases.ts";

const aliases = [
  { originalPath: "/Users/old/iCloud/thesis", workspacePath: "/Users/current/iCloud/thesis" },
  {
    originalPath: "/Users/current/Documents/thesis",
    workspacePath: "/Users/current/iCloud/thesis",
  },
];

void test("only explicitly configured exact paths are grouped", () => {
  assert.equal(
    canonicalDirectoryPath(aliases[0]!.originalPath, aliases),
    aliases[0]!.workspacePath,
  );
  assert.equal(
    canonicalDirectoryPath("/Users/unrelated/thesis", aliases),
    "/Users/unrelated/thesis",
  );
  assert.equal(
    canonicalDirectoryPath(aliases[0]!.originalPath + "/subproject", aliases),
    aliases[0]!.originalPath + "/subproject",
  );
});

void test("native list filters include the current directory and every explicit original path", () => {
  const expected = [aliases[0]!.workspacePath, aliases[0]!.originalPath, aliases[1]!.originalPath];
  assert.deepEqual(directoryPathsForListing(expected[0]!, aliases), expected);
  assert.deepEqual(directoryPathsForListing(expected[1]!, aliases), expected);
});

void test("workspace projection preserves official cwd and can be removed without data loss", () => {
  const source = { id: "original", cwd: aliases[0]!.originalPath };
  const mapped = withThreadWorkspace(source, aliases);
  assert.equal(mapped.cwd, source.cwd);
  assert.equal(threadWorkspaceCwd(mapped), aliases[0]!.workspacePath);
  assert.deepEqual(withThreadWorkspace(mapped, []), source);
  assert.deepEqual(source, { id: "original", cwd: aliases[0]!.originalPath });
  assert.equal(threadWorkspaceCwd(null), null);
});

void test("alias validation rejects duplicate sources, chains, cycles and relative paths", () => {
  assert.equal(directoryAliasesSchema.safeParse(aliases).success, true);
  for (const invalid of [
    [aliases[0], aliases[0]],
    [
      { originalPath: "/a", workspacePath: "/b" },
      { originalPath: "/b", workspacePath: "/c" },
    ],
    [
      { originalPath: "/a", workspacePath: "/b" },
      { originalPath: "/b", workspacePath: "/a" },
    ],
    [{ originalPath: "/a", workspacePath: "/a" }],
    [{ originalPath: "~/old", workspacePath: "/new" }],
    [{ originalPath: "/old", workspacePath: "/new/../other" }],
  ])
    assert.equal(directoryAliasesSchema.safeParse(invalid).success, false);
});

void test("aliases survive host and config serialization, with empty defaults for unmapped hosts", () => {
  const input = hostCreateSchema.parse({
    name: "Host",
    sshHost: "host",
    authMode: "agent",
    directoryAliases: aliases,
  });
  assert.deepEqual(input.directoryAliases, aliases);
  const config = parseGatewayConfig({ version: 2, hosts: [{ id: 1, ...input }] });
  assert.deepEqual(config.hosts[0]!.directoryAliases, aliases);
  const host = reactive(config.hosts[0]!);
  const form = hostConnectionFormFromRecord(host);
  form.directoryAliases[0]!.originalPath = "/edited-draft";
  assert.deepEqual(host.directoryAliases, aliases);
  assert.deepEqual(
    hostCreateSchema.parse({ name: "Other", sshHost: "other" }).directoryAliases,
    [],
  );
});

void test("server groups remain user and host scoped, with one canonical group and native filters", () => {
  runWithGatewayUser(919001, () => {
    const host = hostStore.create({
      name: "A",
      sshHost: "a",
      authMode: "agent",
      directoryAliases: aliases,
    });
    const other = hostStore.create({ name: "B", sshHost: "b", authMode: "agent" });
    for (const path of [aliases[0]!.workspacePath, ...aliases.map((alias) => alias.originalPath)])
      projectStore.ensureForPath(host.id, path);
    projectStore.ensureForPath(other.id, aliases[0]!.originalPath);
    assert.equal(projectStore.list(host.id).length, 1);
    assert.equal(projectStore.list(host.id)[0]!.remotePath, aliases[0]!.workspacePath);
    assert.equal(projectStore.list(other.id)[0]!.remotePath, aliases[0]!.originalPath);
    assert.deepEqual(
      hostDirectoryListFilter(host.id, aliases[0]!.originalPath),
      directoryPathsForListing(aliases[0]!.workspacePath, aliases),
    );
    assert.equal(
      hostDirectoryListFilter(other.id, aliases[0]!.originalPath),
      aliases[0]!.originalPath,
    );
    assert.equal(hostDirectoryListFilter(host.id, null), undefined);
  });
  runWithGatewayUser(919002, () =>
    assert.equal(hostDirectoryListFilter(1, aliases[0]!.originalPath), aliases[0]!.originalPath),
  );
});
