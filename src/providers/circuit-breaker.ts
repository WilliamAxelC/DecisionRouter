export interface BreakerEntrySnapshot {
  key: string;
  failures: number;
  openUntilMs: number | null;
  lastError?: string;
}

interface BreakerState {
  failures: number;
  openUntilMs: number | null;
  lastError?: string;
}

export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  constructor(
    private readonly failureThreshold: number = 2,
    private readonly cooldownSec: number = 30,
  ) {}

  private key(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  isAvailable(provider: string, model: string, nowMs = Date.now()): boolean {
    const state = this.states.get(this.key(provider, model));
    if (!state || state.openUntilMs === null) return true;
    if (nowMs >= state.openUntilMs) {
      // Cooldown elapsed: half-open reset so next request can probe
      this.states.delete(this.key(provider, model));
      return true;
    }
    return false;
  }

  recordSuccess(provider: string, model: string): void {
    this.states.delete(this.key(provider, model));
  }

  recordFailure(
    provider: string,
    model: string,
    errorMessage?: string,
    nowMs = Date.now(),
  ): void {
    const k = this.key(provider, model);
    const existing = this.states.get(k) ?? { failures: 0, openUntilMs: null };
    const failures = existing.failures + 1;
    const openUntilMs =
      failures >= this.failureThreshold
        ? nowMs + this.cooldownSec * 1000
        : existing.openUntilMs;

    this.states.set(k, {
      failures,
      openUntilMs,
      lastError: errorMessage,
    });
  }

  getSnapshot(nowMs = Date.now()): BreakerEntrySnapshot[] {
    const out: BreakerEntrySnapshot[] = [];
    for (const [key, state] of this.states.entries()) {
      if (state.openUntilMs !== null && nowMs >= state.openUntilMs) {
        this.states.delete(key);
        continue;
      }
      out.push({
        key,
        failures: state.failures,
        openUntilMs: state.openUntilMs,
        lastError: state.lastError,
      });
    }
    return out;
  }
}
