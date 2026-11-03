import { describe, expect, it } from 'vitest';
import {
  countRealNodes,
  isInfoNode,
  parseSubscriptionMeta,
  parseSubscriptionPreview,
} from '../src/core/subscription';
import { generateConfig } from '../src/core/generator';
import { DEFAULT_POLICY } from '../src/core/security';

describe('订阅响应头解析', () => {
  it('从 content-disposition 读出中文订阅名', () => {
    const meta = parseSubscriptionMeta({
      contentDisposition:
        "attachment;filename*=UTF-8''%E4%B8%80%E6%AF%9B%E6%9C%BA%E5%9C%BA",
    });
    expect(meta.name).toBe('一毛机场');
  });

  it('订阅名会去掉 .yaml 之类的文件名后缀', () => {
    const meta = parseSubscriptionMeta({
      contentDisposition: 'attachment;filename="config.yaml"',
    });
    expect(meta.name).toBe('config');
  });

  it('profile-title 支持 base64: 前缀', () => {
    const meta = parseSubscriptionMeta({ profileTitle: 'base64:5LiA5q+b5py65Zy6' });
    expect(meta.name).toBe('一毛机场');
  });

  it('解析 subscription-userinfo 的已用 / 总量 / 到期时间', () => {
    const meta = parseSubscriptionMeta({
      subscriptionUserinfo:
        'upload=8921017230; download=36608187967; total=2147483648000; expire=1805204537',
      profileUpdateInterval: '24',
    });
    expect(meta.traffic).toEqual({
      upload: 8921017230,
      download: 36608187967,
      total: 2147483648000,
      expire: 1805204537,
    });
    expect(meta.updateIntervalHours).toBe(24);
  });

  it('没有元信息时不该报错，返回 null', () => {
    const meta = parseSubscriptionMeta({});
    expect(meta.name).toBeNull();
    expect(meta.traffic).toBeNull();
    expect(meta.updateIntervalHours).toBeNull();
  });
});

const RAW = `proxies:
  - {name: "🇯🇵 东京 01", type: trojan, server: jp.example.com, port: 443, password: x}
  - {name: "🇭🇰 香港 01", type: vless, server: hk.example.com, port: 443, uuid: y}
  - {name: "剩余流量：1.91 TB", type: hysteria2, server: info.example.com, port: 443, password: z}
  - {name: "套餐到期：2027-03-16", type: hysteria2, server: info.example.com, port: 443, password: z}
proxy-groups:
  - {name: "🚀 节点选择", type: select, proxies: ["♻️ 自动选择", "🇯🇵 东京 01", "🇭🇰 香港 01", "剩余流量：1.91 TB"]}
  - {name: "♻️ 自动选择", type: url-test, proxies: ["🇯🇵 东京 01", "🇭🇰 香港 01"]}
`;

describe('订阅原文预览（内核未启动时）', () => {
  it('识别机场塞进节点列表的信息节点', () => {
    expect(isInfoNode('剩余流量：1.91 TB')).toBe(true);
    expect(isInfoNode('套餐到期：2027-03-16')).toBe(true);
    expect(isInfoNode('🇯🇵 东京 01')).toBe(false);
  });

  it('解析分组、规范化类型、滤掉信息节点', () => {
    const groups = parseSubscriptionPreview(RAW);
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe('🚀 节点选择');
    expect(groups[0].type).toBe('Selector');
    expect(groups[0].nodes.map((n) => n.name)).toEqual(['♻️ 自动选择', '🇯🇵 东京 01', '🇭🇰 香港 01']);
    expect(groups[1].type).toBe('URLTest');
  });

  it('没有 proxy-groups 时合成为「全部节点」', () => {
    const raw = `proxies:
  - {name: A, type: ss, server: a.example.com, port: 1, cipher: aes-256-gcm, password: p}
  - {name: B, type: ss, server: b.example.com, port: 2, cipher: aes-256-gcm, password: p}
`;
    const groups = parseSubscriptionPreview(raw);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('全部节点');
    expect(groups[0].nodes).toHaveLength(2);
  });

  it('坏 YAML 不应该让页面崩', () => {
    expect(parseSubscriptionPreview('this: is: not: yaml')).toEqual([]);
  });

  it('countRealNodes 不包含信息节点', () => {
    expect(countRealNodes(RAW)).toBe(2);
  });
});

describe('生成配置时清理信息节点', () => {
  it('proxies 与分组引用里都不再出现伪节点', () => {
    const out = generateConfig(RAW, DEFAULT_POLICY, {
      mixedPort: 17890,
      controllerPort: 19090,
      controllerSecret: '',
      tunEnabled: false,
      mode: 'rule',
    });
    const cfg = JSON.parse(out.config);
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(['🇯🇵 东京 01', '🇭🇰 香港 01']);
    expect(cfg['proxy-groups'][0].proxies).toEqual([
      '♻️ 自动选择',
      '🇯🇵 东京 01',
      '🇭🇰 香港 01',
    ]);
    expect(out.stats.proxyCount).toBe(2);
  });
});
