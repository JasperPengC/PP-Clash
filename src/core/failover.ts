export const CHECK_INTERVAL = 120_000;
export const SWITCH_COOLDOWN = 600_000;
export type HealthResult = Record<string, boolean | null>;

/** 仅统计同一出口、连续且间隔正常的确定失败。null 表示控制器/检测异常。 */
export class FailoverGuard {
  private key = '';
  private lastCheck: number | undefined;
  private cooldownUntil = 0;
  private failures: Record<string, number> = {};
  switched(now: number) {
    this.cooldownUntil = now + SWITCH_COOLDOWN;
    this.reset();
  }
  reset() { this.key = ''; this.lastCheck = undefined; this.failures = {}; }
  observe(key: string, result: HealthResult, now: number): boolean {
    if (now < this.cooldownUntil) { this.reset(); return false; }
    if (key !== this.key || (this.lastCheck !== undefined && now - this.lastCheck > CHECK_INTERVAL * 2)) {
      this.reset();
      this.key = key;
    }
    if (this.lastCheck !== undefined && now - this.lastCheck < CHECK_INTERVAL * .9) return false;
    this.lastCheck = now;
    for (const id of new Set([...Object.keys(this.failures), ...Object.keys(result)])) {
      this.failures[id] = result[id] === false ? (this.failures[id] ?? 0) + 1 : 0;
    }
    return Object.values(this.failures).filter(count => count >= 3).length >= 2;
  }
}

export interface FailoverTarget { key: string; node: string; candidates: string[] }
interface FailoverAdapter {
  target: () => FailoverTarget | null;
  now: () => number;
  probe: (node: string) => Promise<HealthResult>;
  switchTo: (node: string, original: FailoverTarget) => Promise<void>;
}

export class FailoverCoordinator {
  private busy = false;
  private guard = new FailoverGuard();
  private candidateCursor = 0;
  private candidateRoute = '';
  constructor(private adapter: FailoverAdapter) {}
  async check() {
    if (this.busy) return;
    const target = this.adapter.target();
    if (!target) { this.guard.reset(); return; }
    const started = this.adapter.now();
    const stillCurrent = () => {
      const age = this.adapter.now() - started;
      const valid = age >= 0 && age <= 45_000 && this.adapter.target()?.key === target.key;
      if (!valid) this.guard.reset();
      return valid;
    };
    this.busy = true;
    try {
      const health = await this.adapter.probe(target.node);
      if (!stillCurrent()) { this.guard.reset(); return; }
      if (!this.guard.observe(target.key, health, this.adapter.now())) return;
      if (this.candidateRoute !== target.key) { this.candidateRoute = target.key; this.candidateCursor = 0; }
      const candidates = [...new Set(target.candidates)].filter(n => n !== target.node);
      const batch = Array.from({ length: Math.min(3, candidates.length) }, (_, i) => candidates[(this.candidateCursor + i) % candidates.length]);
      this.candidateCursor = candidates.length ? (this.candidateCursor + batch.length) % candidates.length : 0;
      for (const candidate of batch) {
        if (!stillCurrent()) return;
        const result = await this.adapter.probe(candidate);
        if (!stillCurrent()) return;
        const outcomes = Object.values(result);
        if (outcomes.length < 2 || !outcomes.every(v => v === true)) continue;
        await this.adapter.switchTo(candidate, target);
        this.guard.switched(this.adapter.now());
        return;
      }
      // 备用出口也不可用时保持原节点，下一轮重新累计，避免持续扫节点。
      this.guard.reset();
    } catch {
      this.guard.reset();
    } finally { this.busy = false; }
  }
}
