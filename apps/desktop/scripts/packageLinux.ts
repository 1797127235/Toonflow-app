import { $ } from "bun";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "@toonflow/file";
import { file, write } from "@toonflow/file/bun";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import desktopConfig from "../../../electrobun.config";

if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("deb 与 AppImage 打包需要 Linux x64 或 arm64 环境。");
}
if (!/^\d+\.\d+\.\d+$/.test(desktopConfig.app.version)) {
  throw new Error("应用版本必须是 x.y.z，才能写入 deb 控制信息。");
}

const projectDir = realpathSync(resolve(import.meta.dirname, "../../.."));
process.chdir(projectDir);
const debArch = process.arch === "x64" ? "amd64" : "arm64";
const appArch = process.arch === "x64" ? "x86_64" : "aarch64";
const runtimeName = process.arch === "x64" ? "runtime-x86_64" : "runtime-aarch64";
// ACT: 固定 2026-11-03 的 type2 runtime。上游 continuous 更换后校验失败，需同时更新体积上限内的摘要。
const runtimeSha256 = process.arch === "x64"
  ? "617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46"
  : "9a72a744d221576c9347ec074243acc5c3c7568896b12714e0e82e9f0bf47900";
const runtimeUrl = `https://github.com/AppImage/type2-runtime/releases/download/continuous/${runtimeName}`;
const artifactDir = resolve(desktopConfig.build.artifactFolder);
const linuxDir = resolve("build/desktop/linux");
const installerDir = resolve("apps/desktop/installer");
const icon = resolve("packages/assets/logo.iconset/icon_512x512.png");
const installRoot = "/opt/laywork";
const debFile = join(artifactDir, `laywork_${desktopConfig.app.version}_${debArch}.deb`);
const appImageFile = join(artifactDir, `Laywork-${desktopConfig.app.version}-${appArch}.AppImage`);

if (!existsSync(icon)) throw new Error("缺少应用图标 packages/assets/logo.iconset/icon_512x512.png。");
for (const command of ["dpkg-deb", "mksquashfs", "tar"]) {
  if ((await $`sh -c ${`command -v ${command}` }`.quiet().nothrow()).exitCode !== 0) {
    throw new Error(`缺少 ${command}，无法打包 Linux 安装包。`);
  }
}

async function sha256(path: string) {
  return createHash("sha256").update(Buffer.from(await file(path).arrayBuffer())).digest("hex");
}

async function ensureRuntime() {
  const cache = join(linuxDir, runtimeName);
  mkdirSync(linuxDir, { recursive: true });
  if (existsSync(cache) && await sha256(cache) === runtimeSha256) return cache;
  rmSync(cache, { force: true });
  const response = await fetch(runtimeUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`AppImage 运行时下载失败：HTTP ${response.status}`);
  if (!response.body) throw new Error("AppImage 运行时下载内容为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 8 * 1024 * 1024) throw new Error("AppImage 运行时超过 8 MiB 下载上限。");
    chunks.push(chunk);
  }
  if (!size) throw new Error("AppImage 运行时下载内容为空。");
  const bytes = Buffer.concat(chunks, size);
  if (createHash("sha256").update(bytes).digest("hex") !== runtimeSha256) {
    throw new Error("AppImage 运行时校验失败，已停止打包。");
  }
  await write(cache, bytes);
  chmodSync(cache, 0o755);
  return cache;
}

async function writeText(path: string, content: string, mode: number) {
  mkdirSync(dirname(path), { recursive: true });
  await write(path, content);
  chmodSync(path, mode);
}

