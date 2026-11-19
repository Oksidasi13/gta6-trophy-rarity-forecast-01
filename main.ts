// gta6-trophy-rarity-forecast-01 entry (Node 22, standard library only).
//
// Forecast each GTA VI PS5 trophy's Exophase earn rate at the case's target,
// as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95), from the case's history
// of reads of the game's trophy page.
//
// Model (per trophy, on the logit scale, rate = earners / players tracked):
//   - Trend regime (history shows movement): weighted least squares of
//     logit(rate) on x = ln(1 + hours since release), fit on the case's last
//     24 hours of reads (the recent slope is what extrapolates; a trophy's
//     rate saturates as players finish it, so the full-history slope
//     overshoots). Each trophy's slope is shrunk toward the cross-trophy
//     mean slope, precision-weighted. Extrapolation beyond the fit window
//     is damped by 0.9, because a rate's logit trend flattens as it nears
//     its plateau. Spread combines the fit residual, slope uncertainty
//     times extrapolation distance, and a small random-walk term in horizon.
//   - Flat regime (every read identical: no refresh yet in the history, as
//     on launch night): no trend can be fit, so a structural prior applies.
//     Exophase refreshes a game's counts every few hours, and a refresh
//     catches up all player growth since the previous one, so a refresh
//     inside the horizon dilutes every rate hard (launch-night page: 638
//     players tracked, refreshed to 3,868, every rate but the one at 100%
//     lower). The median therefore shifts down in logit (more for rare /
//     late trophies, less for common / early ones, which gain new earners
//     fastest), with a wide spread that keeps the no-refresh outcome inside
//     the 90% band. The shift grows slowly with the horizon: a longer flat
//     stretch means more growth caught up at the next refresh.
//   - Saturated trophies (last rate 100%): forecast ~100% with a narrow
//     downward tail; the launch-night refresh left the 100% trophy at 100%.
// Deterministic: no randomness, no clock, no network. Reads every *.in in
// the input directory, writes <id>.out per case.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Release midnight UTC; player accumulation and trophy progress count from here. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** Trend fits use the last 24 hours of reads; extrapolation is damped by this. */
const WINDOW_HOURS = 24;
const DAMP = 0.9;

interface Trophy {
  id: number;
  tier: string;
  points: number;
  secret: boolean;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo = 0.01, hi = 99.99): number => Math.min(hi, Math.max(lo, x));
