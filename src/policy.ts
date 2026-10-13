import { z } from 'zod';
import { DatabaseError } from './errors.js';

export const accessPolicy = z
  .object({
    mode: z.enum(['query', 'metadata']).default('query'),
    access: z.enum(['host', 'sessions']).default('host'),
    sessionIds: z.array(z.string().min(1).max(200)).max(20).default([]),
    callsPerMinute: z.number().int().min(1).max(600).default(60),
    callsPerHour: z.number().int().min(1).max(10000).default(1000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.access === 'sessions' && !value.sessionIds.length)
      ctx.addIssue({ code: 'custom', path: ['sessionIds'], message: '请选择至少一个授权会话。' });
  });
export type AccessPolicy = z.infer<typeof accessPolicy>;
export const effectivePolicy = (policy?: AccessPolicy) => ({
  ...accessPolicy.parse(policy ?? {}),
  usesDefaultPolicy: !policy,
});

/** Fixed windows belong to a trusted owner, shared by all descendants and both tools. */
export class OwnerBudgets {
  private windows = new Map<
    string,
    { minute: number; hour: number; short: number; long: number }
  >();
  take(owner: string, policy: AccessPolicy, now = Date.now()): void {
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);
    for (const [key, value] of this.windows) if (value.hour !== hour) this.windows.delete(key);
    let value = this.windows.get(owner);
    if (!value) {
      if (this.windows.size >= 2000)
        throw new DatabaseError('BUSY', '调用者额度记录已达上限，请稍后重试。');
      value = { minute, hour, short: 0, long: 0 };
      this.windows.set(owner, value);
    }
    if (value.minute !== minute) {
      value.minute = minute;
      value.short = 0;
    }
    if (value.short >= policy.callsPerMinute || value.long >= policy.callsPerHour)
      throw new DatabaseError(
        'RATE_LIMITED',
        '此会话及其子 Agent 的调用额度已用完，请在下一个额度窗口重试。',
      );
    value.short++;
    value.long++;
  }
}
