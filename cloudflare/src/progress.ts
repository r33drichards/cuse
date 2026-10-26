/** Only coalesces in-flight model text; final output and tool commits stay immediate. */
export const DEFAULT_PARTIAL_SAVE_INTERVAL_MS = 1000;
export const MAX_PARTIAL_SAVE_INTERVAL_MS = 60000;

export function partialSaveIntervalMs(value?: string | number): number {
  if (value === undefined) return DEFAULT_PARTIAL_SAVE_INTERVAL_MS;
  const interval = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > MAX_PARTIAL_SAVE_INTERVAL_MS) {
    throw new Error('CUSE_PARTIAL_SAVE_INTERVAL_MS must be an integer from 1 to 60000');
  }
  return interval;
}
