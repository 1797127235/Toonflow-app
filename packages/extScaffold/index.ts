// 扩展的构建配置。职责只有一个：把 packages/ext/<name> 的源码打成
// 宿主能直接动态加载的单个 UMD 文件 build/ext/<id>.umd.js。
// 这个文件只在构建期运行（vite / node），不会进浏览器，所以可以引 vite、zod 和文件工具。
import { copyFile, mkdir, readFile, rename, rm } from "@toonflow/file";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadConfigFromFile } from "vite";
import vue from "@vitejs/plugin-vue";
import { z } from "zod";
import { defineExt, type ExtDefinition } from "./src/runtime.ts";

// Tiptap 系列由宿主统一提供（window.toonflowTiptapHost）。
// 单独列一张表而不是并进下面的 external 数组，是因为它们映射的全局对象不同，
// 而且宿主只在 UMD 真的引用了 toonflowTiptapHost 时才去加载这批依赖。
const tiptapGlobals = {
  "@tiptap/core": "toonflowTiptapHost.core",
  "@tiptap/vue-3": "toonflowTiptapHost.vue3",
  "@tiptap/starter-kit": "toonflowTiptapHost.starterKit",
  "@tiptap/markdown": "toonflowTiptapHost.markdown",
  "@tiptap/extension-find-and-replace": "toonflowTiptapHost.findAndReplace",
  "@tiptap/extension-highlight": "toonflowTiptapHost.highlight",
  "@tiptap/extension-image": "toonflowTiptapHost.image",
  "@tiptap/extension-list": "toonflowTiptapHost.list",
  "@tiptap/extension-subscript": "toonflowTiptapHost.subscript",
  "@tiptap/extension-superscript": "toonflowTiptapHost.superscript",
  "@tiptap/extension-table": "toonflowTiptapHost.table",
  "@tiptap/extension-text-align": "toonflowTiptapHost.textAlign",
  "@tiptap/pm/model": "toonflowTiptapHost.model",
  "@tiptap/pm/state": "toonflowTiptapHost.state",
  "@tiptap/pm/view": "toonflowTiptapHost.view",
  "marked": "toonflowTiptapHost.marked",
  "dompurify": "toonflowTiptapHost.dompurify",
};

export type ExtMetadata = Omit<ExtDefinition, "load">;

