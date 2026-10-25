<script setup lang="ts">
import type { GatewayThread } from "~~/shared/types";
defineProps<{ thread: GatewayThread }>();
const { t } = useI18n();
</script>
<template>
  <div
    v-if="thread.workspaceCwd && thread.workspaceCwd !== thread.cwd"
    class="min-w-0 border-b border-line px-4 py-2 text-sm text-ink-muted"
    data-testid="thread-workspace-directory"
  >
    <p class="break-all">{{ t("app.threadWorkspaceDirectory", { path: thread.workspaceCwd }) }}</p>
    <p class="break-all text-xs">{{ t("app.threadOriginalDirectory", { path: thread.cwd }) }}</p>
  </div>
</template>
