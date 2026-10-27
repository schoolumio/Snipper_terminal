import { randomUUID } from 'node:crypto';

/** Time-prefixed, lexicographically sortable identifier. */
export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${now.toString(36).padStart(9, '0')}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
