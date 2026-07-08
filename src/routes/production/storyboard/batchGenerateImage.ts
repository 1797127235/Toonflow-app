import express from "express";
import u from "@/utils";
import { z } from "zod";
import sharp from "sharp";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { Output, tool } from "ai";
import { assetItemSchema } from "@/agents/productionAgent/tools";
const router = express.Router();
export type AssetData = z.infer<typeof assetItemSchema>;

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
    compulsory: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
      concurrentCount = 1,
      compulsory = false,
      regenerate = false,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId: number;
      concurrentCount: number;
      compulsory: boolean;
      regenerate: boolean;
    } = req.body;
    if (!storyboardIds || storyboardIds.length === 0) return res.status(400).send(error("storyboardIds不能为空"));
    // 当没有 storyboardIds 时，通过 AI 生成新的分镜面板数据
    let finalStoryboardIds: number[] = storyboardIds || [];
    // shouldGenerateImage === 0 的分镜标记为「未生成」，其余标记为「生成中」
    const storyboardData = await u.db("o_storyboard").where("scriptId", scriptId).where("projectId", projectId).whereIn("id", finalStoryboardIds);
    if (!storyboardData.length) return res.status(500).send(error("未查到分镜数据"));
    const storyIds = storyboardData.map((i) => i.id);
    console.log(`[batchGenerateImage] 请求参数: storyboardIds=${storyboardIds.length}, compulsory=${compulsory}, regenerate=${regenerate}, concurrentCount=${concurrentCount}`);

    // 先计算实际要生成的分镜，避免把已生成的分镜状态刷成「生成中」
    // 跳过：状态为「已完成」且已有图片；生成失败/未生成的都允许重新生成
    let generateList = storyboardData;
    if (!regenerate) {
      generateList = generateList.filter(
        (item) => !(item.state === "已完成" && item.filePath && String(item.filePath).trim() !== ""),
      );
    }
    if (!compulsory) {
      generateList = generateList.filter((item) => item.shouldGenerateImage !== 0);
    }
    const generateIds = new Set(generateList.map((i) => i.id));
    console.log(`[batchGenerateImage] 实际需要生成: ${generateList.length}/${storyboardData.length}`);

    // 只有真正会生成的分镜才标记为「生成中」
    if (generateIds.size > 0) {
      await u.db("o_storyboard")
        .whereIn("id", Array.from(generateIds))
        .where("scriptId", scriptId)
        .update({ state: "生成中" });
    }
    // 禁用生成且不会实际生成的分镜标记为「未生成」
    const notGenerateIds = storyboardData
      .filter((item) => !generateIds.has(item.id!) && item.shouldGenerateImage === 0)
      .map((item) => item.id!);
    if (notGenerateIds.length > 0) {
      await u.db("o_storyboard")
        .whereIn("id", notGenerateIds)
        .where("scriptId", scriptId)
        .update({ state: "未生成" });
    }

    const projectSettingData = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();

    // 按 rowid 顺序查出每个 storyboard 关联的 assetId 有序列表
    const assets2StoryboardRows = await u
      .db("o_assets2Storyboard")
      .whereIn("storyboardId", storyIds)
      .orderBy("rowid")
      .select("storyboardId", "assetId");

    // 收集所有 assetId，批量查对应的 imageId
    const allAssetIds = [...new Set(assets2StoryboardRows.map((r: any) => r.assetId))];
    const assetImageMap: Record<number, number> = {};
    if (allAssetIds.length > 0) {
      const assetRows = await u.db("o_assets").whereIn("id", allAssetIds).select("id", "imageId");
      assetRows.forEach((row: any) => {
        assetImageMap[row.id] = row.imageId;
      });
    }

    // 按 rowid 顺序重建 assetRecord，值为有序的 imageId 列表
    const assetRecord: Record<number, number[]> = {};
    assets2StoryboardRows.forEach((item: any) => {
      if (!assetRecord[item.storyboardId]) {
        assetRecord[item.storyboardId] = [];
      }
      const imageId = assetImageMap[item.assetId];
      if (imageId != null) {
        assetRecord[item.storyboardId].push(imageId);
      }
    });
    const realStoryData = await u.db("o_storyboard").where("scriptId", scriptId).where("projectId", projectId).whereIn("id", storyIds);
    res.status(200).send(
      success(
        realStoryData.map((i) => ({
          id: i.id,
          prompt: i.prompt,
          associateAssetsIds: assetRecord[i.id!],
          src: null,
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: i.shouldGenerateImage,
        })),
      ),
    );

    const generateTask = async (item: (typeof storyboardData)[number]) => {
      const repeloadObj = {
        prompt: item.prompt!,
        size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
        aspectRatio: projectSettingData?.videoRatio as `${number}:${number}`,
      };
      try {
        const imageCls = await u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
          {
            referenceList: await getAssetsImageBase64(assetRecord[item.id!] || []),
            ...repeloadObj,
          },
          {
            taskClass: "生成分镜图片",
            describe: "分镜图片生成",
            relatedObjects: JSON.stringify(repeloadObj),
            projectId: projectId,
          },
        );
        const savePath = `/${projectId}/assets/${scriptId}/${u.uuid()}.jpg`;
        await imageCls.save(savePath);
        await u.db("o_storyboard").where("id", item.id).update({
          filePath: savePath,
          state: "已完成",
        });
      } catch (e) {
        const normalized = u.error(e);
        console.error(`[batchGenerateImage] 分镜 ${item.id} 生成失败:`, normalized, e);
        try {
          await u.db("o_storyboard")
            .where("id", item.id)
            .update({
              reason: normalized.message,
              state: "生成失败",
            });
        } catch (dbErr) {
          console.error(`[batchGenerateImage] 分镜 ${item.id} 状态写入数据库失败:`, dbErr);
        }
      }
    };
    // 串行 + 自适应延迟生成，避免一次性把全部请求塞给供应商
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < generateList.length; i += concurrentCount) {
      const batch = generateList.slice(i, i + concurrentCount);
      const results = await Promise.allSettled(batch.map(generateTask));

      // 根据本批次结果决定下一批的延迟
      const hasQueueFull = results.some((r) => {
        if (r.status === "fulfilled") return false;
        const msg = String(r.reason?.message ?? r.reason ?? "").toLowerCase();
        return msg.includes("queue is full") || msg.includes("rate limit") || msg.includes("retry later");
      });

      const isLastBatch = i + concurrentCount >= generateList.length;
      if (!isLastBatch) {
        const delay = hasQueueFull ? 5000 : 1500;
        console.log(`[batchGenerateImage] 批次完成，${hasQueueFull ? "检测到队列满" : "正常"}，等待 ${delay}ms 后继续`);
        await sleep(delay);
      }
    }
  },
);
async function getAssetsImageBase64(imageIds: number[]) {
  if (!imageIds.length) return [];

  const imagePaths = await u.db("o_image").whereIn("o_image.id", imageIds).select("o_image.id", "o_image.filePath");

  // 建立 id 到 filePath 的映射
  const id2Path = new Map<number, string>();
  for (const row of imagePaths) {
    id2Path.set(row.id, row.filePath);
  }

  // 保证输出顺序与 imageIds 一致
  const imageUrls = await Promise.all(
    imageIds.map(async (id) => {
      const filePath = id2Path.get(id);
      if (filePath) {
        try {
          return await u.oss.getImageBase64(filePath);
        } catch {
          return null;
        }
      }
      return null;
    }),
  );
  // 保留顺序，并且过滤掉无效项
  return (imageUrls.filter(Boolean) as string[]).map((url) => ({ type: "image" as const, base64: url }));
}
