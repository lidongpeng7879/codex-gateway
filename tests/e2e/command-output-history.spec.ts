import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { AGENT_OUTPUT_TIMEOUT_MS } from "./helpers/timeouts";
import { prepareManagedDaemon } from "./helpers/host-daemon";

test("browses earlier persisted command output", async ({ page, remoteWorkspace }) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
  await openApp(page, { interceptRealtime: false });
  const { project } = await remoteWorkspace.provision();
  await remoteWorkspace.startThread(project.remotePath);

  // Generate more than the browser's retained tail through Codex's real command tool. Codex caps
  // persisted output itself, so the detail read may replace the tail with a smaller head/tail
  // summary. Assert the visible content, not that local window controls must remain afterwards.
  await page
    .getByPlaceholder("输入后续修改要求")
    .fill(
      "Run exactly the following shell command ONCE, without any change, redirection, pipe, or truncation. Its stdout must be returned by the command tool because this is a browser output-history regression. Set max_output_tokens to 100000. After the command finishes, only reply 输出完成.\n\nawk 'BEGIN { for (i=1; i<=6000; i++) printf \"output-%05d abcdefghijklmnopqrstuvwxyz\\n\", i }'",
    );
  await page.getByTestId("send-turn-button").click();
  const timeline = page.getByTestId("chat-scroll-area");
  const command = timeline.getByRole("button", { name: /awk.*6000/ }).first();
  await expect(command).toBeVisible({ timeout: AGENT_OUTPUT_TIMEOUT_MS });
  await expect(page.getByTestId("send-turn-button")).toHaveAttribute("aria-label", "已完成", {
    timeout: AGENT_OUTPUT_TIMEOUT_MS,
  });

  const intermediate = timeline.getByRole("button", { name: /中间过程/ }).first();
  // Completion keeps the disclosure open when the viewer is detached from the latest output.
  // Select an explicit open state instead of toggling an assumed auto-collapsed state closed.
  if ((await intermediate.getAttribute("aria-expanded")) === "true") {
    await intermediate.click();
    await expect(intermediate).toHaveAttribute("aria-expanded", "false");
  }
  await intermediate.click();
  await expect(intermediate).toHaveAttribute("aria-expanded", "true");
  await command.click();
  const earlier = page.getByTestId("load-earlier-command-output");
  await expect(earlier).toBeVisible();
  await earlier.click();
  await expect(page.getByText(/output-00001 abcdefghijklmnopqrstuvwxyz/)).toBeVisible();

  await expect(page.getByText(/output-06000 abcdefghijklmnopqrstuvwxyz/)).toBeVisible();
});
