// Reading "src/auth.ts:142-146" the way a person writes it.

export interface Target { file: string; start: number | null; end: number | null }

/**
 * Splits a path from a line or range. A single-letter prefix before the colon is a Windows drive
 * letter, not a path, so "C:/work/a.ts" is left alone.
 */
export function splitTarget(target: string): Target {
  const m = /^(.*?):(\d+)(?:[-,:](\d+))?$/.exec(target);
  if (!m || (m[1].length === 1 && /[a-zA-Z]/.test(m[1]))) return { file: target, start: null, end: null };
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return { file: m[1], start, end: Math.max(start, end) };
}
