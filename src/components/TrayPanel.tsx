import { useEffect, useState } from 'react';
import { NodeName } from './NodeName';
import { api, isTauri, setMihomoBase, setMihomoSecret, type TraySnapshot } from '../core/api';
import { formatSpeed } from '../core/format';
import { Segmented, Toggle } from './ui';
import {
  IconCheck,
  IconChevronRight,
  IconChevronDown,
  IconDownload,
  IconGlobe,
  IconProfiles,
  IconOverview,
  IconPower,
  IconRefresh,
  IconSettings,
  IconTun,
  IconUpload,
} from './icons';

function stateLabel(s: TraySnapshot | null): string {
  if (!s?.running) return '未运行';
  if (s.tun) return 'TUN';
  if (s.sysProxy) return '系统代理';
  return '未接管';
}

export function TrayPanel() {
  const [snap, setSnap] = useState<TraySnapshot | null>(null);
  const [delays, setDelays] = useState<Record<string, number | null>>({});
  const [testing, setTesting] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const load = () => {
      // 面板隐藏时不做无意义轮询
      if (!document.hasFocus()) return;
      void api
        .traySnapshot()
        .then((v) => {
          if (alive) {
            setMihomoBase(v.controllerPort);
            setMihomoSecret(v.controllerSecret);
            setSnap(v);
          }
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 900);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void api.trayAction('close');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const act = (action: string, value?: string) => {
    if (action === 'sysproxy' || action === 'tun') {
      setPending(action);
      window.setTimeout(() => setPending(null), 5000);
    }
    void api.trayAction(action, value).catch(() => undefined);
  };

  const testGroup = async () => {
    if (!snap?.group || testing) return;
    setTesting(true);
    try {
      const raw: any = await api.mihomo(
        'GET',
        `/group/${encodeURIComponent(snap.group)}/delay?url=${encodeURIComponent(
          'https://www.gstatic.com/generate_204'
        )}&timeout=5000`
      );
      if (raw && typeof raw === 'object') {
        setDelays(raw as Record<string, number | null>);
      }
    } catch {
      /* 测速失败保留原延迟 */
    } finally {
      setTesting(false);
    }
  };

  const label = stateLabel(snap);
  const running = Boolean(snap?.running);

  return (
    <div className="tp-root">
      <div className="tp-card">
        <div className="tp-head">
          <span className={`tp-dot${running ? ' on' : ''}`} />
          <span className="tp-brand">PP Clash</span>
          <span className={`tp-state${snap?.tun || snap?.sysProxy ? ' active' : ''}`}>{label}</span>
          <div className="spacer" />
          <button
            type="button"
            className="tp-icon"
            title="打开主界面"
            onClick={() => act('open', 'overview')}
          >
            <IconChevronRight size={14} />
          </button>
        </div>

        <div className="tp-speeds">
          <div className="tp-speed-row">
            <span className="tp-speed-label">
              <IconUpload size={12} />
              上传
            </span>
            <b className="tp-speed-value">{formatSpeed(snap?.up ?? 0)}</b>
          </div>
          <div className="tp-speed-row">
            <span className="tp-speed-label">
              <IconDownload size={12} />
              下载
            </span>
            <b className="tp-speed-value">{formatSpeed(snap?.down ?? 0)}</b>
          </div>
        </div>

        <div className="tp-rows">
          <div className="tp-row">
            <span className="tp-row-icon">
              <IconGlobe size={14} />
            </span>
            <span className="tp-row-label">系统代理</span>
            <Toggle
              on={Boolean(snap?.sysProxy)}
              busy={pending === 'sysproxy'}
              disabled={pending !== null}
              onChange={(v) => act('sysproxy', String(v))}
              label="系统代理"
            />
          </div>
          <div className="tp-row">
            <span className="tp-row-icon">
              <IconTun size={14} />
            </span>
            <span className="tp-row-label">TUN 模式</span>
            <Toggle
              on={Boolean(snap?.tun)}
              busy={pending === 'tun'}
              disabled={pending !== null}
              onChange={() => act('tun')}
              label="TUN 模式"
            />
          </div>
        </div>

        <div className="tp-mode">
          <Segmented
            options={[
              { value: 'rule', label: '规则' },
              { value: 'global', label: '全局' },
              { value: 'direct', label: '直连' },
            ]}
            value={(snap?.mode as 'rule' | 'global' | 'direct') ?? 'rule'}
            onChange={(v) => act('mode', v)}
            ariaLabel="出站模式"
          />
        </div>

        <div className="tp-node-head">
          <button
            type="button"
            className="tp-profile-trigger"
            onClick={() => setProfilesOpen((v) => !v)}
            title="切换订阅"
          >
            <IconProfiles size={13} />
            <span className="tp-profile-name">
              {snap?.profiles.find((p) => p.id === snap.activeProfile)?.name || '选择订阅'}
            </span>
            <IconChevronDown size={11} />
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="tp-test"
            disabled={!snap?.group || testing}
            onClick={() => void testGroup()}
          >
            {testing ? '测速中' : '测速'}
          </button>
        </div>

        {profilesOpen ? (
          <div className="tp-profile-list">
            {(snap?.profiles ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                className={`tp-profile-item${p.id === snap?.activeProfile ? ' selected' : ''}`}
                onClick={() => {
                  setProfilesOpen(false);
                  act('profile', p.id);
                }}
              >
                <span className="tp-node-item-name">{p.name}</span>
                {p.id === snap?.activeProfile && <IconCheck size={12} />}
              </button>
            ))}
            {(snap?.profiles ?? []).length === 0 && (
              <div className="tp-node-empty">还没有订阅</div>
            )}
          </div>
        ) : (
          <div className="tp-node-list">
            {(snap?.nodes ?? []).slice(0, 7).map((node) => {
              const delay = delays[node.name] ?? node.delay;
              return (
                <button
                  key={node.name}
                  type="button"
                  className={`tp-node-item${node.selected ? ' selected' : ''}`}
                  onClick={() => {
                    if (snap?.group) act('node', `${snap.group}|${node.name}`);
                  }}
                >
                  <span className="tp-node-item-name"><NodeName name={node.name} /></span>
                  {node.selected ? (
                    <IconCheck size={12} />
                  ) : (
                    <span className="tp-node-item-delay">{delay ? `${delay} ms` : ''}</span>
                  )}
                </button>
              );
            })}
            {(snap?.nodes ?? []).length === 0 && (
              <div className="tp-node-empty">开启接管后显示节点</div>
            )}
          </div>
        )}

        <div className="tp-foot">
          <button type="button" onClick={() => act('open', 'settings')}>
            <IconSettings size={13} />
            设置
          </button>
          <button type="button" onClick={() => act('open', 'overview')}>
            <IconOverview size={13} />
            主界面
          </button>
          <div className="spacer" />
          <button type="button" className="tp-restart" onClick={() => act('restart')}>
            <IconRefresh size={13} />
            重启
          </button>
          <button type="button" className="tp-quit" onClick={() => act('quit')}>
            <IconPower size={13} />
            退出
          </button>
        </div>
      </div>
    </div>
  );
}
