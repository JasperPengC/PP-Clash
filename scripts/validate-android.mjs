import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [directory, version, mode] = process.argv.slice(2);
if (!directory || !/^\d+\.\d+\.\d+$/.test(version) || !['debug', 'release'].includes(mode)) {
  throw new Error('Usage: validate-android.mjs <directory> <version> <debug|release>');
}
const sdk = process.env.ANDROID_HOME;
if (!sdk) throw new Error('ANDROID_HOME is required');
const buildTools = join(sdk, 'build-tools', '36.0.0');
const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const expectedCertificate = process.env.PPCLASH_ANDROID_CERT_SHA256?.replaceAll(':', '').toLowerCase();
let certificate;
for (const abi of ['arm64-v8a', 'x86_64']) {
  const apk = join(directory, `ppclash-android-${abi}-v${version}.apk`);
  if (!existsSync(apk) || statSync(apk).size === 0 || statSync(apk).size > 80 * 1024 * 1024) {
    throw new Error(`Missing, empty or oversized APK: ${abi}`);
  }
  const entries = run('unzip', ['-Z1', apk]).trim().split('\n');
  const libraries = entries.filter(name => name.startsWith('lib/') && name.endsWith('.so'));
  if (libraries.some(name => name.split('/')[1] !== abi)
      || !libraries.includes(`lib/${abi}/libppclash_lib.so`) || !libraries.includes(`lib/${abi}/libgojni.so`)) {
    throw new Error(`APK has missing or mismatched native libraries: ${abi}`);
  }
  for (const name of libraries) {
    const elf = execFileSync('unzip', ['-p', apk, name], { maxBuffer: 256 * 1024 * 1024 });
    if (elf.subarray(0, 4).toString('hex') !== '7f454c46' || elf[4] !== 2 || elf[5] !== 1
        || elf.readUInt16LE(18) !== (abi === 'arm64-v8a' ? 183 : 62)) {
      throw new Error(`Native library does not match ${abi}: ${name}`);
    }
  }
  if (entries.some(name => /(?:kernel\.zip|\.keystore|\.jks)$/.test(name))) throw new Error('APK contains a desktop kernel or signing material');
  const badging = run(join(buildTools, 'aapt2'), ['dump', 'badging', apk]);
  if (!badging.includes("name='com.ppclash.app'") || !badging.includes(`versionName='${version}'`)) throw new Error('APK identity/version mismatch');
  if (!/^(?:minSdkVersion|sdkVersion):'24'$/m.test(badging) || !/^targetSdkVersion:'36'$/m.test(badging)) throw new Error('APK SDK configuration mismatch');
  if (mode === 'release' && badging.includes('application-debuggable')) throw new Error('Release APK is debuggable');
  const signature = run(join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk]);
  if (mode === 'release' && /certificate DN:.*CN=Android Debug/i.test(signature)) throw new Error('Release APK uses the Android debug key');
  const fingerprint = signature.match(/Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)/)?.[1].toLowerCase();
  if (!fingerprint || (certificate && certificate !== fingerprint) || (expectedCertificate && fingerprint !== expectedCertificate)) {
    throw new Error('APK signing certificate mismatch');
  }
  certificate = fingerprint;
  run(join(buildTools, 'zipalign'), ['-c', '-P', '16', '4', apk]);
  console.log(`Validated Android ${abi} ${version} (${(statSync(apk).size / 1024 / 1024).toFixed(1)} MiB)`);
}
if (mode === 'release') {
  const aab = join(directory, `ppclash-android-v${version}.aab`);
  const entries = run('unzip', ['-Z1', aab]).split('\n');
  for (const abi of ['arm64-v8a', 'x86_64']) for (const library of ['libppclash_lib.so', 'libgojni.so']) {
    if (!entries.includes(`base/lib/${abi}/${library}`)) throw new Error(`Bundle is missing ${abi}/${library}`);
  }
  const signature = run(join(process.env.JAVA_HOME, 'bin/jarsigner'), ['-J-Duser.language=en', '-J-Duser.country=US', '-verify', aab]);
  if (!signature.includes('jar verified.')) throw new Error('Bundle signature verification failed');
  const bundleCertificate = run(join(process.env.JAVA_HOME, 'bin/keytool'), ['-J-Duser.language=en', '-printcert', '-jarfile', aab]);
  const fingerprint = bundleCertificate.match(/SHA256: ([A-Fa-f0-9:]+)/)?.[1].replaceAll(':', '').toLowerCase();
  if (fingerprint !== certificate) throw new Error('Bundle signing certificate does not match the APKs');
  console.log(`Validated Android App Bundle ${version} (${(statSync(aab).size / 1024 / 1024).toFixed(1)} MiB)`);
}
const allowed = new Set(['SHA256SUMS', ...['arm64-v8a', 'x86_64'].map(abi => `ppclash-android-${abi}-v${version}.apk`)]);
if (mode === 'release') allowed.add(`ppclash-android-v${version}.aab`);
if (readdirSync(directory).some(name => !allowed.has(name))) throw new Error('Android output contains stale or unexpected artifacts');