// config：扩展自己 src/metadata.ts 的内容，构建期只需要它的 id（决定产物文件名）。
// configUrl：扩展 viteConfig.ts 的 import.meta.url，用来定位扩展包根目录。
export function createExtConfig(config: ExtMetadata, configUrl: string) {
  // 先跑一次校验，让非法声明在构建开始时就失败，而不是等到产物被宿主加载。
  defineExt({ ...config, load: async () => ({ default: {} }) });
  const root = fileURLToPath(new URL(".", configUrl));
  const fileName = `${config.id}.umd.js`;
  // 产物目录是共享的：所有扩展都输出到同一个 build/ext，宿主安装时从这里取。
  const outDir = fileURLToPath(new URL("../../build/ext", import.meta.url));
  // 开发时再同步一份到 data/ext，本机插件市场和文档页能立刻看到新版本。
  const dataDir = fileURLToPath(new URL("../../data/ext", import.meta.url));
  let syncToData = process.env.NODE_ENV === "dev";

  return defineConfig({
    root,
    plugins: [
      vue(),
      // 落在 post 阶段：等 JS 压缩完、CSS 抽取完，才能把元数据和样式塞进最终产物。
      {
        name: "extBundle",
        enforce: "post",
        configResolved(resolvedConfig) {
          // watch（dev）构建也同步到 data/ext，不用手动拷文件。
          syncToData ||= Boolean(resolvedConfig.build.watch) || resolvedConfig.mode === "development";
        },
        async generateBundle(_options, bundle) {
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== "chunk") throw new Error(`未生成扩展文件：${fileName}`);
          // 重新读一遍 metadata.ts，是因为上面那个 config 参数只是入口传进来的副本；
          // watch 模式下声明文件改了，宿主需要拿到新值，而不是启动时的旧值。
          const packagePath = resolve(root, "package.json");
          const readmePath = resolve(root, "readme.md");
          const metadataPath = resolve(root, "src/metadata.ts");
          this.addWatchFile(metadataPath);
          const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, metadataPath, root);
          if (!loaded) throw new Error(`扩展缺少声明文件：${metadataPath}`);
          for (const dependency of loaded.dependencies) this.addWatchFile(dependency);
          const { load: _load, ...metadata } = defineExt({ ...loaded.config as unknown as ExtMetadata, load: async () => ({ default: {} }) });
          // 产物文件名由 id 决定，改了 id 还在跑旧的 watch 构建，会把内容写到错误的文件上。
          if (metadata.id !== config.id) throw new Error("修改扩展 ID 后请重新启动构建命令");
          // configRules 最终要写进 JSON 注释，函数/类实例序列化后会静默丢失，所以在这里就拦住。
          const configRules = z.array(z.record(z.string(), z.json())).max(100).parse(metadata.configRules ?? []);
          this.addWatchFile(packagePath);
          this.addWatchFile(readmePath);
          const packageInfo = JSON.parse(await readFile(packagePath, "utf8"));
          const version = typeof packageInfo.version === "string" ? packageInfo.version.trim() : "";
          if (!version) throw new Error(`扩展 package.json 缺少有效的 version：${config.id}`);
          const readme = await readFile(readmePath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          // 宿主只加载一个 js 文件，所以 CSS 不能留在独立资源里：
          // 全部拼起来，再从产物里删掉，换成运行时注入 <style>。
          let css = "";
          for (const [name, asset] of Object.entries(bundle)) {
            if (asset.type !== "asset" || !name.endsWith(".css")) continue;
            css += typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
            delete bundle[name];
          }
          // 用固定 id 判断是否已插入：同一扩展被反复加载/热更时，样式只保留一份。
          const styleId = JSON.stringify(`toonflowExt-${config.id}`);
          const injectStyle = css ? `if(typeof document!=="undefined"){let style=document.getElementById(${styleId});if(!style){style=document.createElement("style");style.id=${styleId};document.head.appendChild(style)}style.textContent=${JSON.stringify(css)}}\n` : "";
          // 压缩完成后加入元数据和样式，单个 JS 即可供扩展加载器使用。
          // JSON 里的 / 转成 \u002f：readme 或 CSS 里只要出现 */ 就会提前结束注释，
          // 转义后注释对任意内容都安全（浏览器解 JSON 时会把 \u002f 还原成 /）。
          chunk.code = `/*! toonflowExt:${JSON.stringify({ ...metadata, configRules, version, readme }).replaceAll("/", "\\u002f")} */\n${injectStyle}${chunk.code}`;
        },
        async writeBundle() {
          if (!syncToData) return;
          await mkdir(dataDir, { recursive: true });
          // 先写临时文件再 rename：宿主可能正在读 data/ext，避免它拿到写了一半的 UMD。
          const targetPath = resolve(dataDir, fileName);
          const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
          try {
            await copyFile(resolve(outDir, fileName), tempPath);
            await rename(tempPath, targetPath);
          } finally {
            await rm(tempPath, { force: true });
          }
        },
      },
    ],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // 打包目标：一个 UMD 文件，导出到 window.toonflowExts[<id>]，宿主按这个约定取。
    build: {
      outDir,
      // ACT: 多个扩展共享 build/ext 目录，构建单包时不能清空其他扩展的产物。
      emptyOutDir: false,
      // 不拆 CSS：样式要内联进 UMD，见 generateBundle。
      cssCodeSplit: false,
      lib: {
        entry: resolve(root, "src/index.ts"),
        name: `toonflowExts.${config.id}`,
        formats: ["umd"],
        fileName: () => fileName,
      },
      // 宿主已加载的依赖一律 external：既减体积，也保证 Vue 只有一份实例
      // （打进去两份 Vue 会让响应式和 provide/inject 全部失效）。
      rolldownOptions: {
        external: ["vue", "@vue/runtime-core", "@vue/runtime-dom", "element-plus", "@toonflow/i18n/vue", ...Object.keys(tiptapGlobals)],
        output: {
          exports: "default",
          codeSplitting: false,
          // UMD 需要知道每个 external 从哪个全局变量取，名字由宿主在启动时挂上去。
          globals: {
            ...tiptapGlobals,
            vue: "toonflowExtHost.vue",
            "@vue/runtime-core": "toonflowExtHost.vue",
            "@vue/runtime-dom": "toonflowExtHost.vue",
            "element-plus": "toonflowExtHost.elementPlus",
            "@toonflow/i18n/vue": "toonflowExtHost.i18n",
          },
        },
      },
    },
  });
}
