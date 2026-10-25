<script setup lang="ts">
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, PlusIcon } from "@lucide/vue";
import type { ProjectRecord } from "~~/shared/types";
import { Button } from "@codex-gateway/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@codex-gateway/ui/context-menu";
import { selectedRowClass } from "../sidebar-utils";
import SidebarRowLabel from "../SidebarRowLabel.vue";
import type { LongPressContextMenuHandlers } from "@/composables/interactions/useLongPressContextMenu";

defineProps<{
  project: ProjectRecord;
  expanded: boolean;
  selected: boolean;
  directoryHint?: string | null;
  longPressHandlers?: LongPressContextMenuHandlers;
}>();

const emit = defineEmits<{
  select: [event: MouseEvent];
  startThread: [];
}>();
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <Button
        :data-testid="`project-button-${project.remotePath}`"
        :title="project.remotePath"
        v-bind="longPressHandlers"
        variant="ghost"
        class="h-10 w-full min-w-0 justify-start gap-2 overflow-hidden rounded-lg px-3 text-[0.9375rem] font-normal hover:bg-surface"
        :class="selectedRowClass(selected)"
        @click="emit('select', $event)"
      >
        <ChevronDownIcon v-if="expanded" class="size-3.5 shrink-0 text-ink-muted" />
        <ChevronRightIcon v-else class="size-3.5 shrink-0 text-ink-muted" />
        <FolderIcon class="size-4 shrink-0" />
        <SidebarRowLabel :title="project.name" :subtitle="directoryHint" />
      </Button>
    </ContextMenuTrigger>
    <ContextMenuContent :collision-padding="12" prioritize-position class="w-44">
      <ContextMenuItem @select="emit('startThread')">
        <PlusIcon class="mr-2 size-4" />
        {{ $t("app.newThread") }}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
