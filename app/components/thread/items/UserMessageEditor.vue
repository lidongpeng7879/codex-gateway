<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { Button } from "@codex-gateway/ui/button";
import { Textarea } from "@codex-gateway/ui/textarea";
import { useGatewayThreadEditStore, type MessageEditSession } from "@/stores/gateway-thread-edit";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
const props = defineProps<{ session: MessageEditSession }>();
const emit = defineEmits<{ cancel: [] }>();
const { t } = useI18n();
const edits = useGatewayThreadEditStore();
const textarea = ref<InstanceType<typeof Textarea> | null>(null);
watch(
  () => props.session.loading,
  async (loading) => {
    if (!loading) {
      await nextTick();
      (textarea.value?.$el as HTMLTextAreaElement | undefined)?.focus();
    }
  },
  { immediate: true },
);
function keydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape" && !props.session.pending) {
    event.preventDefault();
    emit("cancel");
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void edits.submit(props.session);
  }
}
</script>
<template>
  <div
    data-testid="user-message-editor"
    class="min-w-0 space-y-3"
    :aria-busy="session.loading || session.pending"
    @keydown="keydown"
  >
    <p class="text-sm font-medium">{{ t("app.editMessageTitle") }}</p>
    <p class="text-sm leading-6 text-ink-muted">{{ t("app.editMessageHelp") }}</p>
    <p
      data-testid="edit-context-warning"
      class="text-sm leading-6 text-amber-700 dark:text-amber-400"
    >
      {{ t("app.editContextWarning") }}
    </p>
    <p v-if="session.loading" role="status" class="text-sm">{{ t("app.loadingGateway") }}</p>
    <template v-else>
      <Textarea
        ref="textarea"
        v-model="session.text"
        data-testid="user-message-edit-input"
        :aria-label="t('app.editMessageTitle')"
        :disabled="session.pending"
        :readonly="session.branchId !== null || session.blocked"
        class="min-h-32 w-full resize-y text-base"
      />
      <ul
        v-if="session.attachments.length"
        :aria-label="t('app.editAttachmentsPreserved')"
        class="flex min-w-0 flex-wrap gap-2 text-sm text-ink-muted"
      >
        <li
          v-for="(attachment, index) in session.attachments"
          :key="index"
          class="max-w-full break-all rounded-lg bg-canvas px-2 py-1"
        >
          {{ attachment }}
        </li>
      </ul>
      <p class="text-xs text-ink-muted">{{ t("app.editMessageShortcut") }}</p>
      <p v-if="session.blocked" role="status" class="text-sm text-ink-muted">
        {{ t("app.editForkUncertain") }}
      </p>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Button
          v-if="session.branchId"
          variant="outline"
          size="sm"
          data-testid="open-revision-branch"
          :disabled="session.pending"
          @click="
            useGatewayThreadViewStore().openThread(session.branchId!, {
              hostId: session.hostId,
              replaceRoute: false,
            })
          "
          >{{ t("app.openRevisionBranch") }}</Button
        >
        <Button variant="ghost" size="sm" :disabled="session.pending" @click="emit('cancel')">{{
          t("app.cancel")
        }}</Button>
        <Button
          size="sm"
          class="h-auto min-h-9 whitespace-normal"
          data-testid="save-message-edit"
          :disabled="
            session.pending ||
            session.blocked ||
            session.sent ||
            (!session.text.trim() && !session.attachments.length)
          "
          @click="edits.submit(session)"
        >
          {{
            session.pending
              ? t("app.editMessageSending")
              : session.branchId
                ? t("app.retryRevisionSend")
                : t("app.saveMessageOnBranch")
          }}
        </Button>
      </div>
    </template>
  </div>
</template>
