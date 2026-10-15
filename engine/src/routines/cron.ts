// 5-field cron (min hour dom month dow), local time. Parsing never throws: it returns an Error for the UI.
export interface CronSpec {
  min: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  wild: { dom: boolean; dow: boolean };
}

const NAMES: Record<string, Record<string, number>> = {
  month: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dow: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};
const RANGES: Record<string, [number, number]> = { min: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 7] };

function parseField(field: string, name: keyof typeof RANGES): number[] | Error {
  const [lo, hi] = RANGES[name];
  const out = new Set<number>();
  const num = (s: string) => {
    const n = NAMES[name]?.[s.toLowerCase()];
    if (n !== undefined) return n;
    if (!/^\d+$/.test(s)) return NaN;
    return Number(s);
  };
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return new Error(`bad step in “${part}”`);
    let a: number;
    let b: number;
    if (rangePart === "*") [a, b] = [lo, hi];
    else if (rangePart.includes("-")) {
      const [x, y] = rangePart.split("-");
      [a, b] = [num(x), num(y)];
    } else {
      a = num(rangePart);
      b = stepPart === undefined ? a : hi;
    }
    if (Number.isNaN(a) || Number.isNaN(b) || a < lo || b > hi || a > b) return new Error(`“${part}” is out of range for ${name} (${lo}-${hi})`);
    for (let v = a; v <= b; v += step) out.add(name === "dow" && v === 7 ? 0 : v);
  }
  return [...out].sort((x, y) => x - y);
}

export function parseCron(expr: string): CronSpec | Error {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return new Error("Use 5 fields: minute hour day-of-month month day-of-week");
  const names = ["min", "hour", "dom", "month", "dow"] as const;
  const parsed: Partial<CronSpec> = {};
  for (let i = 0; i < 5; i++) {
    const r = parseField(fields[i], names[i]);
    if (r instanceof Error) return r;
    (parsed as any)[names[i]] = r;
  }
  return { ...(parsed as Omit<CronSpec, "wild">), wild: { dom: fields[2] === "*", dow: fields[4] === "*" } };
}

/**
 * Next matching minute strictly after `after`, local time. Error when nothing matches within 4 years (a Feb 29 schedule
 * needs up to that). Minutes and hours advance on the epoch, so the repeated local hour at a DST fall-back is walked
 * through in real time (local setters would resolve it to the earlier offset and step backwards). A local time that
 * does not exist (spring-forward gap) is skipped that day.
 */
export function nextRun(spec: CronSpec, after: Date): Date | Error {
  const MIN = 60_000;
  let t = new Date(Math.floor(after.getTime() / MIN) * MIN + MIN);
  const limit = after.getTime() + (4 * 365 + 2) * 86_400_000;
  while (t.getTime() <= limit) {
    if (!spec.month.includes(t.getMonth() + 1)) {
      t = forward(t, new Date(t.getFullYear(), t.getMonth() + 1, 1, 0, 0, 0, 0));
      continue;
    }
    const domOk = spec.dom.includes(t.getDate());
    const dowOk = spec.dow.includes(t.getDay());
    const dayOk = spec.wild.dom && spec.wild.dow ? true : spec.wild.dom ? dowOk : spec.wild.dow ? domOk : domOk || dowOk;
    if (!dayOk) {
      t = forward(t, new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 0, 0));
      continue;
    }
    if (!spec.hour.includes(t.getHours())) {
      t = new Date(t.getTime() + (60 - t.getMinutes()) * MIN);
      continue;
    }
    if (!spec.min.includes(t.getMinutes())) {
      t = new Date(t.getTime() + MIN);
      continue;
    }
    return t;
  }
  return new Error("This schedule never matches a real date.");
}

/** A day/month skip built with local setters; never lets the search move backwards. */
function forward(from: Date, to: Date): Date {
  return to.getTime() > from.getTime() ? to : new Date(from.getTime() + 60_000);
}

const two = (n: number) => String(n).padStart(2, "0");

export function describeCron(spec: CronSpec, raw: string): string {
  const times = spec.hour.length * spec.min.length <= 4 ? spec.hour.flatMap((h) => spec.min.map((m) => `${two(h)}:${two(m)}`)) : null;
  if (!times || !spec.wild.dom || spec.month.length !== 12) return raw;
  const list = times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
  const dows = spec.dow.join(",");
  if (spec.wild.dow) return `every day at ${list}`;
  if (dows === "1,2,3,4,5") return `every weekday at ${list}`;
  if (dows === "0,6") return `every weekend day at ${list}`;
  return raw;
}
