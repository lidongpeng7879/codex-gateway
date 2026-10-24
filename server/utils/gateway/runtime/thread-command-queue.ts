import { remoteHosts } from "../state/remote-hosts";

// Authenticated aliases of the same physical app-server must serialize command dispatch too.
// This excludes Gateway commands only: upstream has no conditional idle-only turn/start, so
// another external app-server client can still race the final read and dispatch.
const queues = new Map<string, Promise<unknown>>();
export async function withThreadCommandQueue<T>(
  hostId: number,
  threadId: string,
  operation: () => Promise<T>,
) {
  const remoteKey = remoteHosts.key(hostId);
  if (remoteKey === null) throw new Error("Thread command requires an authenticated remote");
  const key = JSON.stringify([remoteKey, threadId]);
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  queues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(key) === pending) queues.delete(key);
  }
}
