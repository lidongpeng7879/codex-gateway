import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { execRemoteSsh } from "./helpers/remote-codex";
import { sendRealtimeRequest } from "./helpers/realtime";
import {
  activeRealtimeSocketCount,
  installRealtimeSocketProbe,
} from "./helpers/realtime-socket-probe";

test("streams real Linux Host metrics through the shared realtime connection", async ({
  page,
  remoteWorkspace,
}) => {
  await installRealtimeSocketProbe(page);
  await openApp(page);
  const hostName = `metrics-host-${Date.now()}`;
  const { project } = await remoteWorkspace.provision({
    hostName,
    projectName: "Metrics project",
  });

  await expect(page.getByTestId(`project-button-${project.remotePath}`)).toBeVisible();
  await page.getByTestId("open-host-monitor-button").click();
  const panel = page.getByTestId("host-metrics-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("host-metric-cpu")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("host-metric-memory")).toBeVisible();
  await expect(panel.getByTestId("host-metric-network")).toBeVisible();
  await expect(panel.getByTestId("host-metric-disk")).toBeVisible();
  await expect(panel.getByText("实时采集中")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "GPU", exact: true })).toBeVisible();
  await expect(panel.getByTestId("host-metric-gpu-0")).toContainText("E2E Training GPU");
  const gpuProcesses = panel.getByTestId("host-gpu-processes");
  await expect(gpuProcesses).toBeVisible();
  await expect(gpuProcesses.getByText("trainer", { exact: true }).first()).toBeVisible();
  await expect(gpuProcesses.getByText("/usr/local/bin/e2e-gpu-training").first()).toBeVisible();
  await expect(gpuProcesses.getByText("6.0 GiB").first()).toBeVisible();
  await expect.poll(() => activeRealtimeSocketCount(page)).toBe(1);

  const monitorTab = page.getByRole("tab", { name: "主机监控" });
  await monitorTab.getByLabel(/关闭标签页|Close tab/).click();
  await expect(panel).toBeHidden();
  await page.getByTestId("open-host-monitor-button").click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: hostName })).toBeVisible();
  await expect(panel.getByTestId("host-metric-cpu")).toBeVisible();
});

test("polls Host metrics only while at least one browser subscribes", async ({
  page,
  context,
  remoteWorkspace,
}) => {
  await openApp(page, { interceptRealtime: false });
  const remote = remoteWorkspace.remote;
  await execRemoteSsh(remote, ": > /tmp/codex-e2e-host-metrics-samples");
  const { host } = await remoteWorkspace.provision({ hostName: `on-demand-${Date.now()}` });
  const sampleCount = async () => {
    const { stdout } = await execRemoteSsh(remote, "wc -l < /tmp/codex-e2e-host-metrics-samples");
    return Number(stdout.trim());
  };
  const subscribe = async (target: typeof page) =>
    await sendRealtimeRequest(target, {
      type: "host.metrics.subscribe",
      hostId: host.id,
      requestId: "metrics-subscribe",
    });
  const unsubscribe = async (target: typeof page) =>
    await target.evaluate((hostId) => {
      const realtime = window.__codexGatewayE2e?.realtime;
      if (!realtime) throw new Error("Gateway E2E driver is unavailable");
      realtime.send({ type: "host.metrics.unsubscribe", hostId });
    }, host.id);
  const expectStopped = async () => {
    // Observe more than two normal sampling intervals, allowing one in-flight SSH command.
    await expect
      .poll(
        async () => {
          const before = await sampleCount();
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return (await sampleCount()) - before;
        },
        { timeout: 20_000 },
      )
      .toBe(0);
  };

  // SSH and project discovery are ready, but no metrics panel or subscription exists.
  expect(await sampleCount()).toBe(0);
  await expectStopped();
  await subscribe(page);
  await expect.poll(sampleCount).toBeGreaterThan(0);

  const otherPage = await context.newPage();
  try {
    await openApp(otherPage, { resetConfig: false, interceptRealtime: false });
    await subscribe(otherPage);
    await unsubscribe(page);
    const before = await sampleCount();
    await expect.poll(sampleCount).toBeGreaterThan(before);
  } finally {
    // A closed browser releases its real WebSocket subscription too.
    await otherPage.close();
  }
  await expectStopped();
  const stoppedCount = await sampleCount();
  const snapshot = await subscribe(page);
  expect(snapshot.type).toBe("host.metrics.snapshot");
  if (snapshot.type !== "host.metrics.snapshot") throw new Error("Missing metrics snapshot");
  expect(snapshot.samples.length).toBeGreaterThan(0);
  await expect.poll(sampleCount).toBeGreaterThan(stoppedCount);
  await unsubscribe(page);
  await expectStopped();
});
