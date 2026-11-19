# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Oksidasi13/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Oksidasi13/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast each GTA VI PS5 trophy's Exophase earn rate at the case's target (2026-11-26T00:00:00Z for the final), as five quantiles per trophy. Node 22, standard library only, no network. Entry point: `main.ts` at the repo root.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Model

Per trophy, on the logit scale (`rate = earners / players_tracked`):

- **Trend regime** (history shows movement, as the final case will): weighted least squares of `logit(rate)` on `x = ln(1 + hours since release)`, fit on the case's **last 24 hours** of reads — the recent slope is what extrapolates; a trophy's rate saturates as players finish it, so the full-history slope overshoots. Each trophy's slope is shrunk toward the cross-trophy mean slope (precision-weighted). Extrapolation beyond the fit window is damped by 0.9, because the logit trend flattens as the rate nears its plateau. Spread = fit residual + slope uncertainty × extrapolation distance + a small random-walk term in horizon.
- **Flat regime** (every read identical — launch night, no refresh yet): no trend can be fit, so a structural prior applies. Exophase refreshes a game's counts every few hours and a refresh catches up all player growth since the previous one, so a refresh inside the horizon dilutes every rate hard (launch-night page: 638 players tracked, refreshed to 3,868, every rate but the one at 100% lower). The median therefore shifts down in logit — more for rare/late trophies, less for common/early ones, which gain new earners fastest — with a wide spread that keeps the no-refresh outcome inside the 90% band. The shift grows slowly with the horizon.
- **Saturated trophies** (last rate 100%): forecast ~100% with a narrow downward tail; the launch-night refresh left the 100% trophy at 100%.
- Null rates in reads are treated as missing data (forward-filled for movement detection; the last observed non-null rate is used as "last").

## Local verification (2026-11-19)

The true practice answers (04:30Z / 05:00Z reads) are server-side only, so practice scoring uses reconstructed proxy answers, calibrated so the house baseline reproduces its published practice aggregates (loss ~1.51, typical miss ~0.68, 90% coverage ~0). Scores are mean pinball loss on the logit scale, lower is better:

| proxy answer | house baseline | this entry |
|---|---:|---:|
| A k=0.10 (main) | 1.4851 | **0.2230** |
| A k=0.20 | 1.3011 | **0.1919** |
| Uniform odds ×0.20 | 1.4912 | **0.2242** |
| Pure dilution (638→3868) | 1.6871 | **0.2641** |
| Uniform odds ×0.35 (mild) | 0.9417 | **0.2457** |

Typical miss 0.014–0.082 pts (baseline 0.56–0.73), 90% coverage 0.98 (baseline 0.00). The advantage holds across all proxies, not one tuned answer — the model was not fit to any proxy.

Trend regime checked on two synthetic final-like cases (2-day history with Exophase-style refresh steps, Nov-26 answer): loss **0.113 / 0.113** vs house baseline 0.399 / 0.425.

Validity: both practice outputs 55 trophies, quantiles non-decreasing, ≤65,536 bytes, byte-identical across two runs; runtime ~0.6 s for both cases (cap 8 s per case). Edge cases pass: single-read history, null rates, 0% rate, long-horizon flat history.

## Status

- Built locally only. NOT submitted, NOT pushed to GitHub, no login.
- Still blocks submission: GitHub repo creation + `makefun check` + transcript bundle + `submit` (separate run; needs the user's GitHub connection for oksidasi13). Prize: 20 places, $250 total; deadline 2026-11-21T11:30:00Z. A prize needs a loss strictly below the best house entry on the final.
- Dev tooling (local scorer, proxy answers, synthetic finals, A/B experiments): `~/workspace/makefun/trophy-forecast-dev/`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
