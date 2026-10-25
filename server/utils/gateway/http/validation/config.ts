import { z } from "zod";
import type { GatewayConfig } from "~~/shared/types";
import { DEFAULT_BARK_GROUP, DEFAULT_BARK_SERVER_URL } from "~~/shared/config";
import { trimmedOrFallback, trimmedOrNull } from "~~/shared/utils/strings";
import { hostBaseSchema, validateHostProxy } from "./hosts-projects";

export const pinnedThreadSchema = z
  .object({
    hostId: z.coerce.number().int().positive(),
    threadId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    subtitle: z.string().trim().nullable().optional(),
    projectName: z.string().trim().nullable().optional(),
    updatedAt: z.coerce.number().nullable().optional(),
  })
  .strict();

export const notificationSettingsSchema = z
  .object({
    webPush: z.object({ enabled: z.boolean() }).strict().default({ enabled: false }),
    bark: z
      .object({
        enabled: z.boolean().default(false),
        serverUrl: z.url().default(DEFAULT_BARK_SERVER_URL),
        deviceKey: z.string().trim().default(""),
        group: z.string().trim().nullable().optional().default(DEFAULT_BARK_GROUP),
      })
      .strict()
      .default({
        enabled: false,
        serverUrl: DEFAULT_BARK_SERVER_URL,
        deviceKey: "",
        group: DEFAULT_BARK_GROUP,
      }),
  })
  .strict();

export const gatewayConfigSchema = z
  .object({
    version: z.literal(2).default(2),
    hosts: z
      .array(
        hostBaseSchema
          .extend({
            id: z.coerce.number().int().positive(),
            hasPassword: z.boolean().optional(),
            createdAt: z.string().optional(),
            updatedAt: z.string().optional(),
          })
          .superRefine(validateHostProxy),
      )
      .default([]),
    pinnedThreads: z.array(pinnedThreadSchema).default([]),
    notifications: notificationSettingsSchema.default({
      webPush: { enabled: false },
      bark: {
        enabled: false,
        serverUrl: DEFAULT_BARK_SERVER_URL,
        deviceKey: "",
        group: DEFAULT_BARK_GROUP,
      },
    }),
  })
  .strict();

export function parseGatewayConfig(body: unknown): GatewayConfig {
  const input = gatewayConfigSchema.parse(body);
  const timestamp = new Date().toISOString();
  return {
    version: 2,
    hosts: input.hosts.map((host) => ({
      id: host.id,
      name: host.name.trim(),
      sshHost: host.sshHost.trim(),
      username: trimmedOrNull(host.username),
      port: host.port ?? null,
      authMode: host.authMode,
      privateKeyPath: trimmedOrNull(host.privateKeyPath),
      privateKey: host.privateKey ?? null,
      password: host.password ?? null,
      proxyUrl: trimmedOrNull(host.proxyUrl),
      directoryAliases: host.directoryAliases,
      hasPassword:
        typeof host.password === "string" ? host.password.length > 0 : (host.hasPassword ?? false),
      createdAt: host.createdAt ?? timestamp,
      updatedAt: host.updatedAt ?? timestamp,
    })),
    pinnedThreads: input.pinnedThreads.map((thread) => ({
      hostId: thread.hostId,
      threadId: thread.threadId.trim(),
      title: thread.title.trim(),
      subtitle: trimmedOrNull(thread.subtitle),
      projectName: trimmedOrNull(thread.projectName),
      updatedAt: thread.updatedAt ?? null,
    })),
    notifications: {
      webPush: input.notifications.webPush,
      bark: {
        enabled: input.notifications.bark.enabled,
        serverUrl: trimmedOrFallback(input.notifications.bark.serverUrl, DEFAULT_BARK_SERVER_URL),
        deviceKey: input.notifications.bark.deviceKey.trim(),
        group: trimmedOrFallback(input.notifications.bark.group, DEFAULT_BARK_GROUP),
      },
    },
  };
}
