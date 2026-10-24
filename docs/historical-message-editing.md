# Edit a historical message on a new conversation branch

## Workflow

1. Open a conversation and use **Edit message** on a persisted user message. Actions appear on hover or keyboard focus on mouse devices and remain visible on touch devices.
2. Edit the text in place. Existing readable images and structured references remain attached. The normal bottom-composer draft is independent.
3. Use **Save and send on new branch**, or **Ctrl/Cmd+Enter**. Enter inserts a newline; Escape or Cancel leaves the original unchanged. IME composition never submits.
4. Gateway forks immediately **before that turn** using the official app-server API, then sends the replacement input to the new thread. It does not rewrite the original conversation.
5. Use **Return to original**, browser Back/Forward, or either thread's URL to navigate. The branch-origin banner survives reload because it comes from official `forkedFromId` metadata.

**Conversation branches are not Git branches or separate worktrees.** They share the project's current working directory. Forking does not undo or restore files, and a later agent turn can modify those same files normally. The editor states this before sending.

## Supported input and limitations

- The boundary is an official persisted turn ID, including first-turn and older paginated-history boundaries. Editing only the first user message of a turn is supported; a later steer message within the same turn cannot be independently cut by this API.
- Text, readable image/local-image parts, and supported explicit mention/skill parts are retained. Nonempty text spans and unsupported input kinds such as audio are rejected rather than silently flattened.
- Uploaded non-image references already represented in the historical text remain part of that editable text; Gateway does not append a second reference suffix.
- **Prior application context and `@file` additional context cannot be reconstructed from the official historical user-message API.** The editor warns about this explicitly. Reattach required context when continuing the branch; do not assume it was copied with the visible message.
- Wait for a running original conversation to finish before editing. Gateway does not interrupt the original or force-release another client's writer lock.
- The pinned Codex 0.164.0 APIs reject item/timeline reads for unconverted legacy history. Such history is not silently converted or falsely advertised as editable.
- English and Chinese labels are included. Desktop, phone and wide touch-only actions are covered by the real integration tests.

## Failure behavior

Fork creation and revised sending are separate operations. The new branch identity is retained before sending. An explicit retry after a send failure uses that same branch, not a second fork. Duplicate accepted sends and ambiguous post-dispatch failures are guarded server-side; an uncertain fork is not automatically retried.

Revision capabilities are bounded, user/host-scoped in-memory state with a 24-hour TTL. Host changes invalidate them. After a Gateway restart or capability expiry, the branch still exists in Codex and can be opened and continued normally, but the special historical-revision retry may no longer be available. Gateway reports this instead of silently forking again.

Ordinary and revised Gateway submissions to an equivalent SSH identity/thread are serialized and revalidated immediately before dispatch. Codex has no atomic idle-only `turn/start` primitive, so this cannot exclude an unrelated external client racing a submission to the same app-server.

## Validation

The feature has 15 real-container integration cases covering canonical first/middle/older boundaries, unchanged source/workspace, structured input, independent drafts/uploads, keyboard/IME, virtualization, mobile/tablet actions, authenticated host/account boundaries, host invalidation, concurrent aliases, pre-dispatch retry, lost acknowledgements, navigation/logout, actual model sending, Back/Forward and reload. Tests use real SSH and official app-server; they do not mock fork results or inject browser history state.

Run the focused tests through the normal harness:

```sh
pnpm test:e2e -- thread-edit-branch
```

For native ARM64 Docker on Apple Silicon:

```sh
export DOCKER_DEFAULT_PLATFORM=linux/arm64
export E2E_CODEX_RELEASE_TARGET=aarch64-unknown-linux-musl
pnpm test:e2e -- thread-edit-branch
```

Use isolated test credentials via `E2E_CODEX_HOME` as described in the main testing setup. When changing Docker architecture, use matching-platform images and a fresh test runner-home volume; pnpm's cached platform executable must not be reused across architectures.

The latest full native-ARM real-container run passed **all 102 tests in 12.0 minutes**, including all 15 editing/branch cases, attaching to an existing managed daemon without changing its PID, starting an officially stopped daemon, and Settings-driven restart with two browser clients. Lint, typechecks, production build and independent code reviews also passed.

An earlier daemon scenario failed on both this fork and pristine upstream e51afc1. Further PID/socket diagnostics established a test-fixture race: it registered a live Gateway host and then indiscriminately killed processes and removed socket/PID/lock files while Gateway automatically reconnected. The fixture now establishes a genuine official running/stopped state before host registration, with real conversation/completion and process-identity assertions retained. No production kill/unlink/reinstall workaround, suppressed error, longer test timeout or skipped test was added. Earlier failed/interrupted runs remain diagnostic history, not the latest acceptance result. Passing validation does not imply a production deployment or upstream PR.

---

## 中文说明

旧用户消息支持“编辑消息 → 保存并在新分支发送”。原对话保留，底部输入框的草稿和附件独立保存。Enter 换行，Ctrl/Cmd+Enter 发送，Escape 取消；支持浏览器前进、后退和刷新后的原对话入口。

这只是**对话分支**，不会创建 Git 分支或隔离工作目录，也不会自动回滚项目文件。新分支中的后续指令仍可能修改同一份项目文件。

仅支持每轮第一条持久化用户消息。可读取的图片及支持的结构化引用保留；音频、非空文本跨度等无法安全重建的输入会明确拒绝。历史 `@文件`／应用附加上下文无法从当前官方历史接口完整读取，编辑器会提醒重新附加，不能把“可见消息复制”当作“全部上下文复制”。旧式历史若不支持当前官方分页接口，也不会假装支持编辑。

创建分支后发送失败，可以在同一分支重试，不会重新创建分支。Gateway 重启或临时能力过期后，仍可普通打开该分支继续对话，但特殊重试入口可能失效。最新完整真实容器回归已通过全部 102 项测试；先前的 daemon 失败已定位并修复为测试生命周期竞态，具体证据见上文。测试通过不代表已经替换线上版本。
