import { useEffect, useMemo, useState } from 'react';
import { NodeName } from '../components/NodeName';
import { EmptyState, navigate, Spinner, Toggle } from '../components/ui';
import {
  IconAlert,
  IconChevronRight,
  IconImport,
  IconFlag,
  IconNodes,
  IconRefresh,
  IconSearch,
  IconX,
} from '../components/icons';
import { useApp } from '../store/app';
import { countRealNodes, parseSubscriptionPreview } from '../core/subscription';
import { STABLE_EGRESS_GROUP } from '../core/generator';

function delayBadge(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return 'node-delay';
  if (ms < 100) return 'node-delay ok';
  if (ms < 200) return 'node-delay fair';
  if (ms < 400) return 'node-delay slow';
  return 'node-delay bad';
}

const OPEN_KEY = 'ppclash.proxy.groups.open';

function loadOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return {};
}

export function ProxiesPage() {
  const groups = useApp((s) => s.groups);
  const kernelPhase = useApp((s) => s.kernelPhase);
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeId);
  const selectNode = useApp((s) => s.selectNode);
  const pinnedNodes = useApp((s) => s.pinnedNodes);
  const egressGuard = useApp((s) => s.settings.egressGuard);
  const egressGuardNode = useApp((s) => s.settings.egressGuardNode);
  const togglePinNode = useApp((s) => s.togglePinNode);
  const testDelay = useApp((s) => s.testDelay);
  const refreshGroups = useApp((s) => s.refreshGroups);
  const notify = useApp((s) => s.notify);

  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'default' | 'delay' | 'name'>('default');
  const [hideUnavailable, setHideUnavailable] = useState(false);
  const [openState, setOpenState] = useState<Record<string, boolean>>(loadOpen);
  const [testing, setTesting] = useState(false);
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [testingNodes, setTestingNodes] = useState<Set<string>>(new Set());
  const [didInitOpen, setDidInitOpen] = useState(false);

  const connected = kernelPhase === 'running';
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId),
    [profiles, activeId]
  );

  const previewGroups = useMemo(
    () => parseSubscriptionPreview(activeProfile?.raw ?? ''),
    [activeProfile?.raw]
  );
  const previewNodeCount = useMemo(
    () => countRealNodes(activeProfile?.raw ?? ''),
    [activeProfile?.raw]
  );

  const usingPreview = groups.length === 0 && previewGroups.length > 0;
  const displayGroups = usingPreview ? previewGroups : groups;

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(openState));
    } catch {
      /* ignore */
    }
  }, [openState]);

  useEffect(() => {
    setDelays({});
  }, [displayGroups]);

  // 首次进入时展开第一个分组；用户手动收起后不再干预
  useEffect(() => {
    if (didInitOpen || displayGroups.length === 0) return;
    setDidInitOpen(true);
    if (Object.keys(openState).length === 0) {
      setOpenState({ [displayGroups[0].name]: true });
    }
  }, [displayGroups, didInitOpen, openState]);

  // 搜索时自动展开命中的分组
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    setOpenState((prev) => {
      const next = { ...prev };
      for (const g of displayGroups) {
        if (g.nodes.some((n) => n.name.toLowerCase().includes(q))) next[g.name] = true;
      }
      return next;
    });
  }, [query, displayGroups]);

  const visibleNodes = (groupName: string, nodes: typeof displayGroups[number]['nodes']) => {
    const q = query.trim().toLowerCase();
    let list = nodes;
    if (q) list = list.filter((n) => n.name.toLowerCase().includes(q));
    if (hideUnavailable) {
      list = list.filter((n) => {
        const ms = delays[`${groupName}|${n.name}`] ?? n.delay;
        return ms == null || ms > 0;
      });
    }
    if (sortBy === 'delay') {
      list = [...list].sort((a, b) => {
        const da = delays[`${groupName}|${a.name}`] ?? a.delay;
        const db = delays[`${groupName}|${b.name}`] ?? b.delay;
        if (da == null || da <= 0) return 1;
        if (db == null || db <= 0) return -1;
        return da - db;
      });
    } else if (sortBy === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    const pins = pinnedNodes[groupName] ?? [];
    if (pins.length > 0) {
      list = [...list].sort(
        (a, b) => Number(!pins.includes(a.name)) - Number(!pins.includes(b.name))
      );
    }
    return list;
  };

  const runTest = async (targets: Array<{ group: string; node: string }>) => {
    if (testing || !connected || targets.length === 0) return;
    setTesting(true);
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const key = `${item.group}|${item.node}`;
        setTestingNodes((prev) => new Set(prev).add(key));
        const d = await testDelay(item.node);
        setDelays((prev) => ({ ...prev, [key]: d }));
        setTestingNodes((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    setTesting(false);
    notify('info', '测速完成');
  };

  const testGroup = (groupName: string, nodes: typeof displayGroups[number]['nodes']) => {
    void runTest(
      visibleNodes(groupName, nodes).map((n) => ({ group: groupName, node: n.name }))
    );
  };

  const toggleGroup = (name: string) =>
    setOpenState((prev) => ({ ...prev, [name]: !prev[name] }));

  const filteredGroups = displayGroups
    .map((g) => ({ g, nodes: visibleNodes(g.name, g.nodes) }))
    .filter((x) => !query.trim() || x.nodes.length > 0);

  const subTitle = (() => {
    if (profiles.length === 0) return '导入订阅后显示节点';
    if (usingPreview)
      return `${displayGroups.length} 个分组 · 订阅预览（${previewNodeCount} 个节点）`;
    if (!connected) return '未接管';
    if (!displayGroups.length) return '暂无分组';
    return `${displayGroups.length} 个分组`;
  })();

  const emptyView = (() => {
    if (profiles.length === 0) {
      return {
        icon: <IconImport size={19} />,
        title: '还没有订阅',
        desc: '导入订阅后显示节点。',
        action: (
          <button type="button" className="btn btn-primary" onClick={() => navigate('profiles')}>
            导入订阅
          </button>
        ),
      };
    }
    if (!connected) {
      return {
        icon: <IconNodes size={19} />,
        title: '内核未运行',
        desc: '未接管流量。',
        action: (
          <button type="button" className="btn btn-primary" onClick={() => navigate('overview')}>
            去概览开启
          </button>
        ),
      };
    }
    return {
      icon: <IconAlert size={19} />,
      title: '没有读到节点',
      desc: '内核没有返回节点分组。',
      action: (
        <button type="button" className="btn" onClick={() => void refreshGroups(false)}>
          刷新
        </button>
      ),
    };
  })();

  return (
    <>
      <header className="page-head">
        <div className="page-heading">
          <h1 className="page-title">节点</h1>
          <div className="page-sub">{subTitle}</div>
        </div>
        <div className="page-actions proxy-head-tools">
          <div className="node-search">
            <IconSearch size={12} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索节点"
              aria-label="搜索节点"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="node-search-clear"
                aria-label="清空搜索"
                onClick={() => setQuery('')}
              >
                <IconX size={11} />
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 7 }}>
            <span className="card-hint">仅显示可用</span>
            <Toggle
              on={hideUnavailable}
              onChange={setHideUnavailable}
              label="仅显示可用节点"
            />
          </div>
          <div className="seg" role="group" aria-label="排序方式">
            {(
              [
                ['default', '默认'],
                ['delay', '延迟'],
                ['name', '名称'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`seg-btn${sortBy === value ? ' active' : ''}`}
                onClick={() => setSortBy(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn"
            title="刷新节点"
            aria-label="刷新节点"
            disabled={!connected}
            onClick={() => void refreshGroups(false)}
          >
            <IconRefresh size={15} />
          </button>
        </div>
      </header>

      <div className="page-scroll">
        <div className="page-inner">
          {displayGroups.length === 0 ? (
            <section className="card">
              <EmptyState {...emptyView} />
            </section>
          ) : (
            <>
              <div className="proxy-groups">
                {filteredGroups.map(({ g, nodes }) => {
                  const isOpen = openState[g.name] ?? false;
                  const groupTesting = nodes.some((n) => testingNodes.has(`${g.name}|${n.name}`));
                  const current = g.now;
                  return (
                    <section key={g.name} className="card proxy-group">
                      <div
                        className="proxy-group-head"
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleGroup(g.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleGroup(g.name);
                          }
                        }}
                      >
                        <span className={`proxy-chevron${isOpen ? ' open' : ''}`}>
                          <IconChevronRight size={12} />
                        </span>
                        <span className="proxy-group-name">{g.name}</span>
                        {g.type && <span className="tag">{g.type}</span>}
                        <span className="proxy-group-meta">
                          {current || '未选择节点'}
                          <span className="proxy-group-count">{g.nodes.length}</span>
                        </span>
                        <div className="proxy-group-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={!connected || testing}
                            onClick={(e) => {
                              e.stopPropagation();
                              testGroup(g.name, g.nodes);
                            }}
                          >
                            {groupTesting ? <Spinner small /> : '测速'}
                          </button>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="proxy-node-grid">
                          {nodes.map((node) => {
                            const key = `${g.name}|${node.name}`;
                            const ms = delays[key] ?? node.delay;
                            const selected = !usingPreview && g.now === node.name;
                            const fixedEgress =
                              egressGuard &&
                              g.name === STABLE_EGRESS_GROUP &&
                              egressGuardNode === node.name;
                            const busy = testingNodes.has(key);
                            return (
                              <div
                                key={node.name}
                                role="button"
                                tabIndex={0}
                                className={`proxy-node${selected ? ' selected' : ''}${
                                  pinnedNodes[g.name]?.includes(node.name) ? ' pinned' : ''
                                }`}
                                onDoubleClick={(e) => {
                                  e.preventDefault();
                                  togglePinNode(g.name, node.name);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    if (!connected) {
                                      notify('info', '先开启接管');
                                      return;
                                    }
                                    void selectNode(g.name, node.name);
                                  }
                                }}
                                onClick={() => {
                                  if (!connected) {
                                    notify('info', '先开启接管');
                                    return;
                                  }
                                  void selectNode(g.name, node.name);
                                }}
                              >
                                <span className="proxy-node-name"><NodeName name={node.name} /></span>
                                {g.name === STABLE_EGRESS_GROUP ? (
                                  <span
                                    className={`node-pin fixed${fixedEgress ? ' pinned' : ''}`}
                                    title={
                                      fixedEgress
                                        ? '当前 GitHub 固定出口'
                                        : '点击节点切换 GitHub 固定出口'
                                    }
                                  >
                                    <IconFlag size={11} filled={fixedEgress} />
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className={`node-pin${
                                      pinnedNodes[g.name]?.includes(node.name) ? ' pinned' : ''
                                    }`}
                                    aria-label={
                                      pinnedNodes[g.name]?.includes(node.name)
                                        ? '取消固定'
                                        : '固定节点'
                                    }
                                    title={
                                      pinnedNodes[g.name]?.includes(node.name)
                                        ? '取消固定（也可双击节点）'
                                        : '固定节点（也可双击节点）'
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      togglePinNode(g.name, node.name);
                                    }}
                                  >
                                    <IconFlag
                                      size={11}
                                      filled={pinnedNodes[g.name]?.includes(node.name)}
                                    />
                                  </button>
                                )}
                                {busy ? (
                                  <span className="node-delay">
                                    <Spinner small />
                                  </span>
                                ) : (
                                  <span className={delayBadge(ms)}>
                                    {ms != null && ms > 0 ? `${ms} ms` : '—'}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>

            </>
          )}
        </div>
      </div>
    </>
  );
}
