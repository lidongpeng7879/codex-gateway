import { ref, toValue, type MaybeRefOrGetter } from "vue";
import { toast } from "@codex-gateway/ui/sonner";
import ensureError from "ensure-error";
import type { WorkspaceUploadResult } from "~~/shared/types";
import { gatewayApi } from "@/utils/gateway-api";
import { captureSessionEpoch } from "@/utils/session-epoch";
import { useGatewayFileWorkspaceStore } from "@/stores/file-workspace";

export function useWorkspaceFileUpload(options: {
  hostId: MaybeRefOrGetter<number>;
  threadId: MaybeRefOrGetter<string>;
  rootPath: MaybeRefOrGetter<string>;
}) {
  const { t } = useI18n();
  const workspace = useGatewayFileWorkspaceStore();
  const input = ref<HTMLInputElement>();
  const uploading = ref(false);
  const destination = ref("");
  const results = ref<Array<{ name: string; error: string | null }>>([]);
  let pickerDestination = "";

  function openPicker(path: string) {
    if (uploading.value) return;
    pickerDestination = path;
    input.value?.click();
  }

  function picked(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    void upload(Array.from(target.files ?? []), pickerDestination);
    target.value = "";
  }

  async function upload(files: File[], path: string) {
    if (uploading.value || files.length === 0 || path === "") return;
    if (files.some((file) => Boolean(file.webkitRelativePath))) {
      toast.error(t("app.uploadFilesOnly"));
      return;
    }
    const hostId = toValue(options.hostId);
    const threadId = toValue(options.threadId);
    const rootPath = toValue(options.rootPath);
    const sessionIsCurrent = captureSessionEpoch();
    const isCurrent = () =>
      sessionIsCurrent() &&
      hostId === toValue(options.hostId) &&
      threadId === toValue(options.threadId) &&
      rootPath === toValue(options.rootPath);
    uploading.value = true;
    destination.value = path;
    results.value = [];
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file, file.name);
      const result = await gatewayApi<WorkspaceUploadResult>("/api/remote/uploads", {
        method: "POST",
        query: { hostId, rootPath, path },
        body: form,
      });
      if (!isCurrent()) return;
      results.value = result.files.map((file) => ({
        name: file.name,
        error: "error" in file ? t(`app.${file.error}`) : null,
      }));
      workspace.markRemoteFilesChanged(
        hostId,
        threadId,
        result.files
          .filter((file) => !("error" in file))
          .map((file) => `${path.replace(/\/$/, "")}/${file.name}`),
      );
      const scope = workspace.scopeFor(hostId, threadId);
      if (scope && result.files.some((file) => !("error" in file))) {
        await workspace.setExpandedPaths(hostId, threadId, [
          ...new Set([...scope.expandedPaths, path]),
        ]);
      }
      await workspace.loadDirectory(hostId, threadId, path, true);
    } catch (error) {
      if (isCurrent())
        toast.error(t("app.remoteFileUploadFailed"), { description: ensureError(error).message });
    } finally {
      uploading.value = false;
    }
  }

  return { input, uploading, destination, results, openPicker, picked, upload };
}
