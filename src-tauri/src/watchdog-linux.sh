#!/bin/sh
# 仅清理仍归本应用所有的代理与当前用户内核。
APP_PID="$1"
DATA="$2"
while kill -0 "$APP_PID" 2>/dev/null; do sleep 1; done
PORT=$(cat "$DATA/watchdog.port" 2>/dev/null)
case "$PORT" in ''|*[!0-9]*) PORT= ;; esac
if [ -n "$PORT" ]; then
  case "$XDG_CURRENT_DESKTOP" in
    *GNOME*|*gnome*|*Unity*|*Cinnamon*|*Budgie*)
      MODE=$(gsettings get org.gnome.system.proxy mode 2>/dev/null)
      HOST=$(gsettings get org.gnome.system.proxy.http host 2>/dev/null)
      HTTPS=$(gsettings get org.gnome.system.proxy.https host 2>/dev/null)
      HTTP_PORT=$(gsettings get org.gnome.system.proxy.http port 2>/dev/null)
      HTTPS_PORT=$(gsettings get org.gnome.system.proxy.https port 2>/dev/null)
      if [ "$MODE" = "'manual'" ] && [ "$HOST" = "'127.0.0.1'" ] && [ "$HTTPS" = "$HOST" ] && [ "$HTTP_PORT" = "$PORT" ] && [ "$HTTPS_PORT" = "$PORT" ]; then
        gsettings set org.gnome.system.proxy mode none >/dev/null 2>&1
      fi
      ;;
    *KDE*|*kde*)
      for VERSION in 6 5; do
        command -v "kreadconfig$VERSION" >/dev/null 2>&1 || continue
        MODE=$("kreadconfig$VERSION" --file kioslaverc --group 'Proxy Settings' --key ProxyType)
        HTTP=$("kreadconfig$VERSION" --file kioslaverc --group 'Proxy Settings' --key httpProxy)
        HTTPS=$("kreadconfig$VERSION" --file kioslaverc --group 'Proxy Settings' --key httpsProxy)
        if [ "$MODE" = 1 ] && [ "$HTTP" = "http://127.0.0.1:$PORT" ] && [ "$HTTPS" = "$HTTP" ]; then
          "kwriteconfig$VERSION" --file kioslaverc --group 'Proxy Settings' --key ProxyType 0
          dbus-send --session --type=signal /KIO/Scheduler org.kde.KIO.Scheduler.reparseSlaveConfiguration string:
        fi
        break
      done
      ;;
  esac
fi
# /proc/cmdline 按独立参数精确匹配配置路径，不把目录名解释为 pkill 正则。
CURRENT_UID=$(id -u)
for PROC in /proc/[0-9]*; do
  [ -r "$PROC/cmdline" ] || continue
  # file capabilities 会让 /proc 目录归 root，并禁止 readlink exe；真实 UID 仍是应用用户。
  OWNER=$(awk '/^Uid:/{print $2}' "$PROC/status" 2>/dev/null)
  [ "$OWNER" = "$CURRENT_UID" ] || continue
  [ "$(cat "$PROC/comm" 2>/dev/null)" = mihomo ] || continue
  tr '\000' '\n' < "$PROC/cmdline" 2>/dev/null | grep -Fxq -- "$DATA/config.yaml" || continue
  kill "${PROC##*/}" 2>/dev/null
done
rm -f "$DATA/watchdog.pid"
