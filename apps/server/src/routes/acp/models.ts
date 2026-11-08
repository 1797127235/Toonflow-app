import { Router } from "express";
import { z } from "zod";
import { getAcpEntry, type AcpConfigOption } from "@/agent/acp/pi/runtime";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const querySchema = z.object({ directory: z.string().min(1).max(4096) });

export default Router().get("/", validateFields(querySchema.shape, "query"), async (req, res) => {
  const { directory } = req.query as z.infer<typeof querySchema>;
  const entry = await getAcpEntry(await u.workspace.resolveWorkspace(req, directory));
  const models = (entry.configOptions as AcpConfigOption[]).find(item => item.id === "model");
  res.status(200).send(success({ models }));
});
