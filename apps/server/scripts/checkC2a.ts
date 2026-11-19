import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import c2a from "@toonflow/providers/media/c2a";
import c2aYzh from "@toonflow/providers/media/c2aYzh";
import { loadMediaProviderSource, validateMediaProviderSource } from "@/utils/media/provider";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(c2a.models.length === 22, `c2a 模型数 ${c2a.models.length}`);
assert(c2aYzh.models.length === 28, `c2aYzh 模型数 ${c2aYzh.models.length}`);

const image = await c2a.getPrice!({ type: "image", model: "grok-imagine-image-2.0", prompt: "a", size: "1K", n: 2 });
assert(image?.price === "¥0.16", `图片报价 ${image?.price}`);
const video = await c2a.getPrice!({ type: "video", model: "doubao-seedance-2-0-260128", prompt: "a", resolution: "720p", duration: 5 });
assert(video?.price === "¥4.00" && video.tips.includes("预扣"), `km 视频报价 ${video?.price} ${video?.tips}`);
const perCall = await c2aYzh.getPrice!({ type: "video", model: "doubao-seedance-2.0", prompt: "a", resolution: "720p", duration: 9 });
assert(perCall?.price === "¥3.17", `yzh 按次报价 ${perCall?.price}`);
assert(await c2a.getPrice!({ type: "video", model: "no-such", prompt: "a", resolution: "720p", duration: 5 }) === null, "未知模型应不报价");

const root = resolve(import.meta.dirname, "../../../packages/providers/src/media");
for (const [name, count] of [["c2a.ts", 22], ["c2aYzh.ts", 28]] as const) {
  const source = await readFile(resolve(root, name), "utf8");
  const meta = validateMediaProviderSource(source);
  assert(meta.id === name.slice(0, -3) && meta.supportsPrice && meta.rules.length === 3 && meta.models.length === count, `${name} 元数据 ${meta.models.length}`);
  const loaded = await loadMediaProviderSource(source, { apiKey: "test-key" });
  assert(typeof loaded.generateImage === "function" && typeof loaded.generateVideo === "function" && typeof loaded.resume === "function", `${name} 缺少生成方法`);
  await loaded.generateVideo({ model: "not-a-model", prompt: "x" }).then(() => { throw new Error("应拒绝未知模型"); }, (error: Error) => {
    assert(error.message.includes("未适配该模型"), error.message);
  });
}

const foreign = `import fs from "node:fs";\nexport default { id: "demo", label: "Demo", rules: [], models: [] };\n`;
await loadMediaProviderSource(foreign).then(() => { throw new Error("不应允许导入"); }, (error: Error) => {
  assert(error.message.includes("不能导入模块"), error.message);
});

console.log("ok");
