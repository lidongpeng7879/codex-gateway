import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { execRemoteSsh, type RemoteCodexEnv } from "./remote-codex";
import { shellQuote } from "../../../server/utils/gateway/infra/ssh/shell";

/** Establish the real fixture BEFORE registering any Gateway host for this remote. */
export async function prepareManagedDaemon(
  remote: RemoteCodexEnv,
  state: "running" | "stopped" = "running",
) {
  const version = z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .parse(remote.supportedCodexVersion);
  const result = await execRemoteSsh(
    remote,
    `set -eu
version=${shellQuote(version)}
case "$(uname -m)" in
  aarch64|arm64) target=aarch64-unknown-linux-musl ;;
  x86_64|amd64) target=x86_64-unknown-linux-musl ;;
  *) echo 'Unsupported Linux fixture architecture' >&2; exit 1 ;;
esac
root="\${CODEX_HOME:-$HOME/.codex}/packages/standalone"
release="$root/releases/$version-$target"
mkdir -p "$release" "$HOME/.local/bin"
# Docker's current-codex-runtime stage verified the release archive against SHA-256 metadata.
if [ ! -x "$release/bin/codex" ]; then
  tar -xzf /opt/codex-upgrade-package.tar.gz -C "$release"
fi
test -f "$release/codex-package.json"
test -x "$release/bin/codex"
test ! -e "$root/current" || test -L "$root/current"
ln -sfn "$release" "$root/current"
ln -sfn "$root/current/bin/codex" "$HOME/.local/bin/codex"
"$HOME/.local/bin/codex" app-server daemon start
`,
  );
  const started = z
    .object({
      status: z.enum(["started", "alreadyRunning"]),
      managedCodexVersion: z.literal(version),
      appServerVersion: z.literal(version),
    })
    .parse(JSON.parse(result.stdout));
  if (state === "stopped") {
    const stopped = await execRemoteSsh(
      remote,
      `set -eu
"$HOME/.local/bin/codex" app-server daemon stop
test ! -S "\${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
`,
    );
    z.object({ status: z.literal("stopped") }).parse(JSON.parse(stopped.stdout));
  } else {
    await execRemoteSsh(
      remote,
      'test -S "${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"',
    );
  }
  return started;
}

export async function readDaemonPid(remote: RemoteCodexEnv) {
  // daemon version reports versions, not process identity. Inspect the real managed process
  // on the Linux SSH fixtures without coupling the browser scenario to internal PID-file paths.
  const result = await execRemoteSsh(
    remote,
    `ps -eo pid=,args= | awk '$2 ~ /\\/codex$/ && $3 == "app-server" && index($0, "--managed-daemon") { print $1 }'`,
  );
  return z.coerce.number().int().positive().parse(result.stdout.trim());
}

export async function openHostDaemonRestartDialog(page: Page, hostId: number) {
  await page.getByTestId("settings-toggle").click();
  await page.getByRole("tab", { name: "主机", exact: true }).click();
  // Maintenance is a visible row action, independent of opening the SSH credential editor.
  await expect(page.getByTestId(`host-edit-form-${hostId}`)).toBeHidden();
  await expect(page.getByTestId(`host-management-status-${hostId}`)).toHaveAttribute(
    "data-status",
    "connected",
  );
  const restart = page.getByTestId(`host-daemon-restart-${hostId}`);
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
}

export async function confirmHostDaemonRestart(page: Page, hostName: string) {
  await page.getByTestId("confirm-host-daemon-restart").click();
  await expect(page.getByText(`${hostName} 的 Codex daemon 已重启并重新连接`)).toBeVisible({
    timeout: 120_000,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
}
