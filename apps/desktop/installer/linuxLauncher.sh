#!/bin/sh
# 安装根目录的 bin/laywork。deb 由 /usr/bin/laywork 转过来，AppImage 由 AppRun 转过来。
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
launcher="$root/app/bin/launcher"
bun="$root/app/bin/bun"
data="${XDG_DATA_HOME:-$HOME/.local/share}/toonflow"
export TOONFLOW_LINUX_PACKAGE=1

integrate_appimage() {
  [ -n "${APPIMAGE-}" ] || return 0
  share="${XDG_DATA_HOME:-$HOME/.local/share}"
  dest="$share/applications/laywork.desktop"
  icon_dir="$share/icons/hicolor/512x512/apps"
  mkdir -p "$(dirname "$dest")" "$icon_dir" || return 0
  cp "$root/share/laywork.png" "$icon_dir/laywork.png" || return 0
  tmp="$dest.tmp.$$"
  cat > "$tmp" <<EOF
[Desktop Entry]
Version=1.0
Name=Laywork
Exec="$APPIMAGE" %u
Icon=laywork
Type=Application
Categories=Graphics;
MimeType=x-scheme-handler/toonflow;
EOF
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    return 0
  fi
  mv "$tmp" "$dest" || return 0
  chmod 644 "$dest" || true
  update-desktop-database "$share/applications" >/dev/null 2>&1 || true
  xdg-mime default laywork.desktop x-scheme-handler/toonflow >/dev/null 2>&1 || true
}

integrate_appimage || true

url=""
if [ "${1-}" != "" ]; then
  case "$1" in
    toonflow://*) url=$1 ;;
    *) printf '%s\n' "安装链接无效，须为 toonflow://install?type=node&url=编码后的下载地址。" >&2
      exit 1 ;;
  esac
fi

if [ -z "$url" ]; then
  exec "$launcher"
fi

export TOONFLOW_OPEN_URL="$url"
export TOONFLOW_RUNTIME_FILE="$data/desktopRuntime.json"
# set -e 下，&& 失败不会退出；if 的状态不能用来读取上一条命令的退出码。
"$bun" "$root/bin/openUrl.js" && exit 0
status=$?
if [ "$status" -ne 10 ]; then
  exit "$status"
fi

# ACT: SDK launcher 不转发 URL；启动后通过本机服务交给待确认队列。
nohup "$launcher" >/dev/null 2>&1 &
i=0
while [ "$i" -lt 180 ]; do
  "$bun" "$root/bin/openUrl.js" && exit 0
  status=$?
  if [ "$status" -ne 10 ]; then
    exit "$status"
  fi
  i=$((i + 1))
  sleep 0.25
done
printf '%s\n' "Laywork 启动超时，请打开应用后重新点击安装链接。" >&2
exit 1
