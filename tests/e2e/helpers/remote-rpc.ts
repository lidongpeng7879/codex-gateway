import { once } from "node:events";
import WebSocket from "ws";
import ensureError from "ensure-error";
import { rawWebSocketDataToString } from "../../../server/utils/gateway/infra/ws/raw-data";
import { connectTestSsh } from "./ssh-client";
import type { RemoteCodexEnv } from "./remote-codex";
import { shellQuote } from "../../../server/utils/gateway/infra/ssh/shell";
import { parseRpcEnvelope } from "../../../shared/runtime/app-server";

/** A real official proxy connection, with no thread/resume or daemon lifecycle side effects. */
export async function openRemoteRpc(remote: RemoteCodexEnv) {
  const ssh = await connectTestSsh(remote);
  const channel = await new Promise<import("ssh2").ClientChannel>((resolve, reject) => {
    ssh.exec(
      `${shellQuote(remote.codexBin ?? "/home/codex/.local/bin/codex")} app-server proxy`,
      (error, channel) => (error ? reject(error) : resolve(channel)),
    );
  });
  const ws = new WebSocket("ws://localhost/rpc", {
    createConnection: () => channel,
    perMessageDeflate: false,
  });
  let nextId = 0;
  try {
    await once(ws, "open");
  } catch (error) {
    ssh.end();
    throw error;
  }
  const request = async (method: string, params: unknown) => {
    const id = ++nextId;
    return await new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => onError(new Error(`Real fixture RPC closed during ${method}`));
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const message = parseRpcEnvelope(JSON.parse(rawWebSocketDataToString(raw)));
          if (message.id !== id) return;
          cleanup();
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        } catch (error) {
          cleanup();
          reject(ensureError(error));
        }
      };
      const timer = setTimeout(
        () => onError(new Error(`Real fixture RPC timed out: ${method}`)),
        30_000,
      );
      ws.on("message", onMessage);
      ws.once("close", onClose);
      ws.once("error", onError);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const close = () => {
    ws.terminate();
    ssh.end();
  };
  try {
    await request("initialize", {
      clientInfo: { name: "gateway-e2e", version: remote.supportedCodexVersion ?? "0.164.0" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));
    return { request, close };
  } catch (error) {
    close();
    throw error;
  }
}
