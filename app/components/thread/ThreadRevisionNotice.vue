<script setup lang="ts">
import { computed } from "vue";
import { Button } from "@codex-gateway/ui/button";
import { useGatewayThreadEditStore, type MessageEditSession } from "@/stores/gateway-thread-edit";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
const props = defineProps<{ operation?: MessageEditSession; source?: boolean }>();
const { t } = useI18n();
const edits = useGatewayThreadEditStore();
const navigation = useGatewayNavigationStore();
const views = useGatewayThreadViewStore();
const operation = computed(
  () =>
    props.operation ??
    Object.values(edits.operations).find(
      (entry) =>
        entry.hostId === navigation.selectedHostId &&
        entry.branchId === navigation.selectedThreadId,
    ),
);
const visible = computed(
  () =>
    operation.value?.branchId &&
    (props.source || operation.value.pending || operation.value.failure),
);
const label = computed(() =>
  operation.value?.pending
    ? "app.revisionBranchSending"
    : operation.value?.sent
      ? "app.revisionBranchSent"
      : operation.value?.failure === "retryable"
        ? "app.revisionBranchRetryable"
        : operation.value?.failure === "checkable"
          ? "app.revisionBranchCheckable"
          : "app.revisionBranchUncertain",
);
</script>
<template>
  <div
    v-if="visible && operation"
    data-testid="thread-revision-status"
    :data-state="operation.pending ? 'pending' : operation.sent ? 'sent' : operation.failure"
    role="status"
    class="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm text-ink-muted"
  >
    <span>{{ t(label) }}</span>
    <Button
      v-if="source || operation.failure !== null"
      variant="ghost"
      size="sm"
      data-testid="open-revision-branch"
      @click="
        views.openThread(operation.branchId!, {
          hostId: operation.hostId,
          cwd: operation.cwd,
          replaceRoute: false,
        })
      "
    >
      {{ t("app.openRevisionBranch") }}
    </Button>
    <Button
      v-if="operation.failure === 'retryable'"
      variant="outline"
      size="sm"
      data-testid="retry-revision-send"
      :disabled="operation.pending"
      @click="edits.submit(operation)"
    >
      {{ t("app.retryRevisionSend") }}
    </Button>
    <Button
      v-if="operation.failure === 'checkable'"
      variant="outline"
      size="sm"
      data-testid="check-revision-status"
      :disabled="operation.pending"
      @click="edits.submit(operation)"
    >
      {{ t("app.checkRevisionStatus") }}
    </Button>
  </div>
</template>
