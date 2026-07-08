import path from "path";
import isPathInside from "is-path-inside";

export default (fileName?: string[] | string) => {
  // 统一使用项目目录下的 data 文件夹作为业务数据目录
  const basePath = path.join(process.cwd(), "data");
  if (fileName) {
    let dbPath: string;
    if (Array.isArray(fileName)) {
      dbPath = path.resolve(basePath, ...fileName);
    } else {
      dbPath = path.resolve(basePath, fileName);
    }
    if (!isPathInside(dbPath, basePath) && dbPath !== basePath) {
      throw new Error("路径逃逸错误，路径必须在数据目录内");
    }
    return dbPath;
  }
  return basePath;
};

export function isEletron() {
  if (typeof process.versions?.electron !== "undefined") {
    const { app } = require("electron");
    return true;
  } else {
    return false;
  }
}
