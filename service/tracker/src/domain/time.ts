import type { Day, Instant } from "#src/domain/model.ts";

// Время в системе — московское. Пояс фиксированный UTC+3 без перехода на летнее время, поэтому
// весь пересчёт сводится к сдвигу на три часа: тянуть Intl/IANA-базу ради этого незачем, а
// арифметика на UTC-миллисекундах не зависит от часового пояса машины, где крутится сервер.

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Календарный день по Москве для момента времени (по умолчанию — сейчас). */
export function moscowDay(at: Date = new Date()): Day {
  return new Date(at.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

/** Время суток по Москве, `HH:MM`. */
export function moscowTime(at: Date = new Date()): string {
  return new Date(at.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(11, 16);
}

/** Минуты от полуночи по Москве — удобно сравнивать с расписанием прогонов. */
export function moscowMinutes(at: Date = new Date()): number {
  const shifted = new Date(at.getTime() + MOSCOW_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Момент времени из московских календарных значений: `("2026-07-25", "08:00")` → инстант UTC. */
export function instantOf(day: Day, time = "00:00"): Instant {
  const ms = Date.parse(`${day}T${time}:00.000Z`) - MOSCOW_OFFSET_MS;
  return new Date(ms).toISOString();
}

/** Сдвиг дня на `n` суток (может быть отрицательным). */
export function addDays(day: Day, n: number): Day {
  const ms = Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Сколько суток от `from` до `to` (отрицательно, если `to` раньше). */
export function daysBetween(from: Day, to: Day): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

/** Понедельник недели, в которую попадает день. Неделя начинается с понедельника. */
export function weekStart(day: Day): Day {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  // `getUTCDay()`: воскресенье — 0, понедельник — 1. Отступ до понедельника: вс → 6.
  const back = weekday === 0 ? 6 : weekday - 1;
  return addDays(day, -back);
}

/** Воскресенье недели, в которую попадает день. */
export function weekEnd(day: Day): Day {
  return addDays(weekStart(day), 6);
}

/** Попадает ли день в отрезок `[from, to]` включительно. */
export function withinDays(day: Day, from: Day, to: Day): boolean {
  return day >= from && day <= to;
}

/** Первое число месяца, в который попадает день. Ключ месячного отчёта — именно оно. */
export function monthStart(day: Day): Day {
  return `${day.slice(0, 7)}-01`;
}

/** Последнее число месяца, в который попадает день. */
export function monthEnd(day: Day): Day {
  // Первое число следующего месяца минус сутки: так длину февраля считать не приходится.
  const at = new Date(`${monthStart(day)}T00:00:00.000Z`);
  at.setUTCMonth(at.getUTCMonth() + 1);
  return addDays(at.toISOString().slice(0, 10), -1);
}

/** Сдвиг на `n` месяцев от первого числа месяца, в который попадает день. */
export function addMonths(day: Day, n: number): Day {
  const at = new Date(`${monthStart(day)}T00:00:00.000Z`);
  at.setUTCMonth(at.getUTCMonth() + n);
  return at.toISOString().slice(0, 10);
}

/** Первое января года, в который попадает день. */
export function yearStart(day: Day): Day {
  return `${day.slice(0, 4)}-01-01`;
}

/** Последний день года, в который попадает день. */
export function yearEnd(day: Day): Day {
  return `${day.slice(0, 4)}-12-31`;
}

/** Сдвиг на `n` лет с нормализацией к первому января. */
export function addYears(day: Day, n: number): Day {
  const year = Number(day.slice(0, 4)) + n;
  return `${String(year).padStart(4, "0")}-01-01`;
}

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const WEEKDAYS = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];

/** «25 июля» — короткая подпись дня. */
export function dayLabel(day: Day): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  const month = MONTHS_GENITIVE[at.getUTCMonth()] ?? "";
  return `${String(at.getUTCDate())} ${month}`;
}

/** «пятница, 25 июля» — подпись с днём недели, для шапки отчёта. */
export function dayLabelFull(day: Day): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  return `${WEEKDAYS[at.getUTCDay()] ?? ""}, ${dayLabel(day)}`;
}

/** «22 — 28 июля» — подпись недели по её началу. */
export function weekLabel(day: Day): string {
  const start = weekStart(day);
  return `${dayLabel(start)} — ${dayLabel(weekEnd(day))}`;
}

const MONTHS_NOMINATIVE = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

/** «июль 2026» — подпись месяца. */
export function monthLabel(day: Day): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  const month = MONTHS_NOMINATIVE[at.getUTCMonth()] ?? "";
  return `${month} ${String(at.getUTCFullYear())}`;
}

/** Короткая подпись годового периода. */
export function yearLabel(day: Day): string {
  return day.slice(0, 4);
}

/** `MM-DD` из дня — для сверки с днями рождения (год в CRM не нужен). */
export function monthDay(day: Day): string {
  return day.slice(5);
}

/** Корректная ли строка дня. Нужен там, где день приходит из речи или из таблицы. */
export function isDay(x: string): x is Day {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) {
    return false;
  }
  const ms = Date.parse(`${x}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    return false;
  }
  // Одной проверки на `NaN` мало: 30 февраля разбирается молча и превращается в 2 марта.
  // Сверяем обратным преобразованием — день, которого не было, себе не равен.
  return new Date(ms).toISOString().slice(0, 10) === x;
}
