import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { join } from "node:path";

if (process.env.ELECTROBUN_OS === "macos") {
  const buildDir = process.env.ELECTROBUN_BUILD_DIR;
  if (!buildDir) throw new Error("缺少 ELECTROBUN_BUILD_DIR，无法设置 macOS 应用语言。");

  const bundlePath = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ?? readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(buildDir, entry.name))
    .find((path) => existsSync(join(path, "Contents", "Info.plist")));
  if (!bundlePath) throw new Error(`未找到待本地化的 macOS 应用：${buildDir}`);

  const plistPath = join(bundlePath, "Contents", "Info.plist");
  let plist = readFileSync(plistPath, "utf8");
  // 两套 SDK 当前生成 XML；如果改为二进制 plist，应改用 macOS 的 plutil。
  if (!/<\/dict>\s*<\/plist>\s*$/.test(plist)) throw new Error(`不支持的 Info.plist 格式：${plistPath}`);
  const bundleName = plist.match(/<key>CFBundleName<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!bundleName) throw new Error(`无法读取应用名称：${plistPath}`);
  const minimumMacVersion = process.env.ELECTROBUN_ARCH === "x64" ? "13.0" : undefined;

  if (minimumMacVersion) {
    // 内层更新包和外层自解压器都执行此钩子，防止旧 SDK 二进制把构建机系统版本带回发布包。
    for (const path of new Bun.Glob("**/*").scanSync({ cwd: bundlePath, absolute: true, onlyFiles: true })) {
      const header = Buffer.from(await file(path).slice(0, 4).arrayBuffer());
      if (header.length < 4 || ![0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32LE())) continue;
      const result = Bun.spawnSync(["otool", "-l", path]);
      if (result.exitCode !== 0) throw new Error(`无法读取 macOS 原生组件部署目标：${path}`);
      const commands = result.stdout.toString();
      const versions = [...commands.matchAll(/cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \d+\s+minos ([\d.]+)|cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)/g)]
        .map(match => match[1] ?? match[2]!);
      if (!versions.length || versions.some(version => {
        const [major, minor = 0, patch = 0] = version.split(".").map(Number);
        return major! > 13 || (major === 13 && (minor > 0 || patch > 0));
      })) {
        throw new Error(`原生组件最低系统版本超过 macOS ${minimumMacVersion}：${path}（${versions.join(", ") || "未知"}）。请先运行 bun compat/macIntel/prepareNative.ts。`);
      }
    }
  }

  for (const [key, value] of [
    ["CFBundleDevelopmentRegion", "<string>zh-Hans</string>"],
    ["CFBundleLocalizations", "<array><string>zh-Hans</string></array>"],
    ["NSMicrophoneUsageDescription", "<string>用于语音输入和显示麦克风音量。</string>"],
    ["NSSpeechRecognitionUsageDescription", "<string>用于将语音转换为输入文字。</string>"],
    ...(minimumMacVersion ? [["LSMinimumSystemVersion", `<string>${minimumMacVersion}</string>`]] : []),
  ]) {
    const existing = new RegExp(`<key>${key}</key>\\s*<(string|array)>[\\s\\S]*?</\\1>`);
    if (existing.test(plist)) {
      plist = plist.replace(existing, `<key>${key}</key>${value}`);
    } else {
      plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `  <key>${key}</key>\n  ${value}\n</dict>\n</plist>`);
    }
  }
  writeFileSync(plistPath, plist);

  const resourceDir = join(bundlePath, "Contents", "Resources", "zh-Hans.lproj");
  mkdirSync(resourceDir, { recursive: true });
  writeFileSync(join(resourceDir, "InfoPlist.strings"),
    `CFBundleName = ${JSON.stringify(bundleName)};\nCFBundleDisplayName = ${JSON.stringify(bundleName)};\n`);
  console.log(`已设置 macOS 简体中文本地化：${bundlePath}`);
}
