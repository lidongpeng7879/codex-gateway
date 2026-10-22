import { readValidatedBody } from "h3";
import { z } from "zod";
import { defineGatewayEventHandler } from "../../../../../../server/utils/gateway/http/errors";
import { requireRecord } from "../../../../../../server/utils/gateway/http/validation/common";
import { hostStore } from "../../../../../../server/utils/gateway/state/hosts";
import { threadBroker } from "../../../../../../server/utils/gateway/runtime/broker";

// Remove this test's real conversations from discovery on the shared SSH fixture.
export default defineGatewayEventHandler(async (event) => {
  const input = await readValidatedBody(event, (body) =>
    z
      .object({
        hostId: z.number().int().positive(),
        threadId: z.string().min(1),
      })
      .parse(body),
  );
  const host = requireRecord(hostStore.getWithSecret(input.hostId), "Host not found");
  const client = await threadBroker.getHostClient(host);
  await client.request("thread/archive", { threadId: input.threadId });
  return { archived: true };
});
