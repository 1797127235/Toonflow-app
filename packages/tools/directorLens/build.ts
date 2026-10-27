import { copyFile, mkdir } from "@toonflow/file";
import { resolve } from "node:path";

// ACT: 仅取得外部分发包，原样保留元数据和客户端界面；取得源码后再改用工具脚手架构建。
const fileName = "directorLens.tool.js";
const source = resolve(import.meta.dirname, fileName);
const outputDirectory = resolve(import.meta.dirname, "../../../build/tools");
await mkdir(outputDirectory, { recursive: true });
await copyFile(source, resolve(outputDirectory, fileName));
if (process.env.NODE_ENV === "dev") {
  const dataDirectory = resolve(import.meta.dirname, "../../../data/tools");
  await mkdir(dataDirectory, { recursive: true });
  await copyFile(source, resolve(dataDirectory, fileName));
}
