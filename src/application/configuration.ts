import type { AppSettings, Profile, ProxyGroup } from '../domain/app';
import type { RuleEditState } from '../domain/rules';
import type { SecurityPolicy } from '../core/security';
import { resolveActiveNode } from '../core/active-node';
import { generateConfig } from '../core/generator';
import { api, DATA_DIR } from '../core/api';

interface ConfigurationState {
  activeId: string | null;
  profiles: Profile[];
  policy: SecurityPolicy;
  settings: AppSettings;
  tunEnabled: boolean;
  groups: ProxyGroup[];
  fixedNodes: Record<string, Record<string, string>>;
  selectedNodes: Record<string, Record<string, string>>;
}

export const runtimeOf = (s: ConfigurationState) => ({
  stableRouting: s.settings.stableRouting,
  mixedPort: s.settings.mixedPort,
  controllerPort: s.settings.controllerPort,
  controllerSecret: s.settings.controllerSecret,
  tunEnabled: s.tunEnabled,
  mode: s.settings.mode,
  allowLan: s.settings.allowLan,
  dnsPort: s.settings.dnsPort,
  socksPort: s.settings.socksPort,
  httpPort: s.settings.httpPort,
  redirPort: s.settings.redirPort,
  bindAddress: s.settings.bindAddress,
  authUser: s.settings.authUser,
  authPass: s.settings.authPass,
  dnsNameserver: s.settings.dnsNameserver,
  dnsCustom: s.settings.dnsCustom,
  geoDataMode: s.settings.geoDataMode,
  geoAutoUpdate: s.settings.geoAutoUpdate,
  geoUpdateInterval: s.settings.geoUpdateInterval,
  geoUrls: s.settings.geoUrls,
  snifferEnabled: s.settings.snifferEnabled,
  snifferOverrideDestination: s.settings.snifferOverrideDestination,
  customRules: s.settings.customRules,
  currentNode: resolveActiveNode(s.groups, s.groups[0]?.now ?? ''),
  fixedNodes: s.fixedNodes[s.activeId ?? ''] ?? {},
  selectedNodes: s.selectedNodes[s.activeId ?? ''] ?? {},
});

export const overrideOf = (s: ConfigurationState) =>
  s.settings.overrides
    .filter((o) => o.enabled)
    .map((o) => ({ mode: o.mode, text: o.text, name: o.name }));

export interface ConfigInputs {
  activeId: string;
  raw: string;
  policy: SecurityPolicy;
  runtime: ReturnType<typeof runtimeOf>;
  overrides: ReturnType<typeof overrideOf>;
  ruleEdits?: RuleEditState;
  kernelPath: string;
}

/** 只纳入生成/启动依赖，外观及订阅展示元数据不使候选过期。 */
export function configurationInputs(s: ConfigurationState, preparedInputs: ConfigInputs | null = null): ConfigInputs | null {
  const profile = s.profiles.find(p => p.id === s.activeId);
  if (!profile) return null;
  const inputs: ConfigInputs = {
    activeId: profile.id, raw: profile.raw, policy: s.policy, runtime: runtimeOf(s),
    overrides: overrideOf(s), ruleEdits: profile.ruleEdits, kernelPath: s.settings.kernelPath,
  };
  const needsNode = inputs.runtime.customRules.some(rule => rule.enabled && rule.target === '__CURRENT__')
    || inputs.overrides.some(override => override.text.includes('{{CURRENT_NODE}}'));
  if (!needsNode) inputs.runtime.currentNode = '';
  else if (!s.groups.length && preparedInputs) {
    // 停机只清空观测分组；相同订阅和路由输入保留已解析节点，避免重启时变成 DIRECT。
    const withoutNode = (value: ConfigInputs) => JSON.stringify({ ...value, runtime: { ...value.runtime, currentNode: '' } });
    if (withoutNode(inputs) === withoutNode(preparedInputs)) inputs.runtime.currentNode = preparedInputs.runtime.currentNode;
  }
  return inputs;
}

export async function prepareConfigCandidate(inputs: ConfigInputs, current: () => boolean) {
  let candidate: string | undefined;
  try {
    const generated = await generateConfig(inputs.raw, inputs.policy, inputs.runtime, inputs.overrides, inputs.ruleEdits);
    if (!current()) return null;
    candidate = await api.prepareConfig(generated.config, DATA_DIR);
    if (!current()) return null;
    const sep = candidate.includes('\\') ? '\\' : '/';
    const absDir = candidate.slice(0, candidate.lastIndexOf(sep));
    await api.validateConfig(candidate, absDir);
    if (!current()) return null;
    const prepared = { ...generated, candidate, absDir };
    candidate = undefined;
    return prepared;
  } finally {
    if (candidate) await api.discardConfig(candidate).catch(() => undefined);
  }
}
