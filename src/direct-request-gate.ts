/** One active direct request, at most 30 starts per minute across all tabs/providers. */
export class DirectRequestGate {
  private active = false;
  private accepted: number[];
  constructor(previous: unknown = []) {
    this.accepted = Array.isArray(previous) ? previous.filter(time => Number.isSafeInteger(time) && time > 0).slice(-30) : [];
  }
  claim(now = Date.now()): () => void {
    if (this.active) throw new Error('An AI request is still finishing. Wait before starting another question.');
    this.accepted = this.accepted.filter(time => now - time < 60_000);
    if (this.accepted.length >= 30) throw new Error('The local request budget is exhausted. Wait a minute before trying again.');
    this.accepted.push(now);
    this.active = true;
    return () => { this.active = false; };
  }
  serialize(): number[] { return [...this.accepted]; }
}
