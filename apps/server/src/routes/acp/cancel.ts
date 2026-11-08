import { Router } from "express";
import { z } from "zod";
import { getExistingAcpEntry } from "@/agent/acp/pi/runtime";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096) }), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  // 没有已建立的会话就不现场冷启动 pi-acp，直接视为已取消。
  const entry = await getExistingAcpEntry(cwd);
  entry?.client.cancel(entry.sessionId);
  res.json(success({ cancelled: true }));
});