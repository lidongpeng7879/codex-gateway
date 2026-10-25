import { createError, getHeader, type H3Event } from "h3";

export function tailscaleLoginEnabled() {
  return [
    process.env.CODEX_GATEWAY_TAILSCALE_LOGIN,
    process.env.CODEX_GATEWAY_TAILSCALE_USER,
    process.env.CODEX_GATEWAY_TAILSCALE_ORIGIN,
  ].some((value) => value !== undefined);
}

function deny(statusCode = 403) {
  return createError({
    statusCode,
    statusMessage: "Tailscale authentication required",
    data: { authMode: "tailscale" },
  });
}

/** Trust only the local Tailscale Serve proxy, never forwarded IP headers.
 * Local OS users/processes are inside this deployment's trusted proxy boundary.
 */
export function tailscaleAccountForEvent(event: H3Event) {
  if (!tailscaleLoginEnabled()) throw createError({ statusCode: 404 });
  const login = process.env.CODEX_GATEWAY_TAILSCALE_LOGIN?.trim() ?? "";
  const username = process.env.CODEX_GATEWAY_TAILSCALE_USER?.trim() ?? "";
  const configuredOrigin = process.env.CODEX_GATEWAY_TAILSCALE_ORIGIN?.trim() ?? "";
  if (login === "" || username === "" || configuredOrigin === "") throw deny(503);
  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    throw deny(503);
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw deny(503);
  const remote = event.node.req.socket.remoteAddress;
  if (remote === undefined || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote))
    throw deny();
  if (
    getHeader(event, "tailscale-user-login") !== login ||
    getHeader(event, "host")?.toLowerCase() !== origin.host.toLowerCase() ||
    getHeader(event, "origin") !== origin.origin ||
    getHeader(event, "sec-fetch-site") === "cross-site" ||
    getHeader(event, "content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    throw deny();
  return username;
}
