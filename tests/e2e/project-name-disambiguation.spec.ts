import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { createEditHistory, openHistory, verifyEditHistory } from "./helpers/thread-edit";

import { prepareManagedDaemon } from "./helpers/host-daemon";

// Focused experience runs provision the verified official fixture independently of upgrade tests.
test.beforeEach(async ({ remoteWorkspace }) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
});

test("same-name real directory histories show distinct paths and open the matching original thread", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const root = `/home/codex/directories-${randomUUID()}`;
  const histories = [];
  for (const parent of ["current", "old-user", "old-location"]) {
    const history = await createEditHistory(remoteWorkspace.remote, {
      cwd: `${root}/${parent}/0-Thesis-SCUT`,
    });
    await verifyEditHistory(page, host.id, history);
    histories.push(history);
  }
  await page.evaluate(
    (hostId) => window.__codexGatewayE2e!.navigation.refreshHostProjects(hostId),
    host.id,
  );
  await openHistory(page, host.id, histories[0]!.threadId);
  for (const history of histories) {
    const row = page.getByTestId(`project-button-${history.cwd}`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("0-Thesis-SCUT");
    await expect(row).toContainText(history.cwd.split("/").at(-2)!);
    await expect(row).toHaveAttribute("title", history.cwd);
    await row.click();
    await expect(page).toHaveURL((url) => url.searchParams.get("cwd") === history.cwd);
    await expect(page.getByTestId(`thread-button-${history.threadId}`)).toBeVisible();
    await page.getByTestId(`thread-button-${history.threadId}`).click();
    await expect(page).toHaveURL(new RegExp(`threadId=${history.threadId}`));
    await expect(page.getByTestId("chat-scroll-area")).toContainText(history.texts[1]!);
  }
  await page.screenshot({ path: testInfo.outputPath("distinct-directory-paths.png") });
});
