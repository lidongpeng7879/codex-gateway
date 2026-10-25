import type { Page } from "@playwright/test";
export interface EditUxFrame {
  hostId: number | null;
  cwd: string | null;
  threadId: string | null;
  rows: string[];
  selected: string[];
  loading: boolean;
  statuses: Record<string, string>;
}
declare global {
  interface Window {
    __editUxFrames?: EditUxFrame[];
    __stopEditUxTrace?: () => void;
  }
}
/** Observe painted state from the real application; never inject thread/store data. */
export async function startEditUxTrace(page: Page) {
  await page.evaluate(() => {
    window.__stopEditUxTrace?.();
    const frames: EditUxFrame[] = [];
    window.__editUxFrames = frames;
    let stopped = false;
    window.__stopEditUxTrace = () => {
      stopped = true;
    };
    function sample() {
      if (stopped) return;
      const driver = window.__codexGatewayE2e!;
      const rows = [
        ...document.querySelectorAll<HTMLElement>('[data-testid^="thread-button-"]'),
      ].filter((row) => row.offsetParent !== null);
      frames.push({
        hostId: driver.navigation.selectedHostId,
        cwd: driver.navigation.selectedCwd,
        threadId: driver.navigation.selectedThreadId,
        rows: rows.map((row) => row.dataset.testid!.replace("thread-button-", "")),
        selected: rows
          .filter((row) => row.dataset.selected === "true")
          .map((row) => row.dataset.testid!.replace("thread-button-", "")),
        loading: driver.views.loading,
        statuses: { ...driver.runtime.threadStatuses },
      });
      if (frames.length > 6000) frames.shift();
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}
export async function paintedFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
export async function stopEditUxTrace(page: Page) {
  return await page.evaluate(() => {
    window.__stopEditUxTrace?.();
    return window.__editUxFrames ?? [];
  });
}
