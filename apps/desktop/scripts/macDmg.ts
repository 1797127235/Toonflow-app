#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "@toonflow/file";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export default async function prepareMacDmg() {
  const directory = resolve(import.meta.dir, "../../../build/desktop/macTools");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "hdiutil");
  const result = await Bun.build({ entrypoints: [import.meta.filename], target: "bun", outdir: directory, naming: "hdiutil" });
  if (!result.success) throw new AggregateError(result.logs, "无法准备 macOS 安装引导。");
  chmodSync(target, 0o755);
  process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
}

async function run(command: string[], input?: string) {
  const child = Bun.spawn(command, {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "inherit",
    stderr: "inherit",
    timeout: command[0] === "/usr/bin/osascript" ? 120000 : 600000,
  });
  if (await child.exited !== 0) throw new Error(`macOS 安装镜像制作失败：${command[0]} ${command[1]}`);
}

async function createDmg(args: string[]) {
  const sourceIndex = args.indexOf("-srcfolder");
  if (args[0] !== "create" || sourceIndex < 0) {
    const child = Bun.spawn(["/usr/bin/hdiutil", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await child.exited);
  }
  const source = args[sourceIndex + 1];
  const output = args.at(-1);
  const formatIndex = args.indexOf("-format");
  const volumeIndex = args.indexOf("-volname");
  const volumeName = args[volumeIndex + 1];
  if (!source || !output || formatIndex < 0 || volumeIndex < 0 || !volumeName || basename(volumeName) !== volumeName || [".", ".."].includes(volumeName)) {
    throw new Error("缺少或无效的 macOS 安装镜像参数。");
  }
  // ACT: 保留 /Volumes 供 Finder 解析背景别名，用独立挂载路径隔离每次构建，卷名仍保持不变。
  const mountPath = join("/Volumes", `${volumeName}-${crypto.randomUUID()}`);
  if (existsSync(mountPath)) throw new Error(`请先推出同名安装镜像再打包：${mountPath}`);
  const apps = readdirSync(source).filter(name => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("macOS 安装镜像必须包含且仅包含一个应用。");
  const background = join(source, ".background");
  mkdirSync(background, { recursive: true });
  if (!existsSync(join(source, "Applications"))) throw new Error("macOS 安装镜像缺少 Applications 快捷方式。");

  // ACT: 使用 macOS 自带 AppKit 绘制文字和箭头，不引入图片或 DMG 构建依赖。
  await run(["/usr/bin/osascript", "-l", "JavaScript", "-", join(background, "install.png")], `
ObjC.import("AppKit");
function run(args) {
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(640, 400));
  image.lockFocus;
  $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.97, 0.98, 1, 1).set;
  $.NSRectFill($.NSMakeRect(0, 0, 640, 400));
  function text(value, y, size, color) {
    const style = $.NSMutableParagraphStyle.alloc.init;
    style.alignment = $.NSTextAlignmentCenter;
    $(value).drawInRectWithAttributes($.NSMakeRect(20, y, 600, size + 10), $({
      NSFont: $.NSFont.systemFontOfSize(size),
      NSColor: color,
      NSParagraphStyle: style
    }));
  }
  const dark = $.NSColor.colorWithCalibratedWhiteAlpha(0.15, 1);
  const muted = $.NSColor.colorWithCalibratedWhiteAlpha(0.4, 1);
  text("安装 Laywork", 320, 28, dark);
  text("将左侧应用拖到右侧 Applications 文件夹", 282, 17, muted);
  text("→", 165, 56, $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.25, 0.45, 0.9, 1));
  text("等待复制完成，再从“应用程序”打开 Laywork。", 64, 15, dark);
  text("Drag Laywork to Applications to install.", 34, 13, muted);
  image.unlockFocus;
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  if (!bitmap.representationUsingTypeProperties($.NSPNGFileType, $({})).writeToFileAtomically(args[0], true)) {
    throw new Error("无法保存安装说明背景");
  }
}
`);

  const temporary = mkdtempSync(join(tmpdir(), "toonflowDmg"));
  const imagePath = join(temporary, "install.dmg");
  try {
    const createArgs = [...args];
    createArgs[formatIndex + 1] = "UDRW";
    createArgs[createArgs.length - 1] = imagePath;
    createArgs.splice(1, 0, "-fs", "HFS+");
    await run(["/usr/bin/hdiutil", ...createArgs]);
    await run(["/usr/bin/hdiutil", "attach", imagePath, "-readwrite", "-nobrowse", "-mountpoint", mountPath]);
    await run(["/usr/bin/osascript", "-", mountPath, apps[0]!], `
on run args
  set volumeFolder to POSIX file (item 1 of args) as alias
  set appName to item 2 of args
  tell application "Finder"
    tell folder volumeFolder
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set bounds of container window to {200, 160, 840, 582}
      set viewOptions to icon view options of container window
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to 96
      set text size of viewOptions to 14
      set background picture of viewOptions to file ".background:install.png"
      set position of item appName to {170, 190}
      set position of item "Applications" to {470, 190}
      close
      open
      update without registering applications
      delay 2
      close
    end tell
  end tell
end run
`);
    if (!existsSync(join(mountPath, ".DS_Store"))) throw new Error("Finder 未保存 macOS 安装引导布局。");
    await run(["/usr/bin/hdiutil", "detach", mountPath]);
    await run(["/usr/bin/hdiutil", "convert", imagePath, "-format", args[formatIndex + 1]!, "-o", output, "-ov"]);
    console.log(`已添加拖拽安装引导：${basename(output)}`);
  } finally {
    if (existsSync(mountPath) && statSync(mountPath).dev !== statSync("/Volumes").dev) {
      try { await run(["/usr/bin/hdiutil", "detach", mountPath]); }
      catch (error) { throw new Error(`安装镜像未能卸载，已保留临时目录：${temporary}`, { cause: error }); }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await createDmg(process.argv.slice(2));
