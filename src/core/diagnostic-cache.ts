/** 只保留当前出口的结果，防止慢请求覆盖新出口、切页反复探测。 */
export class DiagnosticCache<T> {
  private key = '';
  private value: T | undefined;
  private pending: Promise<T> | undefined;
  invalidate() { this.key = ''; this.value = undefined; this.pending = undefined; }
  peek(key: string): T | undefined { return this.key === key ? this.value : undefined; }
  run(key: string, work: () => Promise<T>, force = false): Promise<T> {
    if (this.key === key) {
      if (this.pending) return this.pending;
      if (!force && this.value !== undefined) return Promise.resolve(this.value);
    } else {
      this.key = key;
      this.value = undefined;
    }
    const pending = work().then(value => {
      if (this.pending === pending) this.value = value;
      return value;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
}

/** 每次出口变化都有独立代次；A→B→A 也不能复用上一个 A 的请求。 */
export class DiagnosticEpoch {
  private route = '';
  private epoch = 0;
  update(route: string): number {
    if (route !== this.route) { this.route = route; this.epoch++; }
    return this.epoch;
  }
  isCurrent(epoch: number) { return epoch === this.epoch; }
}
