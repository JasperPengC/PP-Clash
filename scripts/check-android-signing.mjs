import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const env = process.env;
const run = (tool, args) => {
  const executable = env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', tool + (process.platform === 'win32' ? '.exe' : '')) : tool;
  try {
    return execFileSync(executable, ['-J-Duser.language=en', '-J-Duser.country=US', ...args],
      { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
  } catch {
    // Never forward subprocess arguments or stderr: they may include signing settings.
    throw new Error(`Android signing ${tool} failed; check the JDK, keystore, alias and passwords`);
  }
};

try {
  const fingerprint = env.PPCLASH_ANDROID_CERT_SHA256?.replaceAll(':', '').toLowerCase();
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('A valid pinned Android certificate SHA-256 is required');
  for (const field of ['KEYSTORE', 'STORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
    if (!env[`PPCLASH_ANDROID_${field}`]) throw new Error(`Missing Android signing setting: ${field}`);
  }
  const keystore = env.PPCLASH_ANDROID_KEYSTORE;
  if (!isAbsolute(keystore) || !existsSync(keystore)) throw new Error('Android signing keystore must be an existing absolute path');
  const keyArgs = ['-keystore', keystore, '-storepass:env', 'PPCLASH_ANDROID_STORE_PASSWORD', '-alias', env.PPCLASH_ANDROID_KEY_ALIAS];
  const certificate = new X509Certificate(run('keytool', ['-exportcert', '-rfc', ...keyArgs]));
  if (certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== fingerprint) throw new Error('Android certificate SHA-256 does not match the pinned fingerprint');
  if (/CN=Android Debug(?:\n|$)/i.test(certificate.subject)) throw new Error('Android debug certificate cannot sign a release');
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) - now < 365 * 24 * 60 * 60 * 1000) {
    throw new Error('Android release certificate must be valid now and for at least one more year');
  }

  // Prove that the private key can sign, including stores with a separate key password.
  const work = mkdtempSync(join(tmpdir(), 'ppclash-signing-'));
  try {
    writeFileSync(join(work, 'probe.txt'), 'PP Clash release signing check\n', { mode: 0o600 });
    const unsigned = join(work, 'unsigned.jar');
    run('jar', ['--create', '--file', unsigned, '-C', work, 'probe.txt']);
    run('jarsigner', ['-keystore', keystore, '-storepass:env', 'PPCLASH_ANDROID_STORE_PASSWORD',
      '-keypass:env', 'PPCLASH_ANDROID_KEY_PASSWORD', '-signedjar', join(work, 'signed.jar'), unsigned, env.PPCLASH_ANDROID_KEY_ALIAS]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Android release signing verified (certificate expires ${new Date(certificate.validTo).toISOString().slice(0, 10)})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
