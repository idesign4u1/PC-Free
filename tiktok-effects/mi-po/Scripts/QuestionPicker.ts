/**
 * Random question picker with a short "recently shown" history.
 *
 * - Never returns the same question twice in a row.
 * - Avoids the last `historySize` questions whenever the pool is big enough.
 */
export type RandomFn = () => number;

export class QuestionPicker<T> {
  private readonly recent: number[] = [];
  private readonly historySize: number;

  constructor(
    private readonly items: readonly T[],
    historySize = 5,
    private readonly random: RandomFn = Math.random,
  ) {
    if (items.length === 0) {
      throw new Error('QuestionPicker: question list is empty');
    }
    // Keep at least one candidate available (and "no repeat in a row" when possible).
    this.historySize = Math.max(0, Math.min(historySize, items.length - 1));
  }

  /** Returns the next random item. */
  next(): T {
    return this.items[this.nextIndex()];
  }

  /** Returns the index of the next random item (useful for tests). */
  nextIndex(): number {
    const candidates: number[] = [];
    for (let i = 0; i < this.items.length; i++) {
      if (this.recent.indexOf(i) === -1) candidates.push(i);
    }
    const pick = candidates[Math.floor(this.random() * candidates.length) % candidates.length];

    this.recent.push(pick);
    while (this.recent.length > this.historySize) this.recent.shift();
    return pick;
  }
}
