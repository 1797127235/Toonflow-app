import { Router } from "express";
import { z } from "zod";
import { getExistingAcpClient } from "@/agent/acp/pi/runtime";
import { readAcpBindingFromFile } from "@/agent/acp/pi/binding";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const inputSchema = z.object({
  directory: z.string().min(1).max(4096),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  const { directory, sessionFile } = req.body as z.infer<typeof inputSchema>;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const client = await getExistingAcpClient(cwd);
  if (client) {
    // 一个目录可能有多个会话，优先按会话文件找到对应的 sessionId；找不到再全部取消。
    const binding = sessionFile
      ? await u.workspaceFile.resolveWorkspaceFile(req, directory, `.agent/sessions/${sessionFile}`)
        .then(file => readAcpBindingFromFile(file.path)).catch(() => undefined)
      : undefined;
    if (binding) client.cancel(binding.sessionId);
    else client.cancelAll();
  }
  res.json(success({ cancelled: true }));
});