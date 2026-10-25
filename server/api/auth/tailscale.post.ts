import { createError, setResponseHeader } from "h3";
import { tailscaleAccountForEvent } from "../../utils/gateway/auth/tailscale";
import { optionalAuthenticatedUser, tokenFromEvent } from "../../utils/gateway/auth/context";
import { userStore } from "../../utils/gateway/auth/users";

export default defineEventHandler((event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  setResponseHeader(event, "Vary", "Origin, Tailscale-User-Login, Authorization");
  const username = tailscaleAccountForEvent(event);
  const target = userStore.findByUsername(username);
  if (target?.isActive !== true) {
    throw createError({ statusCode: 403, data: { authMode: "tailscale" } });
  }
  const existing = optionalAuthenticatedUser(event);
  if (existing?.id === target.id) {
    return { token: tokenFromEvent(event), user: existing, authMode: "tailscale" };
  }
  const session = userStore.loginTrustedUser(username);
  if (!session) throw createError({ statusCode: 403, data: { authMode: "tailscale" } });
  return { ...session, authMode: "tailscale" };
});
