import { createHash, randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import type { HostRecord } from "~~/shared/types";
import {
  parseThreadReadResult,
  parseThreadStartResult,
  parseThreadTimelinePage,
  threadItemsReadResponseSchema,
  threadTurnSchema,
  type AppServerTimelinePage,
} from "~~/shared/runtime/app-server";
import { currentGatewayUserId } from "../state/memory";
import { threadMetadataStore } from "../state/thread-metadata";
import { projectStore } from "../state/projects";
import { gatewayThreadFromAppServer } from "../protocol/gateway-thread";
import { CodexRpcError, publicErrorMessage } from "../http/errors";
import type { ControllerRegistry } from "./controller-registry";
import type { ThreadTurnCommandService } from "./turn-commands";
import { hostRuntimeFingerprint } from "./host-runtime-fingerprint";
import { hostStore } from "../state/hosts";
import { CodexRpcNotDispatchedError } from "../infra/rpc/rpc-errors";

export interface EditTarget {
  threadId: string;
  turnId: string;
  itemId: string;
}
const itemsPageSchema = threadItemsReadResponseSchema.extend({
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable(),
});
const turnsPageSchema = z
  .object({
    data: z.array(threadTurnSchema),
    nextCursor: z.string().nullable(),
    backwardsCursor: z.string().nullable(),
  })
  .strict();
// Persisted history includes null for an unset image detail even when stable TS omits it.
const detail = z.enum(["low", "high", "auto", "original"]).nullish();
// Text spans cannot safely survive arbitrary text replacement. Reject, never silently flatten.
const inputSchema = z.array(
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("text"),
        text: z.string(),
        text_elements: z.array(z.never()).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("image"),
        url: z.string().optional(),
        fileId: z.string().optional(),
        detail,
      })
      .strict()
      .refine((p) => Boolean(p.url) !== Boolean(p.fileId)),
    z.object({ type: z.literal("localImage"), path: z.string().min(1), detail }).strict(),
    z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }).strict(),
    z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }).strict(),
  ]),
);
type OriginalInput = z.infer<typeof inputSchema>;
type RevisionResult = Awaited<ReturnType<ThreadTurnCommandService["startTurn"]>>;
interface RevisionBranch {
  source: EditTarget;
  input: OriginalInput;
  inheritedTurnId: string | null;
  fingerprint?: string;
  assertCurrent: () => void;
  pending?: Promise<RevisionResult>;
  text?: string;
}

/** Disposable command capabilities, not a second history or persistent lineage store.
 * Expire after 24h/eviction or Gateway restart. Existing branches remain ordinary upstream
 * conversations; after expiry the user must open the branch and continue there normally.
 */
export class ThreadEditService {
  private readonly generations = new Map<string, number>();

  closeHost(hostId: number) {
    const prefix = `${currentGatewayUserId()}:${hostId}:`;
    this.generations.set(prefix, (this.generations.get(prefix) ?? 0) + 1);
    for (const key of this.branches.keys()) if (key.startsWith(prefix)) this.branches.delete(key);
    for (const key of this.forks.keys()) if (key.startsWith(prefix)) this.forks.delete(key);
  }

  private capture(host: HostRecord) {
    const key = this.key(host, "");
    return () => {
      const current = hostStore.getWithSecret(host.id);
      if (current === null || this.key(current, "") !== key)
        throw new Error("Host configuration changed; reopen the original message to edit");
    };
  }
  private readonly branches = new LRUCache<string, RevisionBranch>({
    max: 1000,
    ttl: 24 * 60 * 60_000,
  });
  private readonly forks = new LRUCache<
    string,
    { target: string; result: ReturnType<ThreadEditService["createFork"]> }
  >({ max: 1000, ttl: 24 * 60 * 60_000 });
  constructor(
    private readonly registry: ControllerRegistry,
    private readonly turns: ThreadTurnCommandService,
  ) {}

  async read(host: HostRecord, target: EditTarget) {
    const assertCurrent = this.capture(host);
    const input = await this.readOriginal(host, target);
    assertCurrent();
    return {
      text: input
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n"),
      attachments: input
        .filter((p) => p.type !== "text")
        .map((p) => ("name" in p ? p.name : "path" in p ? p.path : "image")),
    };
  }

