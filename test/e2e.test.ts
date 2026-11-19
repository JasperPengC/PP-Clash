import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateConfig } from '../src/core/generator';
import { DEFAULT_POLICY } from '../src/core/security';

/**
 * 端到端验证：把真实订阅喂进生成器，再把产物交给 mihomo 本体做 `-t` 校验。
 *
 * 这一步比单元测试更有说服力——它证明「我们生成的配置，内核真的能吃」。
 * 环境不具备时自动跳过，不阻塞 CI。
 */

const PROFILE_DIR = path.join(os.homedir(), 'Library/Application Support/mihomo-party/profiles');
const CORE_CANDIDATES = [
  '/tmp/mtest/mihomo',
  path.join(os.homedir(), 'Library/Application Support/PPClash/bin/mihomo'),
];

const core = CORE_CANDIDATES.find((p) => fs.existsSync(p));
const geoDir = core ? path.dirname(path.dirname(core)) : '';
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const profiles = fs.existsSync(PROFILE_DIR)
  ? fs
      .readdirSync(PROFILE_DIR)
      .filter((f) => f.endsWith('.yaml') && f !== 'default.yaml')
      .slice(0, 4)
  : [];

const available = Boolean(core) && profiles.length > 0;

describe.skipIf(!available)('端到端：真实订阅 → 生成配置 → 内核校验', () => {
  for (const file of profiles) {
    it(`${file} 生成的配置能被 mihomo 接受`, async () => {
      const raw = fs.readFileSync(path.join(PROFILE_DIR, file), 'utf-8');
      const { config, stats } = await generateConfig(raw, DEFAULT_POLICY, {
        mixedPort: 17890,
        controllerPort: 19090,
        controllerSecret: '',
        tunEnabled: false,
        mode: 'rule',
      });

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppclash-e2e-'));
      temporaryDirectories.push(dir);
      const cfgPath = path.join(dir, 'config.yaml');
      fs.writeFileSync(cfgPath, config, 'utf-8');

      // 使用已安装的数据，避免配置校验隐式下载 Geo 数据。
      for (const geo of ['geosite.dat', 'geoip.metadb', 'geoip.dat', 'country.mmdb', 'ASN.mmdb']) {
        const src = [path.join('/tmp/mtest', geo), path.join(geoDir, geo)].find(p => fs.existsSync(p));
        if (src) fs.copyFileSync(src, path.join(dir, geo));
      }

      let out = '';
      let ok = false;
      try {
        out = execFileSync(core!, ['-t', '-d', dir, '-f', cfgPath], {
          encoding: 'utf-8',
          timeout: 30_000,
        });
        ok = out.includes('test is successful');
      } catch (e: any) {
        out = String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.message ?? '');
      }

      expect(ok, `内核校验失败：\n${out.slice(-800)}`).toBe(true);
      expect(stats.proxyCount).toBeGreaterThan(0);
      expect(stats.guardRuleCount).toBeGreaterThan(0);
    }, 40_000);
  }

  it('自定义 DNS + 嗅探配置能被内核接受', async () => {
    const file = profiles[0];
    const raw = fs.readFileSync(path.join(PROFILE_DIR, file), 'utf-8');
    const { config } = await generateConfig(raw, DEFAULT_POLICY, {
      mixedPort: 17891,
      controllerPort: 19091,
      controllerSecret: '',
      tunEnabled: false,
      mode: 'rule',
      stableRouting: true,
      dnsNameserver: 'custom',
      dnsCustom: 'https://dns.google/dns-query',
      snifferEnabled: true,
      snifferOverrideDestination: true,
      socksPort: 11080,
      httpPort: 18088,
      bindAddress: '0.0.0.0',
      authUser: 'pp',
      authPass: 'clash',
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppclash-e2e-dns-'));
    temporaryDirectories.push(dir);
    const cfgPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfgPath, config, 'utf-8');
    for (const geo of ['geosite.dat', 'geoip.metadb', 'geoip.dat', 'country.mmdb', 'ASN.mmdb']) {
      const src = [path.join('/tmp/mtest', geo), path.join(geoDir, geo)].find(p => fs.existsSync(p));
      if (src) fs.copyFileSync(src, path.join(dir, geo));
    }

    let out = '';
    let ok = false;
    try {
      out = execFileSync(core!, ['-t', '-d', dir, '-f', cfgPath], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
      ok = out.includes('test is successful');
    } catch (e: any) {
      out = String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.message ?? '');
    }
    expect(ok, `内核校验失败：\n${out.slice(-800)}`).toBe(true);
  }, 40_000);
});
