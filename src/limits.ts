import { z } from 'zod';
import { DatabaseError } from './errors.js';

export const runtimeLimits = z.object({
  maxConcurrentQueries: z.number().int().min(1).max(40).default(8),
  maxQueriesPerConnection: z.number().int().min(1).max(8).default(2),
  maxPendingMutations: z.number().int().min(1).max(128).default(32),
});
export type RuntimeLimits = z.infer<typeof runtimeLimits>;

/** Reject overload before secret lookup or driver allocation; never retain a waiting query. */
export class QueryCapacity {
  private used = 0;
  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError('Invalid capacity');
  }
  acquire(): () => void {
    if (this.used >= this.maximum)
      throw new DatabaseError('BUSY', '数据库查询并发已达上限，请等待现有查询结束后重试。');
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
    };
  }
}