  fork(host: HostRecord, target: EditTarget, editId: string) {
    const key = this.key(host, editId);
    const targetKey = JSON.stringify(target);
    const existing = this.forks.get(key);
    if (existing !== undefined) {
      if (existing.target !== targetKey)
        throw new Error("Edit identity does not match its original message");
      return existing.result;
    }
    // Keep even rejected promises: transport failure is not proof that no fork was created.
    const result = this.createFork(host, target, this.capture(host));
    this.forks.set(key, { target: targetKey, result });
    return result;
  }

  async revise(host: HostRecord, threadId: string, target: EditTarget, text: string) {
    const branch = this.branches.get(this.key(host, threadId));
    if (branch === undefined || JSON.stringify(branch.source) !== JSON.stringify(target)) {
      throw new Error(
        "Revision branch is unavailable or does not match this original message. Open the branch to continue normally.",
      );
    }
    if (branch.pending !== undefined) {
      if (branch.text !== text) throw new Error("This branch already has a revision submission");
      return branch.pending;
    }
    if (text.trim() === "" && !branch.input.some((p) => p.type !== "text"))
      throw new Error("Revision cannot be empty");
    branch.assertCurrent();
    branch.text = text;
    let dispatched = false;
    branch.pending = this.sendRevision(host, threadId, branch, text, () => {
      dispatched = true;
    }).catch((error) => {
      // A failure before request dispatch (including subscription/read/transport failures) is
      // safe to retry. After dispatch only a definite upstream rejection permits another send.
      const retryable =
        !dispatched ||
        error instanceof CodexRpcNotDispatchedError ||
        (error instanceof CodexRpcError && error.rpcMethod === "turn/start");
      if (retryable) branch.pending = undefined;
      throw Object.assign(new Error(publicErrorMessage(error), { cause: error }), {
        code: retryable ? "REVISION_SEND_RETRYABLE" : "REVISION_SEND_UNCERTAIN",
      });
    });
    return branch.pending;
  }

  private async createFork(host: HostRecord, target: EditTarget, assertCurrent: () => void) {
    const input = await this.readOriginal(host, target);
    const inheritedTurnId = await this.predecessorTurnId(host, target);
    const client = await this.registry.getHostClient(host);
    assertCurrent();
    const result = await client.request(
      "thread/fork",
      {
        threadId: target.threadId,
        beforeTurnId: target.turnId,
        excludeTurns: true,
        deferGoalContinuation: true,
      },
      120_000,
      parseThreadStartResult,
    );
    assertCurrent();
    const thread = result.thread;
    if (thread.id === target.threadId || thread.forkedFromId !== target.threadId)
      throw new Error("Unexpected revision branch identity");
    threadMetadataStore.record(host.id, thread);
    projectStore.ensureForPath(host.id, thread.cwd);
    // Fork auto-subscribes. Adopt it under a bounded scoped owner; never leave a bootstrap
    // lease waiting forever for a user who cancels. No creation snapshot with a false null cursor.
    const lease = this.registry.retainSubscription(host, thread.id, "scoped", {
      upstreamAlreadySubscribed: true,
    });
    void lease.ready.finally(() => lease.release()).catch(() => {});
    // Validate the authoritative cutoff inside the send queue. A failed initial subscription or
    // read must not install a permanently rejected baseline promise on an otherwise valid branch.
    this.branches.set(this.key(host, thread.id), {
      source: target,
      input,
      inheritedTurnId,
      assertCurrent,
    });
    return { threadId: thread.id, thread: gatewayThreadFromAppServer(host.id, thread) };
  }

