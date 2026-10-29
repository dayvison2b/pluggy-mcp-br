const SAO_PAULO = 'America/Sao_Paulo';

export function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const MIDNIGHT_UTC = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/;

export function transactionDay(value: string): string {
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly?.[1]) return dateOnly[1];
  const midnight = MIDNIGHT_UTC.exec(trimmed);
  if (midnight?.[1]) return midnight[1];
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return saoPauloDay(parsed);
  return trimmed.slice(0, 10);
}

export function saoPauloDay(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('Could not read the date in America/Sao_Paulo.');
  return `${year}-${month}-${day}`;
}

export function calendarDaysBetween(from: string, to: string): number {
  if (!isCalendarDay(from) || !isCalendarDay(to)) throw new Error('Invalid date.');
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function addCalendarDays(day: string, amount: number): string {
  if (!isCalendarDay(day) || !Number.isInteger(amount)) throw new Error('Invalid date.');
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const date = new Date(Date.UTC(year!, (month ?? 1) - 1, (dayOfMonth ?? 1) + amount));
  return date.toISOString().slice(0, 10);
}

export function endOfMonth(day: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
  if (!match || !isCalendarDay(day)) throw new Error('Invalid date.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(last).padStart(2, '0')}`;
}

export function monthPeriod(id: string): { id: string; from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(id);
  if (!match || !isCalendarDay(`${id}-01`)) throw new Error('Use YYYY-MM.');
  const normalized = `${match[1]}-${match[2]}`;
  return { id: normalized, from: `${normalized}-01`, to: endOfMonth(`${normalized}-01`) };
}

export function previousMonthId(id: string): string {
  const current = monthPeriod(id);
  const year = Number(current.id.slice(0, 4));
  const month = Number(current.id.slice(5, 7));
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function spendPeriod(today: string, days?: number): { days: number; start: string; end: string } {
  if (!isCalendarDay(today)) throw new Error('Invalid date.');
  if (days === undefined) {
    const end = endOfMonth(today);
    return { days: calendarDaysBetween(today, end) + 1, start: today, end };
  }
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('Provide days as an integer from 1 to 366.');
  }
  return { days, start: today, end: addCalendarDays(today, days - 1) };
}
