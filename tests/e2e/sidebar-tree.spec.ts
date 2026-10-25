import { expect, test } from "./fixtures/remote-workspace";
import { openApp } from "./helpers/app";
import { installRealtimeThreadSnapshotMock, seedGatewayThread } from "./helpers/gateway-store";
import { defaultGatewayHost, defaultGatewayProject } from "./fixtures/thread-history";
import { prepareManagedDaemon } from "./helpers/host-daemon";
import { AGENT_OUTPUT_TIMEOUT_MS } from "./helpers/timeouts";

test("restores the collapsed desktop sidebar and toggles its project tree", async ({
  page,
  remoteWorkspace,
}) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
  await openApp(page);

  const sidebarGap = page.locator('[data-slot="sidebar-gap"]');
  await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toBeVisible();
  await page.getByTestId("desktop-sidebar-collapse").click();
  await expect.poll(() => sidebarGap.evaluate((element) => element.clientWidth)).toBe(0);
  await expect(page.getByTestId("desktop-sidebar-expand")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("desktop-sidebar-expand")).toBeVisible();
  await expect.poll(() => sidebarGap.evaluate((element) => element.clientWidth)).toBe(0);

  await page.getByTestId("desktop-sidebar-expand").click();
  await expect.poll(() => sidebarGap.evaluate((element) => element.clientWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId("desktop-sidebar-collapse")).toBeVisible();
  // Continue in the restored sidebar: tree expansion does not need another login/setup cycle.
  const { project } = await remoteWorkspace.provision({ hostName: `toggle-${Date.now()}` });
  const threadId = await remoteWorkspace.startThread(project.remotePath);

  await expect(page.getByTestId("desktop-layout")).toBeVisible();
  const projectButton = page.getByTestId(`project-button-${project.remotePath}`);
  const threadButton = page.getByTestId(`thread-button-${threadId}`);
  await expect(projectButton).toBeVisible();
  await projectButton.click();
  await expect(threadButton).toBeVisible();

  await projectButton.click();
  await expect(threadButton).toBeHidden();
  await projectButton.click();
  await expect(threadButton).toBeVisible();
});