  private async sendRevision(
    host: HostRecord,
    threadId: string,
    branch: RevisionBranch,
    text: string,
    dispatched: () => void,
  ) {
    const revised: Array<Record<string, unknown>> = [];
    let replaced = false;
    for (const part of branch.input) {
      if (part.type !== "text") revised.push(part);
      else if (!replaced) {
        if (text.trim() !== "") revised.push({ type: "text", text, text_elements: [] });
        replaced = true;
      }
    }
    if (!replaced && text.trim() !== "") revised.unshift({ type: "text", text, text_elements: [] });
    // No browser composer settings or defaults: omitted turn/start overrides inherit the fork's
    // effective upstream configuration. The normal command path still owns leases and events.
    return this.turns.startTurn(
      host,
      threadId,
      {
        text,
        clientUserMessageId: `gateway-revision-${randomUUID()}`,
        originalInput: revised,
      },
      {
        dispatched,
        validate: async (client) => {
          branch.assertCurrent();
          const read = await client.request(
            "thread/read",
            { threadId, includeTurns: false },
            120_000,
            parseThreadReadResult,
          );
          if (
            read.thread.forkedFromId !== branch.source.threadId ||
            read.thread.status.type === "active"
          )
            throw new Error("Revision branch has changed or is busy; open it to continue normally");
          const page = await client.request(
            "thread/timeline/list",
            { threadId, limit: 100 },
            120_000,
            parseThreadTimelinePage,
          );
          const latest = [...page.data]
            .sort((a, b) => b.position - a.position)
            .find((entry) => entry.type !== "realtime");
          const identity = fingerprint(page);
          if (
            (latest?.turnId ?? null) !== branch.inheritedTurnId ||
            (branch.fingerprint !== undefined && identity !== branch.fingerprint)
          )
            throw new Error(
              "Revision branch already contains new activity; open it to continue normally",
            );
          branch.assertCurrent();
          branch.fingerprint = identity;
        },
      },
    );
  }

  private async readOriginal(host: HostRecord, target: EditTarget): Promise<OriginalInput> {
    const client = await this.registry.getHostClient(host);
    const source = await client.request(
      "thread/read",
      { threadId: target.threadId, includeTurns: false },
      120_000,
      parseThreadReadResult,
    );
    if (source.thread.status.type === "active")
      throw new Error("Wait for the original conversation to finish before editing");
    if (source.thread.parentThreadId !== null || source.thread.canAcceptDirectInput === false)
      throw new Error("This conversation cannot be edited");
    // Read from the beginning of this exact turn, not from a browser summary. A steer item may
    // share its turn id; only the first persisted user input maps exactly to beforeTurnId.
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: z.infer<typeof itemsPageSchema> = await client
        .request(
          "thread/items/list",
          {
            threadId: target.threadId,
            turnId: target.turnId,
            cursor,
            limit: 100,
            sortDirection: "asc",
          },
          120_000,
          (v) => itemsPageSchema.parse(v),
        )
        .catch((error: unknown) => {
          if (error instanceof CodexRpcError && error.rpcCode === -32601)
            throw new Error(
              "Historical editing requires paginated history; this legacy conversation is not supported by the current app-server",
            );
          throw error;
        });
      for (const entry of page.data) {
        if (entry.turnId !== target.turnId) throw new Error("Unexpected original turn identity");
        if (entry.item.type !== "userMessage") continue;
        if (entry.item.id !== target.itemId)
          throw new Error(
            "Only the first user message in a turn can be edited; steer messages are not supported",
          );
        const parsed = inputSchema.safeParse(entry.item.content);
        if (!parsed.success || parsed.data.length === 0)
          throw new Error("This message contains structured input that cannot safely be edited");
        return parsed.data;
      }
      cursor = page.nextCursor;
      if (cursor !== null && seen.has(cursor)) throw new Error("Invalid original history cursor");
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    throw new Error("Persisted original user message not found");
  }

  private async predecessorTurnId(host: HostRecord, target: EditTarget) {
    const client = await this.registry.getHostClient(host);
    let cursor: string | null = null;
    let previous: string | null = null;
    const seen = new Set<string>();
    do {
      const page: z.infer<typeof turnsPageSchema> = await client.request(
        "thread/turns/list",
        {
          threadId: target.threadId,
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "notLoaded",
        },
        120_000,
        (value) => turnsPageSchema.parse(value),
      );
      for (const turn of page.data) {
        if (turn.id === target.turnId) return previous;
        previous = turn.id;
      }
      cursor = page.nextCursor;
      if (cursor !== null && seen.has(cursor)) throw new Error("Invalid original turn cursor");
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    throw new Error("Original turn boundary not found");
  }

  private key(host: HostRecord, id: string) {
    const userId = currentGatewayUserId();
    if (userId === null) throw new Error("Editing requires an authenticated user scope");
    const prefix = `${userId}:${host.id}:`;
    const identity = createHash("sha256").update(hostRuntimeFingerprint(host)).digest("hex");
    return `${prefix}${this.generations.get(prefix) ?? 0}:${identity}:${id}`;
  }
}
function fingerprint(page: AppServerTimelinePage) {
  // Opaque pagination cursors are not history identity and need not be stable between reads.
  return createHash("sha256").update(JSON.stringify(page.data)).digest("hex");
}
