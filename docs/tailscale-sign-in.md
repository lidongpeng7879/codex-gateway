# Optional Tailscale sign-in

This deployment mode removes the Gateway username/password prompt without making the API anonymous. Tailscale Serve identifies the visitor; Gateway maps one explicitly configured identity to an existing active Gateway account and issues its normal revocable bearer session. Existing host configuration and conversations stay with that account.

Set these variables only in the private server runtime environment:

```sh
CODEX_GATEWAY_TAILSCALE_LOGIN=your-tailscale-login
CODEX_GATEWAY_TAILSCALE_USER=existing-gateway-account
CODEX_GATEWAY_TAILSCALE_ORIGIN=https://your-node.your-tailnet.ts.net:8443
```

The exact HTTPS origin must match the browser entry. Bind Gateway to loopback, expose it only through Tailscale Serve (not Funnel), and ensure Serve replaces client-supplied identity headers. Gateway accepts the identity header only from its actual loopback socket with the configured Host, Origin and JSON POST. Forwarded IP headers never establish trust. Local OS users/processes belong to this trusted proxy boundary; do not enable this arrangement on a machine whose local users are untrusted.

On first visit, refresh or session expiry the client signs in automatically. Matching valid sessions are reused without extending fixed expiry. HTTP and WebSocket APIs still validate normal bearer tokens; inactive users cannot sign in. Password login is disabled while any of these opt-in variables is configured. Partial/invalid configuration fails closed. Without all opt-in variables, the default username/password flow is unchanged when none are set.

The UI hides password fields and ordinary logout in this mode, because the visitor remains authenticated to Tailscale. Removing the mode variables restores normal Gateway sign-in; do not delete the underlying user or its encrypted configuration. Tailscale sign-in does not install, restart or upgrade remote Codex runtimes.
