/** The independent settlement queues within a pool. */
export const FAMILIES = ['swap', 'deposit', 'withdraw'] as const;
export type Family = (typeof FAMILIES)[number];