const payload = mkdtempSync(join(linuxDir, "payload"));
const stage = mkdtempSync(join(linuxDir, "stage"));
try {
  const manifest = await file(join(artifactDir, `stable-linux-${process.arch}-update.json`)).json();
  if (manifest.version !== desktopConfig.app.version) throw new Error("构建产物版本不一致，请重新构建。");
  const archiveName = manifest.artifact?.file;
  if (typeof archiveName !== "string" || !archiveName.endsWith(".tar.zst")) throw new Error("Linux 更新包文件名无效。");
  const archive = await file(join(artifactDir, archiveName)).arrayBuffer();
  const tarFile = join(payload, "app.tar");
  await write(tarFile, Bun.zstdDecompressSync(archive));
  const extractDir = join(payload, "app");
  mkdirSync(extractDir);
  await $`tar -xf ${tarFile} -C ${extractDir} --strip-components=1`;
  if (!existsSync(join(extractDir, "bin/launcher")) || !existsSync(join(extractDir, "bin/bun"))) {
    throw new Error("应用包缺少 launcher 或 bun，请重新构建。");
  }

  const debRoot = join(stage, "deb");
  cpSync(extractDir, join(debRoot, "opt/laywork/app"), { recursive: true });
  mkdirSync(join(debRoot, "opt/laywork/bin"), { recursive: true });
  copyFileSync(join(installerDir, "linuxLauncher.sh"), join(debRoot, "opt/laywork/bin/laywork"));
  chmodSync(join(debRoot, "opt/laywork/bin/laywork"), 0o755);
  const openUrlBuild = await Bun.build({
    entrypoints: [join(installerDir, "openUrl.ts")],
    outdir: join(debRoot, "opt/laywork/bin"),
    target: "bun",
    minify: true,
  });
  if (!openUrlBuild.success) throw new AggregateError(openUrlBuild.logs, "安装链接脚本构建失败。");
  mkdirSync(join(debRoot, "opt/laywork/share"), { recursive: true });
  copyFileSync(icon, join(debRoot, "opt/laywork/share/laywork.png"));
  chmodSync(join(debRoot, "opt/laywork/share/laywork.png"), 0o644);
  await writeText(join(debRoot, "usr/bin/laywork"), `#!/bin/sh\nexec ${installRoot}/bin/laywork "$@"\n`, 0o755);
  await writeText(join(debRoot, "usr/share/applications/laywork.desktop"), `[Desktop Entry]
Version=1.0
Name=Laywork
Comment=开源 AI 创作画布
Exec=${installRoot}/bin/laywork %u
Icon=laywork
Type=Application
Categories=Graphics;
MimeType=x-scheme-handler/toonflow;
StartupNotify=true
`, 0o644);
  mkdirSync(join(debRoot, "usr/share/icons/hicolor/512x512/apps"), { recursive: true });
  copyFileSync(icon, join(debRoot, "usr/share/icons/hicolor/512x512/apps/laywork.png"));
  chmodSync(join(debRoot, "usr/share/icons/hicolor/512x512/apps/laywork.png"), 0o644);
  await writeText(join(debRoot, "DEBIAN/control"), `Package: laywork
Version: ${desktopConfig.app.version}
Section: graphics
Priority: optional
Architecture: ${debArch}
Maintainer: HBAI-Ltd <ltlctools@outlook.com>
Depends: libgtk-3-0t64 | libgtk-3-0, libwebkit2gtk-4.1-0 | libwebkit2gtk-4.1-0t64, libayatana-appindicator3-1, librsvg2-2
Homepage: https://github.com/1797127235/Toonflow-app
Description: Laywork AI creation canvas
 无限画布与 Agent 助手。需要系统提供 GTK 3 与 WebKitGTK 4.1。
`, 0o644);
  await writeText(join(debRoot, "DEBIAN/postinst"), `#!/bin/sh
set -e
if [ "$1" = "configure" ] && command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
`, 0o755);
  // ACT: 卸载不删除 ~/.local/share/toonflow，避免清掉用户项目与设置。
  await writeText(join(debRoot, "DEBIAN/postrm"), `#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q /usr/share/icons/hicolor || true
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
  fi
fi
`, 0o755);
  mkdirSync(artifactDir, { recursive: true });
  await $`dpkg-deb --root-owner-group -Zxz --build ${debRoot} ${debFile}`;

  const appDir = join(stage, "AppDir");
  cpSync(join(debRoot, "opt"), join(appDir, "opt"), { recursive: true });
  await writeText(join(appDir, "AppRun"), `#!/bin/sh
cd "$(dirname "$0")"
export APPDIR="$(pwd)"
exec "$APPDIR/opt/laywork/bin/laywork" "$@"
`, 0o755);
  await writeText(join(appDir, "laywork.desktop"), `[Desktop Entry]
Version=1.0
Name=Laywork
Comment=开源 AI 创作画布
Exec=laywork %u
Icon=laywork
Type=Application
Categories=Graphics;
MimeType=x-scheme-handler/toonflow;
`, 0o644);
  copyFileSync(icon, join(appDir, "laywork.png"));
  const squash = join(stage, "app.squashfs");
  await $`mksquashfs ${appDir} ${squash} -all-root -noappend -no-progress`;
  const runtime = await ensureRuntime();
  await $`cat ${runtime} ${squash} > ${appImageFile}`;
  chmodSync(appImageFile, 0o755);
  console.log(`deb 安装包：${debFile}`);
  console.log(`AppImage：${appImageFile}`);
} finally {
  for (const directory of [payload, stage]) {
    if (dirname(realpathSync(directory)) !== realpathSync(linuxDir)) throw new Error("拒绝清理暂存目录以外的路径。");
    rmSync(directory, { recursive: true });
  }
}
