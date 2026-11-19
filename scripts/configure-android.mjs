import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAndroidIcons } from './make-android-icons.mjs';

const [project, aar] = process.argv.slice(2);
if (!project || !aar) throw new Error('Usage: configure-android.mjs <generated-project> <mihomo.aar>');

function patch(file, edits) {
  const path = join(project, file);
  let text = readFileSync(path, 'utf8');
  for (const [original, replacement] of edits) {
    if (text.includes(replacement)) continue;
    if (!text.includes(original)) throw new Error(`Unexpected Tauri template: ${file}`);
    text = text.replace(original, replacement);
  }
  writeFileSync(path, text);
}

const app = join(project, 'app');
const kotlin = join(app, 'src/main/java/com/ppclash/app');
writeAndroidIcons(join(app, 'src/main/res'));
mkdirSync(join(app, 'libs'), { recursive: true });
copyFileSync(aar, join(app, 'libs/mihomo.aar'));
for (const file of ['MainActivity.kt', 'ClashVpnService.kt', 'VpnPlugin.kt']) {
  copyFileSync(new URL(`../src-tauri/android/${file}`, import.meta.url), join(kotlin, file));
}

patch('gradle/wrapper/gradle-wrapper.properties', [
  ['zipStoreBase=GRADLE_USER_HOME', 'zipStoreBase=GRADLE_USER_HOME\nnetworkTimeout=180000\ndistributionSha256Sum=9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14'],
]);

patch('app/build.gradle.kts', [
  ['    compileSdk = 37', '    compileSdk = 36\n    ndkVersion = "28.2.13676358"'],
  ['    ndkVersion = "28.2.13676358"', '    ndkVersion = "28.2.13676358"\n    packaging {\n        jniLibs.useLegacyPackaging = true\n    }'],
  ['        targetSdk = 37', '        targetSdk = 36'],
  ['            isJniDebuggable = true', '            isJniDebuggable = false'],
  [`            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }`, `            packaging {
                jniLibs.keepDebugSymbols.clear()
            }`],
  ['dependencies {', 'dependencies {\n    implementation(files("libs/mihomo.aar"))'],
  ['    buildTypes {', `    val releaseKeystore = providers.environmentVariable("PPCLASH_ANDROID_KEYSTORE").orNull
    if (releaseKeystore != null) {
        signingConfigs.create("localRelease") {
            storeFile = file(releaseKeystore)
            storePassword = providers.environmentVariable("PPCLASH_ANDROID_STORE_PASSWORD").get()
            keyAlias = providers.environmentVariable("PPCLASH_ANDROID_KEY_ALIAS").get()
            keyPassword = providers.environmentVariable("PPCLASH_ANDROID_KEY_PASSWORD").get()
        }
    }
    buildTypes {`],
  ['        getByName("release") {', '        getByName("release") {\n            signingConfig = signingConfigs.findByName("localRelease")'],
]);

patch('app/src/main/AndroidManifest.xml', [
  ['    <uses-permission android:name="android.permission.INTERNET" />', '    <uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />'],
  ['            android:name=".MainActivity"', '            android:windowSoftInputMode="adjustNothing"\n            android:name=".MainActivity"'],
  ['    <application', `    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <application`],
  ['        <provider', `        <service
            android:name=".ClashVpnService"
            android:permission="android.permission.BIND_VPN_SERVICE"
            android:exported="true"
            android:foregroundServiceType="specialUse">
            <intent-filter>
                <action android:name="android.net.VpnService" />
            </intent-filter>
            <meta-data android:name="android.net.VpnService.SUPPORTS_ALWAYS_ON" android:value="false" />
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="VPN tunnel initiated by the user" />
        </service>

        <provider`],
  ['    </application>', `        <provider
            android:name=".UpdateFileProvider"
            android:authorities="\${applicationId}.updates"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/update_paths" />
        </provider>
    </application>`],
]);

mkdirSync(join(app, 'src/main/res/xml'), { recursive: true });
writeFileSync(join(app, 'src/main/res/xml/update_paths.xml'), '<paths xmlns:android="http://schemas.android.com/apk/res/android"><cache-path name="updates" path="updates/" /></paths>\n');

writeFileSync(join(app, 'ppclash.pro'), `-keep class com.ppclash.app.VpnPlugin { *; }
-keep class go.** { *; }
-keep class mobile.** { *; }
`);
