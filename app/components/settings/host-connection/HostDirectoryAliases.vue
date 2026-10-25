<script setup lang="ts">
import { Button } from "@codex-gateway/ui/button";
import { Input } from "@codex-gateway/ui/input";
import type { DirectoryAlias } from "~~/shared/types";
const model = defineModel<DirectoryAlias[]>({ required: true });
const { t } = useI18n();
</script>

<template>
  <details class="rounded-lg border border-line p-3" data-testid="host-directory-aliases">
    <summary class="cursor-pointer text-sm font-medium">{{ t("app.directoryAliases") }}</summary>
    <p class="mt-2 text-sm text-ink-muted">{{ t("app.directoryAliasesHelp") }}</p>
    <div v-for="(alias, index) in model" :key="index" class="mt-3 flex min-w-0 flex-col gap-2">
      <Input
        v-model="alias.originalPath"
        :aria-label="t('app.originalDirectory')"
        :placeholder="t('app.originalDirectory')"
      />
      <Input
        v-model="alias.workspacePath"
        :aria-label="t('app.workspaceDirectory')"
        :placeholder="t('app.workspaceDirectory')"
      />
      <Button variant="ghost" size="sm" class="self-end" @click="model.splice(index, 1)">{{
        t("app.removeDirectoryAlias")
      }}</Button>
    </div>
    <Button
      variant="outline"
      size="sm"
      class="mt-3"
      @click="model.push({ originalPath: '', workspacePath: '' })"
      >{{ t("app.addDirectoryAlias") }}</Button
    >
  </details>
</template>