test("marks completed threads as needing review until they are opened", async ({ page }) => {
  await openApp(page);
  await seedGatewayThread(page, {
    hostId: 102,
    cwd: "/workspace/review",
    threadId: "selected-thread",
    host: { ...defaultGatewayHost(102), name: "Review Host" },
    project: {
      ...defaultGatewayProject(102, "/workspace/review"),
      name: "Review Project",
      remotePath: "/workspace/review",
    },
    currentThread: { id: "selected-thread", name: "Selected Thread" },
    threads: [
      {
        id: "review-thread",
        name: "Review Thread",
        pinned: false,
        updatedAt: Math.floor(Date.now() / 1000),
      },
      {
        id: "selected-thread",
        name: "Selected Thread",
        pinned: false,
        updatedAt: Math.floor(Date.now() / 1000),
      },
    ],
    status: "completed",
  });
  await installRealtimeThreadSnapshotMock(page, {
    hostId: 102,
    snapshots: {
      "review-thread": {
        thread: { id: "review-thread", name: "Review Thread" },
        history: { thread: { id: "review-thread", turns: [] } },
        cwd: "/workspace/review",
        runtimeStatus: "completed",
      },
    },
  });
  await page.evaluate(() => {
    const runtime = window.__codexGatewayE2e?.runtime;
    if (!runtime) throw new Error("Gateway E2E driver is unavailable");
    runtime.setThreadStatus(102, "review-thread", "running");
    runtime.setThreadStatus(102, "review-thread", "completed");
  });

  await expect(page.getByTestId("thread-button-review-thread")).toBeVisible();
  await expect(
    page.getByTestId("thread-button-review-thread").getByLabel("已完成，待查看", { exact: true }),
  ).toBeVisible();

  await page.getByTestId("thread-button-review-thread").click();
  await expect(
    page.getByTestId("thread-button-review-thread").getByLabel("已完成", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("thread-button-review-thread").getByLabel("已完成，待查看", { exact: true }),
  ).toBeHidden();
});

test("keeps non-pinned main threads in recent activity for the page session", async ({ page }) => {
  await openApp(page);
  const host = {
    ...defaultGatewayHost(104),
    name: "Activity Host",
    sshHost: "activity.example.internal",
  };
  const project = {
    ...defaultGatewayProject(104, "/workspace/activity"),
    name: "Activity Project",
    remotePath: "/workspace/activity",
  };
  await page.evaluate(
    ({ host, project }) => {
      const driver = window.__codexGatewayE2e;
      if (!driver) throw new Error("Gateway E2E driver is unavailable");
      const { activity, catalog, config, runtime } = driver;
      catalog.hosts = [host];
      catalog.projects = [project];
      config.gatewayConfig.pinnedThreads = [
        {
          hostId: host.id,
          threadId: "already-pinned",
          title: "Already pinned",
        },
      ];
      activity.ingestMetadata(
        host.id,
        [
          {
            id: "recent-main",
            title: "Recent main thread",
            cwd: project.remotePath,
            parentThreadId: null,
            agentNickname: null,
            agentRole: null,
            name: null,
            preview: null,
            recencyAt: null,
            updatedAt: 3,
          },
          {
            id: "already-pinned",
            title: "Already pinned",
            cwd: null,
            parentThreadId: null,
            agentNickname: null,
            agentRole: null,
            name: null,
            preview: null,
            recencyAt: null,
            updatedAt: 2,
          },
          {
            id: "spawned-child",
            title: "Spawned child",
            parentThreadId: "recent-main",
            cwd: null,
            agentNickname: null,
            agentRole: null,
            name: null,
            preview: null,
            recencyAt: null,
            updatedAt: 1,
          },
          {
            id: "managed-child-before-parent-hydration",
            title: "Inherited parent title",
            agentRole: "explorer",
            agentNickname: "Scout",
            cwd: null,
            parentThreadId: null,
            name: null,
            preview: null,
            recencyAt: null,
            updatedAt: 4,
          },
        ],
        [project],
      );
      runtime.setThreadStatus(host.id, "recent-main", "running");
      runtime.setThreadStatus(host.id, "already-pinned", "running");
      runtime.setThreadStatus(host.id, "spawned-child", "running");
      runtime.setThreadStatus(host.id, "managed-child-before-parent-hydration", "running");
      runtime.setThreadStatus(host.id, "recent-main", "completed");
    },
    { host, project },
  );

  await expect(page.getByText("最近运行", { exact: true })).toBeVisible();
  await expect(page.getByTestId("recent-thread-button-recent-main")).toBeVisible();
  await expect(page.getByTestId("recent-thread-button-already-pinned")).toBeHidden();
  await expect(page.getByTestId("recent-thread-button-spawned-child")).toBeHidden();
  await expect(
    page.getByTestId("recent-thread-button-managed-child-before-parent-hydration"),
  ).toBeHidden();

  const sectionOrder = await page.getByTestId("sidebar-scroll-area").evaluate((root) => {
    const text = root.textContent ?? "";
    return [text.indexOf("已固定"), text.indexOf("最近运行"), text.indexOf("主机")];
  });
  expect(sectionOrder[0]).toBeLessThan(sectionOrder[1]!);
  expect(sectionOrder[1]).toBeLessThan(sectionOrder[2]!);
});

test("sorts pinned threads for display without rewriting persisted pin order", async ({ page }) => {
  await openApp(page);
  const hosts = [
    { ...defaultGatewayHost(302), name: "Zulu Host" },
    { ...defaultGatewayHost(301), name: "Alpha Host" },
  ];
  const pinnedThreads = [
    { hostId: 302, threadId: "z-alpha", title: "Alpha Thread" },
    { hostId: 301, threadId: "a-zulu", title: "Zulu Thread" },
    { hostId: 301, threadId: "a-alpha-b", title: "Alpha Thread" },
    { hostId: 301, threadId: "a-alpha-a", title: "Alpha Thread" },
  ];
  await page.evaluate(
    ({ hosts, pinnedThreads }) => {
      const driver = window.__codexGatewayE2e;
      if (!driver) throw new Error("Gateway E2E driver is unavailable");
      driver.catalog.hosts = hosts;
      driver.config.gatewayConfig.pinnedThreads = pinnedThreads;
    },
    { hosts, pinnedThreads },
  );

  const renderedThreadIds = await page
    .locator('[data-testid^="pinned-thread-button-"]')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-testid")?.replace("pinned-thread-button-", "")),
    );
  expect(renderedThreadIds).toEqual(["a-alpha-a", "a-alpha-b", "a-zulu", "z-alpha"]);

  const storedThreadIds = await page.evaluate(() => {
    const driver = window.__codexGatewayE2e;
    if (!driver) throw new Error("Gateway E2E driver is unavailable");
    return driver.config.gatewayConfig.pinnedThreads.map((thread) => thread.threadId);
  });
  expect(storedThreadIds).toEqual(pinnedThreads.map((thread) => thread.threadId));
});

