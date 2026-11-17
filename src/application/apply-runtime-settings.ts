import type { AppSettings, KernelPhase } from '../domain/app';

interface RuntimeSettingsPort {
  read(): { settings: AppSettings; kernelPhase: KernelPhase; hasProfile: boolean };
  token(): number;
  current(token: number): boolean;
  update(patch: Partial<AppSettings>): void;
  invalidate(): void;
  apply(): Promise<boolean>;
  restart(token: number): Promise<boolean>;
}
export interface SettingsApplicationOptions {
  allowWithoutProfile?: boolean;
  allowRunningWithoutProfile?: boolean;
  rollback?: { config?: boolean; restart?: 'always' | 'if-running'; exception?: boolean };
}
export type SettingsApplicationResult =
  | { status: 'applied' | 'saved' | 'deferred' | 'stale' }
  | { status: 'failed'; stage: 'config' | 'restart' | 'exception'; error: unknown; rolledBack: boolean; running: boolean };

/** 统一提交顺序与过期保护；保留不同设置入口明确选择的失败策略。 */
export function createSettingsApplication(port: RuntimeSettingsPort) {
  let queue: Promise<unknown> = Promise.resolve();
  return (patch: Partial<AppSettings>, options: SettingsApplicationOptions = {}): Promise<SettingsApplicationResult> => {
    // 入队时捕获生命周期；排队期间退出或恢复会话后不能重新写入旧意图。
    const token = port.token();
    const run = queue.then(async (): Promise<SettingsApplicationResult> => {
      const current = () => port.current(token);
      if (!current()) return { status: 'stale' };
      // 事务串行修改设置；后发意图必须以先发提交或回滚后的状态作为基线。
      const previous = Object.fromEntries(Object.keys(patch).map(key => [key, port.read().settings[key as keyof AppSettings]]));
      const fail = (stage: 'config' | 'restart' | 'exception', error: unknown): SettingsApplicationResult => {
        if (!current()) return { status: 'stale' };
        const running = port.read().kernelPhase === 'running';
        const policy = options.rollback?.[stage];
        const rolledBack = policy === true || policy === 'always' || (policy === 'if-running' && running);
        if (rolledBack) { port.update(previous); port.invalidate(); }
        return { status: 'failed', stage, error, rolledBack, running };
      };
      try {
        port.update(patch);
        const state = port.read();
        if (!state.hasProfile && !options.allowWithoutProfile && !(options.allowRunningWithoutProfile && state.kernelPhase === 'running')) return { status: 'deferred' };
        const applied = await port.apply();
        if (!current()) return { status: 'stale' };
        if (!applied) return fail('config', new Error('配置生成失败'));
        if (port.read().kernelPhase !== 'running') return { status: 'saved' };
        const restarted = await port.restart(token);
        if (!current()) return { status: 'stale' };
        if (!restarted) return fail('restart', new Error('内核重启失败'));
        return { status: 'applied' };
      } catch (error) { return fail('exception', error); }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}
