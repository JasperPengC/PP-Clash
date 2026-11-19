import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveActiveNode } from '../core/active-node';
import { groupLatencyTarget, normalizeLatency } from '../core/latency';
import { useWindowVisible } from '../core/window-activity';
import { primaryRoutingGroup, resolveEffectiveGroup, useApp } from '../store/app';

/** 挂载在移动端外壳中，切换页面不重置测速，也不重复发起请求。 */
export function useCurrentNodeLatency() {
  const phase = useApp(s => s.kernelPhase);
  const groups = useApp(s => s.groups);
  const profiles = useApp(s => s.profiles);
  const activeId = useApp(s => s.activeId);
  const settings = useApp(s => s.settings);
  const routing = useApp(s => s.routing);
  const connectedAt = useApp(s => s.connectedAt);
  const revision = useApp(s => s.runtimeConfigRevision);
  const transitioning = useApp(s => s.runtimeConfigTransition);
  const testDelay = useApp(s => s.testDelay);
  const notify = useApp(s => s.notify);
  const visible = useWindowVisible();
  const primary = phase === 'running' ? primaryRoutingGroup({ groups, profiles, activeId, settings, routing }) : undefined;
  const routingGroups = primary?.name === 'GLOBAL' ? [primary, ...groups] : groups;
  const group = primary ? resolveEffectiveGroup(routingGroups, primary.name) : undefined;
  const node = settings.mode === 'direct' ? 'DIRECT' : primary ? resolveActiveNode(routingGroups, primary.now ?? '') : '';
  const activeNode = group?.nodes.find(item => item.name === node);
  const terminal = node === 'DIRECT' || node === 'REJECT' || node === 'REJECT-DROP';
  const canTest = phase === 'running' && !transitioning && !terminal && !!activeNode
    && !routingGroups.some(item => item.name === node);
  const target = groupLatencyTarget(group?.name ?? '');
  const key = JSON.stringify([activeId, connectedAt, revision, transitioning, settings.mode, group?.name, node, phase]);
  const currentKey = useRef(key);
  const mounted = useRef(false);
  const generation = useRef(0);
  const request = useRef<symbol | null>(null);
  const attempted = useRef('');
  const [testing, setTesting] = useState(false);
  const [measurement, setMeasurement] = useState<{ key: string; epoch: number; delay: number | null } | null>(null);
  if (currentKey.current !== key) {
    currentKey.current = key;
    generation.current++;
    attempted.current = '';
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  const measure = useCallback(async (manual = true) => {
    if (!canTest || request.current) return;
    const id = Symbol();
    const epoch = generation.current;
    request.current = id;
    attempted.current = key;
    const isCurrent = () => mounted.current && currentKey.current === key && generation.current === epoch;
    setTesting(true);
    try {
      const delay = await testDelay(node, target, { isCurrent });
      if (!isCurrent()) return;
      setMeasurement({ key, epoch, delay });
      if (manual) notify(delay === null ? 'error' : 'success', delay === null
        ? `节点测速失败：${node}` : `${node} · ${delay} ms`);
    } finally {
      if (request.current === id) {
        request.current = null;
        if (mounted.current) setTesting(false);
      }
    }
  }, [canTest, key, node, target, testDelay, notify]);

  useEffect(() => {
    if (!visible || !canTest || testing || attempted.current === key) return;
    // 等待切换稳定；快速连续选择时只测最后一个生效节点。
    const timer = window.setTimeout(() => void measure(false), 420);
    return () => window.clearTimeout(timer);
  }, [visible, canTest, testing, key, measure]);

  const measured = measurement?.key === key && measurement.epoch === generation.current ? measurement : null;
  return {
    group, node, terminal, canTest, testing, measure,
    failed: measured?.delay === null,
    delay: canTest ? measured ? measured.delay : normalizeLatency(activeNode?.delay) : null,
  };
}
