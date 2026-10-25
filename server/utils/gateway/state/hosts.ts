import type { HostCreateInput, HostRecord, HostUpdateInput } from "~~/shared/types";
import { trimmedOrNull } from "~~/shared/utils/strings";
import { currentGatewayMemoryState, nextId, nowIso, type StoredHostRecord } from "./memory";

function sanitizeHost(host: StoredHostRecord): HostRecord {
  return {
    ...host,
    hasPassword: Boolean(host.password),
  };
}

function normalizeHost(input: HostCreateInput, id = nextId(currentGatewayMemoryState().hosts)) {
  const timestamp = nowIso();
  const existing = currentGatewayMemoryState().hosts.find((host) => host.id === id);
  return {
    id,
    name: input.name.trim(),
    sshHost: input.sshHost.trim(),
    username: trimmedOrNull(input.username),
    port: input.port ?? null,
    authMode: input.authMode,
    privateKeyPath: trimmedOrNull(input.privateKeyPath),
    privateKey: input.privateKey ?? null,
    password: input.password ?? null,
    proxyUrl: trimmedOrNull(input.proxyUrl),
    directoryAliases: structuredClone(input.directoryAliases ?? []),
    hasPassword: Boolean(input.password),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export const hostStore = {
  replaceHosts(hosts: HostRecord[]) {
    currentGatewayMemoryState().hosts = hosts.map((host) => ({
      ...host,
      proxyUrl: trimmedOrNull(host.proxyUrl),
      hasPassword: Boolean(host.password),
    }));
  },

  list(): HostRecord[] {
    return currentGatewayMemoryState()
      .hosts.map(sanitizeHost)
      .sort((left, right) => left.name.localeCompare(right.name));
  },

  listWithSecret(): StoredHostRecord[] {
    return [...currentGatewayMemoryState().hosts];
  },

  get(id: number): HostRecord | null {
    const host = currentGatewayMemoryState().hosts.find((item) => item.id === id);
    return host ? sanitizeHost(host) : null;
  },

  getWithSecret(id: number): StoredHostRecord | null {
    return currentGatewayMemoryState().hosts.find((item) => item.id === id) ?? null;
  },

  create(input: HostCreateInput): HostRecord {
    const host = normalizeHost(input);
    currentGatewayMemoryState().hosts.push(host);
    return sanitizeHost(host);
  },

  update(id: number, input: HostUpdateInput): HostRecord | null {
    const existing = currentGatewayMemoryState().hosts.find((host) => host.id === id);
    if (!existing) {
      return null;
    }
    const host = normalizeHost(input, id);
    currentGatewayMemoryState().hosts = currentGatewayMemoryState().hosts.map((item) =>
      item.id === id ? host : item,
    );
    return sanitizeHost(host);
  },

  delete(id: number) {
    currentGatewayMemoryState().hosts = currentGatewayMemoryState().hosts.filter(
      (host) => host.id !== id,
    );
  },

  hostIds() {
    return new Set(currentGatewayMemoryState().hosts.map((host) => host.id));
  },

  count() {
    return currentGatewayMemoryState().hosts.length;
  },
};
