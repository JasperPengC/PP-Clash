import { emit, listen } from '@tauri-apps/api/event';

const CHANGED = 'runtime-display://changed';
const REQUEST = 'runtime-display://request';
const RESPONSE = 'runtime-display://response';
const session = crypto.randomUUID();
let sequence = 0;

interface Snapshot { session: string; sequence: number; transitioning: boolean }
export interface RuntimeDisplayStatus { revision: string; transitioning: boolean }
const valid = (value: unknown): value is Snapshot => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Snapshot;
  return typeof v.session === 'string' && v.session.length > 0 && Number.isSafeInteger(v.sequence)
    && v.sequence >= 0 && typeof v.transitioning === 'boolean';
};

/** 主窗口只广播代次，不广播配置、控制密钥或节点。状态变化先失效，提交后再读取。 */
export function installRuntimeDisplayPublisher(
  read: () => { key: string; transitioning: boolean },
  subscribe: (changed: () => void) => () => void,
): () => void {
  let alive = true;
  let previous = read();
  let current: Snapshot = { session, sequence: ++sequence, transitioning: previous.transitioning };
  let disposeRequest: (() => void) | undefined;
  const send = (name: string, payload: unknown) => {
    if (alive) void emit(name, payload).catch(() => {});
  };
  const disposeStore = subscribe(() => {
    const next = read();
    if (next.key === previous.key && next.transitioning === previous.transitioning) return;
    previous = next;
    current = { session, sequence: ++sequence, transitioning: next.transitioning };
    send(CHANGED, current);
  });
  void listen<unknown>(REQUEST, ({ payload }) => {
    if (typeof payload === 'string') send(RESPONSE, { request: payload, snapshot: current });
  }).then(dispose => {
    if (!alive) { dispose(); return; }
    disposeRequest = dispose;
    send(CHANGED, current);
  }).catch(() => {});
  return () => { alive = false; disposeStore(); disposeRequest?.(); };
}

/** 新窗口和主窗口重载均先握手；迟到的旧会话/低代次消息不能解除配置切换状态。 */
export function subscribeRuntimeDisplayStatus(receive: (status: RuntimeDisplayStatus) => void): () => void {
  let alive = true;
  let current: Snapshot | null = null;
  let request: string | null = null;
  const pendingSnapshots = new Map<string, Snapshot>();
  const disposers: Array<() => void> = [];
  const apply = (snapshot: Snapshot) => {
    current = snapshot;
    receive({ revision: `${snapshot.session}:${snapshot.sequence}`, transitioning: snapshot.transitioning });
  };
  const ask = () => {
    request = crypto.randomUUID();
    receive({ revision: request, transitioning: true });
    void emit(REQUEST, request).catch(() => {});
  };
  const registrations = [
    listen<unknown>(CHANGED, ({ payload }) => {
      if (!alive || !valid(payload)) return;
      const previous = pendingSnapshots.get(payload.session);
      if (!previous || payload.sequence > previous.sequence) pendingSnapshots.set(payload.session, payload);
      if (pendingSnapshots.size > 4) pendingSnapshots.delete(pendingSnapshots.keys().next().value!);
      if (!current || payload.session !== current.session) {
        ask();
        return;
      }
      if (!request && payload.sequence > current.sequence) apply(payload);
    }),
    listen<{ request?: unknown; snapshot?: unknown }>(RESPONSE, ({ payload }) => {
      if (!alive || !payload || typeof payload !== 'object' || payload.request !== request || !valid(payload.snapshot)) return;
      const buffered = pendingSnapshots.get(payload.snapshot.session);
      const next = buffered && buffered.sequence > payload.snapshot.sequence ? buffered : payload.snapshot;
      if (current?.session === next.session && next.sequence < current.sequence) return;
      request = null;
      apply(next);
    }),
  ];
  void Promise.all(registrations.map(promise => promise.then(dispose => {
    if (!alive) dispose(); else disposers.push(dispose);
  }))).then(() => { if (alive) ask(); }).catch(() => {});
  return () => { alive = false; disposers.forEach(dispose => dispose()); };
}
