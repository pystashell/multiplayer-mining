/** Admission budgets run before work enters the room's serial queue. */
export class MessageBudget {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  take(key: string, now: number, burst: number, perSecond: number): boolean {
    // Idle entries never need to survive beyond a full refill.
    for (const [id, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 60_000) this.buckets.delete(id);
    }
    const previous = this.buckets.get(key);
    const tokens = previous
      ? Math.min(burst, previous.tokens + Math.max(0, now - previous.updatedAt) * perSecond / 1_000)
      : burst;
    this.buckets.set(key, { tokens: tokens >= 1 ? tokens - 1 : tokens, updatedAt: now });
    return tokens >= 1;
  }
}