test("long expanded tree labels truncate without displacing trailing statuses", async ({
  page,
  remoteWorkspace,
}) => {
  await prepareManagedDaemon(remoteWorkspace.remote);
  await openApp(page);
  const { host, project } = await remoteWorkspace.provision({
    hostName: `Long host ${"host-segment-".repeat(12)}`,
    projectName: `Long project ${"project-segment-".repeat(12)}`,
  });
  const hostId = host.id;
  const threadId = await remoteWorkspace.startThread(project.remotePath);
  // Keep the name within the real rename contract while exceeding the sidebar's visible width.
  const longTitle = `Long thread ${"unbroken-segment-".repeat(10)}`;
  await page.getByTestId(`thread-button-${threadId}`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名会话" }).click();
  await page.getByTestId("rename-thread-input").fill(longTitle);
  await page.getByTestId("rename-thread-submit").click();
  await expect(page.getByTestId("rename-thread-dialog")).toBeHidden();

  await expect(page.getByTestId(`thread-button-${threadId}`)).toBeVisible();
  await page.getByTestId(`thread-button-${threadId}`).click();
  await expect(page.getByTestId(`thread-button-${threadId}`)).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.getByTestId(`host-button-${hostId}`).getByLabel("已连接")).toBeVisible();
  await page
    .getByPlaceholder("输入后续修改要求")
    .fill("Run only the shell command sleep 15, then reply SIDEBAR_LAYOUT. Do not modify files.");
  await page.getByTestId("send-turn-button").click();
  await expect(page.getByTestId(`thread-button-${threadId}`).getByLabel("运行中")).toBeVisible();

  const metrics = await page.getByTestId("sidebar-scroll-area").evaluate(
    (root, { hostId, threadId, longTitle }) => {
      const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      const threadButton = root.querySelector<HTMLElement>(
        `[data-testid="thread-button-${CSS.escape(threadId)}"]`,
      );
      const title = threadButton?.querySelector<HTMLElement>(`[title="${CSS.escape(longTitle)}"]`);
      const hostStatus = root.querySelector<HTMLElement>(
        `[data-testid="host-button-${hostId}"] [aria-label="已连接"]`,
      );
      const threadStatus = threadButton?.querySelector<HTMLElement>('[aria-label="运行中"]');
      const statuses = [hostStatus, threadStatus];
      if (!viewport || !title || statuses.some((status) => !status)) {
        throw new Error("Missing sidebar layout nodes");
      }
      const viewportRect = viewport.getBoundingClientRect();
      return {
        overflow: viewport.scrollWidth - viewport.clientWidth,
        titleClipped: title.scrollWidth > title.clientWidth,
        titleOverflow: getComputedStyle(title).textOverflow,
        statusesInside: statuses.every((status) => {
          if (!status) return false;
          const rect = status.getBoundingClientRect();
          return rect.left >= viewportRect.left && rect.right <= viewportRect.right;
        }),
      };
    },
    { hostId, threadId, longTitle },
  );
  expect(metrics).toEqual({
    overflow: 0,
    titleClipped: true,
    titleOverflow: "ellipsis",
    statusesInside: true,
  });
  await expect(page.getByTestId("send-turn-button")).toHaveAttribute("aria-label", "已完成", {
    timeout: AGENT_OUTPUT_TIMEOUT_MS,
  });
});