const logit = (pct: number): number => {
  const c = clamp(pct);
  return Math.log(c / (100 - c));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Fit {
  b: number;
  a: number;
  xBar: number;
  residSd: number;
  seB: number;
  n: number;
}

/** Weighted least squares of y on x (weights relative). */
function wls(xs: number[], ys: number[], ws: number[]): Fit {
  const n = xs.length;
  let sw = 0;
  let xBar = 0;
  let yBar = 0;
  for (let i = 0; i < n; i++) {
    sw += ws[i];
    xBar += ws[i] * xs[i];
    yBar += ws[i] * ys[i];
  }
  xBar /= sw;
  yBar /= sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xBar;
    sxx += ws[i] * dx * dx;
    sxy += ws[i] * dx * (ys[i] - yBar);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = yBar - b * xBar;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    rss += ws[i] * r * r;
  }
  // Residual variance, treating weights as relative (rss / sw, df-corrected).
  const dof = Math.max(n - 2, 1);
  const residSd = Math.sqrt(rss / Math.max(sw, 1e-9) / Math.max(dof / n, 0.05));
  const seB = sxx > 1e-12 ? Math.sqrt((rss / Math.max(sw, 1e-9) / Math.max(dof / n, 0.05)) / sxx) : 10;
  return { b, a, xBar, residSd, seB, n };
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const horizonDays = c.horizon_minutes / 1440;
  const releaseMs = c.game?.release_date ? Date.parse(`${c.game.release_date}T00:00:00Z`) : RELEASE_MS;
  const targetMs = Date.parse(c.target);
  const xTarget = Math.log(1 + Math.max(0, (targetMs - releaseMs) / 3_600_000));

  const nT = c.trophies.length;
  const reads = c.history;
  const nR = reads.length;
  // Last observed (non-null) rate per trophy: the last read may lack a trophy.
  const lastRates: number[] = c.trophies.map((_, i) => {
    for (let j = nR - 1; j >= 0; j--) {
      const v = reads[j].rates[i];
      if (v !== null && v !== undefined) return v;
    }
    return 0;
  });

  // Movement = players tracked changing, or any trophy's rate changing.
  // Nulls are missing data, not movement: a null is forward-filled with the
  // trophy's previous non-null rate when comparing snapshots.
  const distinctCount = (idxs: number[]): number => {
    // Seed the fill with each trophy's first non-null rate in the window, so
    // a leading null does not by itself create a distinct snapshot.
    const fill: Array<number | null> = c.trophies.map(() => null);
    for (const j of idxs) {
      for (let i = 0; i < nT; i++) {
        const v = reads[j].rates[i];
        if (fill[i] === null && v !== null && v !== undefined) fill[i] = v;
      }
    }
    const keys = new Set<string>();
    for (const j of idxs) {
      const r = reads[j];
      const parts: string[] = [String(r.players_tracked)];
      for (let i = 0; i < nT; i++) {
        const v = r.rates[i];
        if (v !== null && v !== undefined) fill[i] = v;
        parts.push(fill[i] === null ? '' : String(fill[i]));
      }
      keys.add(parts.join(','));
    }
    return keys.size;
  };
  const allIdx = reads.map((_, j) => j);
  const flat = distinctCount(allIdx) <= 1 || nR < 3;

  // Time axis: x = ln(1 + hours since release) per read; mild recency tilt.
  const xs: number[] = reads.map((r) => Math.log(1 + Math.max(0, (Date.parse(r.at) - releaseMs) / 3_600_000)));
  const ws: number[] = reads.map((_, j) => 0.5 + 0.5 * (nR <= 1 ? 1 : j / (nR - 1)));

  // Trend fits use the last WINDOW_HOURS of reads, provided that window holds
  // at least 3 distinct snapshots; otherwise the whole history.
  const cutoffMs = Date.parse(c.at) - WINDOW_HOURS * 3_600_000;
  const windowIdx = reads.map((_, j) => j).filter((j) => Date.parse(reads[j].at) >= cutoffMs);
  const idx = windowIdx.length >= 3 && distinctCount(windowIdx) >= 3 ? windowIdx : allIdx;

  // --- Per-trophy logit-rate fits (trend regime) ---
  const fits: Array<Fit | null> = [];
  for (let i = 0; i < nT; i++) {
    const px: number[] = [];
    const py: number[] = [];
    const pw: number[] = [];
    for (const j of idx) {
      const r = reads[j].rates[i];
      if (r === null || r === undefined) continue;
      px.push(xs[j]);
      py.push(logit(r));
      pw.push(ws[j]);
    }
    fits.push(px.length >= 3 ? wls(px, py, pw) : null);
  }

  // Cross-trophy slope shrinkage: precision-weighted mean slope and its spread.
  const good = fits.filter((f): f is Fit => f !== null);
  let bMean = 0;
  let bTau = 0.5;
  if (good.length > 0) {
    let sw = 0;
    let sb = 0;
    for (const f of good) {
      const w = 1 / (f.seB * f.seB + 0.04);
      sw += w;
      sb += w * f.b;
    }
    bMean = sb / sw;
    const vs = good.map((f) => (f.b - bMean) ** 2);
    bTau = Math.max(0.15, Math.sqrt(vs.reduce((a, v) => a + v, 0) / Math.max(vs.length, 1)));
  }
  const residMed = good.length > 0 ? median(good.map((f) => f.residSd)) : 0.2;

  const out: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < nT; i++) {
    const rLast = lastRates[i];
    const lLast = logit(rLast);
    // Saturated trophy (100%): it survived a 6x player influx at 100%, so
    // forecast ~100% with only a small downward tail.
    if (rLast >= 99.99) {
      out.push({ id: c.trophies[i].id, q: [99.9, 99.99, 99.99, 99.99, 99.99] });
      continue;
    }

    let mu: number;
    let s: number;
    const f = fits[i];
    if (!flat && f !== null) {
      // Shrink this trophy's slope toward the cross-trophy mean.
      const wSelf = 1 / (f.seB * f.seB + 1e-9);
      const wPrior = 1 / (bTau * bTau);
      const bStar = (f.b * wSelf + bMean * wPrior) / (wSelf + wPrior);
      const aStar = f.a + f.b * f.xBar - bStar * f.xBar; // intercept at shrunk slope
      // Extrapolate from the fit window's centre, damping the increment:
      // the logit trend flattens as the rate nears its plateau.
      const dx = Math.max(0, xTarget - f.xBar);
      mu = aStar + bStar * f.xBar + bStar * dx * DAMP;
      const resid = Math.max(0.2, Math.min(f.residSd, 3 * Math.max(residMed, 0.05)));
      s = Math.sqrt(resid * resid + (f.seB * dx) ** 2 + 0.04 * horizonDays);
      s = Math.min(1.5, Math.max(0.35, s));
    } else {
      // Flat regime: structural dilution prior (see header).
      const shiftBase = -(1.15 + 0.55 * Math.log10(1 + horizonDays * 24));
      // Common / early trophies (higher current rate) gain new earners
      // fastest, so their rate drops least; rare / late ones drop most.
      const earliness = lLast - logit(0.9);
      const shift = shiftBase + 0.3 * earliness;
      mu = lLast + shift;
      s = 0.85 + 0.15 * Math.log10(1 + horizonDays * 24);
      s = Math.min(1.4, Math.max(0.8, s));
    }
    const q = Z.map((z) => round4(clamp(invLogit(mu + z * s), 0.01, 99.99)));
    // Enforce non-decreasing after rounding/clamping.
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    out.push({ id: c.trophies[i].id, q });
  }
  return out;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
