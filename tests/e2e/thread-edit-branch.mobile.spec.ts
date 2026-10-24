import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { createEditHistory, openHistory, verifyEditHistory } from "./helpers/thread-edit";

test("mobile historical edit is touch accessible, multiline and cancellable without overflow or draft loss", async ({
  page,
  remoteWorkspace,
}, testInfo) => {
  await openApp(page, { interceptRealtime: false });
  const host = await remoteWorkspace.addHost();
  const history = await createEditHistory(remoteWorkspace.remote, { attachments: true });
  await verifyEditHistory(page, host.id, history);
  await openHistory(page, host.id, history.threadId);
  const draft = page.getByPlaceholder("输入后续修改要求");
  await draft.fill("Mobile original draft");
  const turnId = history.turnIds[1]!;
  const bubble = page.locator(`[data-testid="user-message"][data-turn-id="${turnId}"]`);
  await bubble.scrollIntoViewIfNeeded();
  const edit = bubble.getByTestId("edit-user-message");
  await expect(edit).toBeVisible();
  await edit.tap();
  const input = page.getByTestId("user-message-edit-input");
  await expect(input).toHaveValue(history.texts[1]!);
  await expect(input).toBeFocused();
  await expect(bubble.getByTestId("thread-image-attachment")).toBeVisible();
  await input.fill("Mobile revision");
  await input.press("Enter");
  await expect(input).toHaveValue("Mobile revision\n");
  await input.dispatchEvent("keydown", { key: "Enter", metaKey: true, isComposing: true });
  await expect(page.getByTestId("user-message-editor")).toBeVisible();
  await page.getByTestId("save-message-edit").scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.width);
  const bounds = await page.getByTestId("save-message-edit").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(overflow.width);
  await page
    .getByTestId("user-message-editor")
    .screenshot({ path: testInfo.outputPath("mobile-editor.png") });
  await page.getByRole("button", { name: "取消", exact: true }).tap();
  await expect(page.getByTestId("user-message-editor")).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(draft).toHaveText("Mobile original draft");
  await expect(bubble).toContainText(history.texts[1]!);
  // A wide touch-only tablet has no hover affordance, even above Tailwind's md breakpoint.
  await page.setViewportSize({ width: 900, height: 1100 });
  await bubble.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches)).toBe(
    false,
  );
  await expect(bubble.locator(".user-message-actions")).toHaveCSS("opacity", "1");
});
