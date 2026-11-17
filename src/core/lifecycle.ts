/** 用户的新意图使旧异步工作失效；已发出的系统操作仍串行收尾。 */
export class Lifecycle {
  private generation = 0;
  private effects: Promise<unknown> = Promise.resolve();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  begin(): number {
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    return this.generation;
  }

  token(): number { return this.generation; }
  current(token: number): boolean { return token === this.generation; }

  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.effects.then(operation);
    this.effects = result.catch(() => undefined);
    return result;
  }

  schedule(token: number, delay: number, operation: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.current(token)) operation();
    }, delay);
    this.timers.add(timer);
  }
}
