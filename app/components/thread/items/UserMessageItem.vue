<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { CopyIcon, PencilIcon } from "@lucide/vue";
import { useClipboard } from "@vueuse/core";
import { Button } from "@codex-gateway/ui/button";
import { toast } from "@codex-gateway/ui/sonner";
import UserMessageEditor from "./UserMessageEditor.vue";
import ThreadRevisionNotice from "../ThreadRevisionNotice.vue";
import { messageEditKey, useGatewayThreadEditStore } from "@/stores/gateway-thread-edit";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { Message, MessageContent } from "@codex-gateway/ai-elements/message";
import MarkdownContent from "@/components/common/MarkdownContent.vue";
import ThreadImageAttachment from "@/components/thread/attachments/ThreadImageAttachment.vue";
import { threadItemText } from "@/utils/thread-items";
import type { ThreadHistoryItem } from "~~/shared/types";
import { recordFromUnknown } from "~~/shared/utils/records";

const props = defineProps<{
  item: ThreadHistoryItem;
  hostId: number | null;
  threadId?: string | null;
  turnId?: string;
  userEditAvailable?: boolean;
}>();
const { t } = useI18n();
const edits = useGatewayThreadEditStore();
const navigation = useGatewayNavigationStore();
const editButton = ref<InstanceType<typeof Button> | null>(null);
const target = computed(() =>
  props.hostId && props.threadId && props.turnId && typeof props.item.id === "string"
    ? {
        hostId: props.hostId,
        threadId: props.threadId,
        turnId: props.turnId,
        itemId: props.item.id,
      }
    : null,
);
const session = computed(() =>
  target.value ? edits.sessions[messageEditKey(target.value)] : undefined,
);
const operation = computed(() =>
  target.value ? edits.operations[messageEditKey(target.value)] : undefined,
);
const editable = computed(
  () =>
    target.value !== null &&
    props.userEditAvailable === true &&
    navigation.selectedHostId === props.hostId &&
    navigation.selectedThreadId === props.threadId &&
    !props.item.optimistic,
);
const { copy } = useClipboard();
async function copyText() {
  try {
    await copy(text.value);
  } catch {
    toast.error(t("app.copyAgentOutputFailed"));
  }
}
async function cancelEdit() {
  if (target.value) edits.cancel(target.value);
  await nextTick();
  (editButton.value?.$el as HTMLElement | undefined)?.focus();
}

const text = computed(() => threadItemText(props.item));
type ImagePart = Record<string, unknown> & { type: "image" | "localImage" };

function isImagePart(part: Record<string, unknown> | null): part is ImagePart {
  return part?.type === "image" || part?.type === "localImage";
}

const imageParts = computed(() => {
  if (!Array.isArray(props.item.content)) {
    return [];
  }
  return props.item.content
    .map(recordFromUnknown)
    .filter(isImagePart)
    .map((part, index: number) => ({
      id: `${props.item.id || props.item.clientId || "image"}-${index}`,
      type: part.type,
      url: typeof part.url === "string" ? part.url : "",
      path: typeof part.path === "string" ? part.path : "",
      detail: typeof part.detail === "string" ? part.detail : null,
    }));
});

function imageSource(image: { type: string; url: string; path: string }) {
  if (image.type === "image") {
    return image.url;
  }
  if (image.type === "localImage" && props.hostId && image.path) {
    const query = new URLSearchParams({
      hostId: String(props.hostId),
      path: image.path,
    });
    return `/api/remote/images?${query.toString()}`;
  }
  return "";
}
</script>

<template>
  <Message
    from="user"
    data-testid="user-message"
    :data-turn-id="turnId"
    :data-item-id="item.id"
    class="min-w-0 max-w-full"
  >
    <MessageContent
      class="thread-user-message min-w-0 max-w-full space-y-3 rounded-2xl bg-canvas-soft px-4 py-4 text-[0.9375rem] leading-7 text-ink group-[.is-user]:rounded-2xl group-[.is-user]:bg-canvas-soft group-[.is-user]:py-4 group-[.is-user]:text-ink md:max-w-3xl md:px-5 md:group-[.is-user]:px-5"
    >
      <div v-if="imageParts.length" class="grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        <template v-for="image in imageParts" :key="image.id">
          <ThreadImageAttachment
            v-if="imageSource(image)"
            :source="imageSource(image)"
            :label="image.path || null"
            :detail="image.detail"
          />
        </template>
      </div>
      <UserMessageEditor v-if="session" :session="session" @cancel="cancelEdit" />
      <MarkdownContent v-else-if="text" :content="text" compact />
      <ThreadRevisionNotice v-if="operation" :operation="operation" source />
      <div
        v-if="!session"
        class="user-message-actions flex items-center justify-end gap-1 opacity-100 transition-opacity"
      >
        <Button
          variant="ghost"
          size="icon"
          :aria-label="t('app.copyUserMessage')"
          :title="t('app.copyUserMessage')"
          @click="copyText"
          ><CopyIcon class="size-4"
        /></Button>
        <Button
          v-if="editable"
          ref="editButton"
          variant="ghost"
          size="icon"
          data-testid="edit-user-message"
          :aria-label="t('app.editMessageTitle')"
          :title="t('app.editMessageTitle')"
          :disabled="operation?.pending"
          @click="target && edits.begin(target)"
          ><PencilIcon class="size-4"
        /></Button>
        <span v-else-if="threadId && !userEditAvailable" class="sr-only">{{
          t("app.editPrimaryOnly")
        }}</span>
      </div>
    </MessageContent>
  </Message>
</template>

<style scoped>
@media (hover: hover) and (pointer: fine) {
  .user-message-actions {
    opacity: 0;
  }
  .group:hover .user-message-actions,
  .group:focus-within .user-message-actions {
    opacity: 1;
  }
}
.thread-user-message :deep(.markdown-content),
.thread-user-message :deep(.markdown-content p),
.thread-user-message :deep(.markdown-content li),
.thread-user-message :deep(.markdown-content code),
.thread-user-message :deep(.markdown-content a) {
  overflow-wrap: anywhere;
}
</style>
