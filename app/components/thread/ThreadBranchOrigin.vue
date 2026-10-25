<script setup lang="ts">
import { GitBranchIcon } from "@lucide/vue";
import { Button } from "@codex-gateway/ui/button";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import type { GatewayThread } from "~~/shared/types";
defineProps<{ thread: GatewayThread }>();
const { t } = useI18n();
const views = useGatewayThreadViewStore();
</script>
<template>
  <div
    v-if="thread.forkedFromId"
    data-testid="thread-branch-origin"
    class="flex min-w-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm text-ink-muted"
  >
    <GitBranchIcon class="size-4 shrink-0" />
    <span>{{ t("app.threadBranchOrigin") }}</span>
    <Button
      variant="ghost"
      size="sm"
      data-testid="return-to-original"
      @click="
        views.openThread(thread.forkedFromId!, {
          hostId: thread.hostId,
          cwd: thread.cwd,
          replaceRoute: false,
        })
      "
      >{{ t("app.returnToOriginal") }}</Button
    >
  </div>
</template>
