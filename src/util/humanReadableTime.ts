/*
 * humanReadableTime — format an absolute timestamp as a short, friendly date/time.
 *
 * Unlike a purely relative "3 days ago" (see `relativeTime`), this keeps the real
 * date so a list of items stays scannable while still reading naturally for recent
 * ones: today/yesterday show just the clock time, anything else shows the date (the
 * year only once it differs from now). Month names and 24-hour times are formatted
 * by hand rather than via `Intl`/locale so the output is deterministic and testable.
 *
 * The reference "now" is injectable for tests; callers pass a UNIX timestamp in
 * milliseconds, matching `relativeTime`.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Format `epochMs` as `HH:MM` (today), `Yesterday HH:MM`, `D Mon HH:MM` (this
 *  year), or `D Mon YYYY` (older). `now` defaults to the current time. */
export function humanReadableTime(epochMs: number, now: number = Date.now()): string {
  const date = new Date(epochMs);
  const today = new Date(now);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

  if (isSameDay(date, today)) return time;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(date, yesterday)) return `Yesterday ${time}`;

  const day = date.getDate();
  const month = MONTHS[date.getMonth()];
  if (date.getFullYear() === today.getFullYear()) return `${day} ${month} ${time}`;
  return `${day} ${month} ${date.getFullYear()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
