#!/usr/bin/env bash
# `npx cap add android` で生成した Android プロジェクトに、原付ナビ用の設定を追加する
set -euo pipefail

MANIFEST=android/app/src/main/AndroidManifest.xml
GRADLE=android/app/build.gradle
RES=android/app/src/main/res

# 位置情報 (バックグラウンド測位) ・通知・音声合成エンジンの利用を宣言
sed -i 's#</manifest>#    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />\
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\
    <uses-permission android:name="android.permission.WAKE_LOCK" />\
    <uses-feature android:name="android.hardware.location.gps" />\
    <queries><intent><action android:name="android.intent.action.TTS_SERVICE" /></intent></queries>\
</manifest>#' "$MANIFEST"

# 画面を縦向きに固定・ナビ中に画面が消えないように
sed -i 's#<activity#<activity android:screenOrientation="portrait"#' "$MANIFEST"

# バージョン番号 = ビルド番号 (上書きインストールできるように毎回増やす)
VC="${GITHUB_RUN_NUMBER:-1}"
sed -i "s/versionCode [0-9]\+/versionCode ${VC}/" "$GRADLE"
sed -i "s/versionName \"[^\"]*\"/versionName \"1.0.${VC}\"/" "$GRADLE"

# リリース署名 (鍵は GitHub Secrets から渡される)
cat >> "$GRADLE" <<'EOF'

android {
    signingConfigs {
        release {
            storeFile file(System.getenv("KS_PATH"))
            storePassword System.getenv("KS_PASS")
            keyAlias System.getenv("KS_ALIAS")
            keyPassword System.getenv("KS_PASS")
            storeType "pkcs12"
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
        }
    }
}
EOF

# アプリアイコン
rm -rf "$RES/mipmap-anydpi-v26"
for d in "$RES"/mipmap-*; do
  cp icons/icon-192.png "$d/ic_launcher.png"
  cp icons/icon-192.png "$d/ic_launcher_round.png"
done

echo "Android project patched (versionCode=${VC})"
