# Harness tuner: full bench on the quirk depot

Main model litellm/deepseek-v4.1-flash:max. Rule writer litellm/deepseek-v4.1-flash:max. Seeds 1, 2, 7. 8 rounds, 4 candidates. Total 44.8 million tokens (cached input included). Runs with no model reply: 0.

This file is the output of `node bench/tuner/bench.mjs`, with these additions: this note and sections 10 to 12. Refer to [README.md](README.md) for the server, the tasks, and the commands.

- Sections 1 to 7 come from one full run. Sections 8 and 9 come from a later run of the session part only, with the last corrections of the capture.
- The bench skipped the second main model control, because the main model and the second model are the same.
- A run stops at 150,000 tokens or 300 seconds. The token numbers include cached input tokens.
- `complete rules` is the full rule set of the server, which a script writes from the server profile.

## 1. Tuner runs

| Seed | Version | Kept edit | Scoring score | Scoring pass rate | Mean tokens | Rules | Characters |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | v0 | seed (round 0) | 0.517 | 25% | 77548 | 0 | 0 |
| 1 | v1 | rule writer (round 1) | 0.900 | 63% | 26531 | 8 | 1417 |
| 1 | v2 | rule writer (round 2) | 0.975 | 88% | 21984 | 11 | 2057 |
| 1 | v3 | rule writer (round 3) | 1.000 | 100% | 20037 | 13 | 2879 |
| 2 | v0 | seed (round 0) | 0.267 | 0% | 121643 | 0 | 0 |
| 2 | v1 | rule writer (round 1) | 0.767 | 50% | 83777 | 8 | 1748 |
| 2 | v2 | rule writer (round 2) | 0.975 | 88% | 22854 | 10 | 2219 |
| 2 | v3 | rule writer (round 3) | 1.000 | 100% | 21343 | 12 | 2882 |
| 7 | v0 | seed (round 0) | 0.000 | 0% | 129071 | 0 | 0 |
| 7 | v1 | rule writer (round 1) | 0.033 | 0% | 72422 | 2 | 691 |
| 7 | v2 | rule writer (round 2) | 0.817 | 50% | 68346 | 2 | 1197 |
| 7 | v3 | rule writer (round 3) | 0.950 | 75% | 43141 | 2 | 1416 |
| 7 | v4 | rule writer (round 5) | 0.975 | 88% | 58445 | 6 | 2793 |
| 7 | v5 | rule writer (round 6) | 1.000 | 100% | 46640 | 6 | 3364 |

Seed 1: 8 candidates, 0 discarded as invalid, 4.3 million tokens.
Seed 2: 10 candidates, 0 discarded as invalid, 7.2 million tokens.
Seed 7: 16 candidates, 0 discarded as invalid, 13.5 million tokens.

## 2. Held-out tasks, all seeds

The tuner did not use these tasks. `no rules` is the v0 harness. `complete rules` is the rule set that a script writes from the server profile.

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no rules | 24 | 4 | 17% (7% to 36%) | 0.34 | 78394 | 24 s | 4.8 | 3 |
| learned (tuner) | 72 | 70 | 97% (90% to 99%) | 0.98 | 32065 | 14 s | 0.2 | 1 |
| complete rules | 48 | 43 | 90% (78% to 95%) | 0.98 | 20416 | 12 s | 0.5 | 0 |

For each seed:

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed 1: no rules | 8 | 2 | 25% (7% to 59%) | 0.47 | 83812 | 26 s | 4.8 | 2 |
| seed 1: learned | 24 | 23 | 96% (80% to 99%) | 0.99 | 20442 | 13 s | 0.1 | 0 |
| seed 1: complete rules | 16 | 16 | 100% (81% to 100%) | 1.00 | 19923 | 12 s | 0.4 | 0 |
| seed 2: no rules | 8 | 2 | 25% (7% to 59%) | 0.54 | 76262 | 25 s | 5.3 | 0 |
| seed 2: learned | 24 | 23 | 96% (80% to 99%) | 0.96 | 29780 | 14 s | 0.3 | 1 |
| seed 2: complete rules | 16 | 13 | 81% (57% to 93%) | 0.96 | 21733 | 12 s | 0.8 | 0 |
| seed 7: no rules | 8 | 0 | 0% (0% to 32%) | 0.00 | 75108 | 22 s | 4.5 | 1 |
| seed 7: learned | 24 | 24 | 100% (86% to 100%) | 1.00 | 45972 | 15 s | 0.1 | 0 |
| seed 7: complete rules | 16 | 14 | 88% (64% to 97%) | 0.98 | 19593 | 12 s | 0.3 | 0 |

## 3. Pass rate for each kind of task

`no rules` uses the v0 runs on all three task sets. `learned` and `complete rules` use the held-out runs.

| Kind | Depot calls | no rules | learned | complete rules |
| --- | --- | --- | --- | --- |
| id | 1 | 5 of 9 | 9 of 9 | 6 of 6 |
| stock | 2 | 0 of 9 | 9 of 9 | 5 of 6 |
| price | 2 | 0 of 9 | 9 of 9 | 5 of 6 |
| both | 3 | 0 of 9 | 9 of 9 | 6 of 6 |
| order | 3 | 0 of 9 | 9 of 9 | 6 of 6 |
| compare | 4 | 0 of 9 | 8 of 9 | 6 of 6 |
| total | 4 | 0 of 9 | 8 of 9 | 6 of 6 |
| list | 2 | 3 of 9 | 9 of 9 | 3 of 6 |

## 4. Controls (seed 1, held-out tasks)

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| learned rules, `tuner.enabled` false | 16 | 3 | 19% (7% to 43%) | 0.47 | 84109 | 26 s | 4.9 | 3 |
| placebo: 10 unrelated rules | 16 | 2 | 13% (3% to 36%) | 0.38 | 88131 | 26 s | 4.8 | 4 |
| learned rules in a full-size file | 16 | 16 | 100% (81% to 100%) | 1.00 | 25518 | 10 s | 0.0 | 0 |

## 6. Changed server (rules of seed 1, server on seed 5)

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old rules (stale) | 16 | 0 | 0% (0% to 19%) | 0.13 | 43909 | 18 s | 3.6 | 0 |
| after the tuner (v0) | 16 | 0 | 0% (0% to 19%) | 0.00 | 45189 | 19 s | 4.7 | 0 |

- v0: seed (round 0), scoring score 0.100, 13 rules.

## 7. General tasks with no depot

The learned file of seed 1 has 2879 characters.

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| learned rules on | 18 | 18 | 100% (82% to 100%) | 1.00 | 12492 | 7 s | 0.0 | 0 |
| learned rules off | 18 | 18 | 100% (82% to 100%) | 1.00 | 10237 | 7 s | 0.1 | 0 |

Runs that used the shell: 1 of 18 with the rules on, 10 of 18 with the rules off.

## 8. The one switch: rules from sessions

One agent directory with only `tuner.enabled` on, on the depot of seed 1 with a quota of 12 calls. Fabric wrote the rules with no review.

| Session | Task | Result | Failed depot calls | Tokens | Rules in the prompt | Edits after it |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | f1-id | pass | 2 of 3 | 35576 | 0 | 0 |
| 2 | s2-stock | pass | 5 of 8 | 193988 | 0 | 2 |
| 3 | f3-price | FAIL | 1 of 3 | 122653 | 2 | 0 |
| 4 | s4-both | pass | 1 of 5 | 55931 | 2 | 0 |
| 5 | f5-order | pass | 2 of 6 | 60946 | 2 | 0 |
| 6 | s6-compare | pass | 0 of 6 | 22968 | 2 | 0 |
| 7 | f7-total | pass | 2 of 8 | 36707 | 2 | 0 |
| 8 | s8-list | pass | 1 of 3 | 42637 | 2 | 0 |
| 9 | s1-id | pass | 0 of 1 | 12235 | 2 | 0 |
| 10 | f2-stock | pass | 0 of 3 | 22293 | 2 | 0 |
| 11 | s3-price | FAIL | 3 of 5 | 50454 | 2 | 1 |
| 12 | f4-both | pass | 0 of 4 | 23430 | 3 | 0 |
| 13 | s5-order | pass | 2 of 6 | 46498 | 3 | 0 |
| 14 | f6-compare | pass | 0 of 6 | 23286 | 3 | 0 |
| 15 | s7-total | pass | 0 of 6 | 22817 | 3 | 0 |
| 16 | f8-list | pass | 4 of 6 | 28391 | 3 | 0 |

- Sessions 1 to 8: 71426 mean tokens, 14 failed depot calls of 42, 7 of 8 passed, 2 edits of learned.md.
- Sessions 9 to 16: 28676 mean tokens, 9 failed depot calls of 37, 7 of 8 passed, 1 edits of learned.md.

Held-out tasks of the same seed, under the bench conditions:

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no rules | 8 | 2 | 25% (7% to 59%) | 0.47 | 83812 | 26 s | 4.8 | 2 |
| rules from the sessions | 16 | 13 | 81% (57% to 93%) | 0.96 | 30487 | 14 s | 0.6 | 0 |
| rules from the tuner run | 24 | 23 | 96% (80% to 99%) | 0.99 | 20442 | 13 s | 0.1 | 0 |
| complete rules | 16 | 16 | 100% (81% to 100%) | 1.00 | 19923 | 12 s | 0.4 | 0 |

```
- mcp.depot.depot_search: the `q` argument must be wrapped in double brackets, with words upper case and joined by `+` (no spaces). Example: `{"q":"[[BRASS+BRACKET]]"}`. Never pass a plain or quoted phrase like `'brass bracket'`.
- mcp.depot.depot_stock: do not reuse `depot_search`'s `[[...]]` format; all arguments are plain. `part` is the catalog id with `#` instead of `-` (`P-1011` becomes `P#1011`), `region` is a compass number (north 1, east 2, south 3, west 4), `date` is `MM/DD/YYYY`. Example: `{"part":"P#1011","region":"2","date":"01/19/2026"}`. Fields are validated one at a time, so pass the whole set in this format on the first call.
- mcp.depot.depot_price: arguments are `part` (catalog id with `#` instead of `-`), `qty` (string of `x` then the number, e.g. `"x36"`, not `"36"` and not a number), and `cur` (must be exactly `"USD"` — not `"currency"`). Example: `{"part":"P#1012","qty":"x36","cur":"USD"}`. Pass all three in this exact form on the first call; do not guess alternate names like `quantity`.
```

## 9. The one switch after a change of the depot

The same agent directory. Before session 17, the depot changed to the rules of seed 5, so the rules in learned.md became wrong.

| Session | Task | Result | Failed depot calls | Tokens | Rules in the prompt | Edits after it |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | f1-id | pass | 18 of 19 | 290873 | 3 | 1 |
| 18 | s2-stock | FAIL | 11 of 21 | 45138 | 3 | 0 |
| 19 | f3-price | FAIL | 7 of 17 | 45420 | 3 | 1 |
| 20 | s4-both | pass | 6 of 15 | 200836 | 3 | 1 |
| 21 | f5-order | pass | 9 of 14 | 270441 | 4 | 1 |
| 22 | s6-compare | pass | 8 of 16 | 508882 | 5 | 0 |
| 23 | f7-total | FAIL | 4 of 15 | 75936 | 5 | 0 |
| 24 | s8-list | pass | 9 of 15 | 80210 | 5 | 0 |
| 25 | s1-id | pass | 10 of 20 | 220921 | 5 | 0 |
| 26 | f2-stock | FAIL | 4 of 15 | 81533 | 5 | 1 |
| 27 | s3-price | FAIL | 4 of 11 | 90210 | 3 | 1 |
| 28 | f4-both | FAIL | 6 of 13 | 123903 | 3 | 1 |
| 29 | s5-order | FAIL | 6 of 13 | 196427 | 4 | 0 |
| 30 | f6-compare | FAIL | 5 of 15 | 326921 | 4 | 1 |
| 31 | s7-total | pass | 2 of 6 | 50453 | 4 | 1 |
| 32 | f8-list | pass | 0 of 2 | 19145 | 4 | 0 |

- Sessions 17 to 24: 189717 mean tokens, 72 failed depot calls of 132, 5 of 8 passed, 4 edits of learned.md.
- Sessions 25 to 32: 138689 mean tokens, 37 failed depot calls of 95, 3 of 8 passed, 5 edits of learned.md.

Held-out tasks on the changed depot, under the bench conditions:

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no rules | 8 | 0 | 0% (0% to 32%) | 0.00 | 74172 | 22 s | 2.5 | 1 |
| rules from before the change (stale) | 16 | 0 | 0% (0% to 19%) | 0.00 | 34096 | 14 s | 3.1 | 0 |
| rules after the sessions on the changed depot | 16 | 14 | 88% (64% to 97%) | 0.98 | 33990 | 12 s | 0.4 | 0 |

```
- Fabric tool discovery (mcp.depot.*): find these tools with `tools.list({ query: "depot" })` — the filter parameter is `query`, not `search`, and the result is a list of tool records, not an object with a `.tools` array. Inspect one with its full provider-prefixed ref, e.g. `tools.describe({ ref: "mcp.depot.depot_search" })`; a bare `depot.depot_search` fails with `Unknown Fabric provider: depot`.
- mcp.depot.depot_search: `q` must be `q:` + the upper-case words joined by `+` + `;`, with no brackets and no spaces. Examples: `{"q":"q:COPPER;"}` and `{"q":"q:BRASS+COUPLING;"}`. Never pass a plain or quoted phrase, never wrap the words in `[ ]` or double brackets, and never omit the `q:` prefix or the trailing `;` — all fail with ERR_FORMAT. `page` must be `p` + the page number with no slash, e.g. `{"page":"p1"}`; a bare number like `"1"` or a slash form like `"1/"` fails with ERR_FORMAT. A job has a hard quota of 12 depot calls total, so send the exact accepted form on the first try instead of probing variants.

- mcp.depot.depot_price: arguments are `part` (lower-case `p` then the number, the same form as depot_stock — `P-1012` or `P#1012` fails with ERR_FORMAT [part]), `qty` (string of `x` then the number, e.g. `"x36"`, not `"36"` and not a number), and `cur` (must be exactly `"USD"` — not `"currency"`). Example: `{"part":"p1012","qty":"x36","cur":"USD"}`. Pass all three in this exact form on the first call; do not guess alternate names like `quantity`.
- mcp.depot.depot_stock: arguments are `part` (lower-case `p` then the number, e.g. `p1004` — do not reuse the `P#1004` form of depot_price), `region` (first three letters in upper case, e.g. `west` becomes `WES`), and `date` (`DD.MM.YYYY`, e.g. `2026-04-13` becomes `13.04.2026`). Example: `{"part":"p1004","region":"WES","date":"13.04.2026"}`. Add `"mode":"live"` when a live count is needed, since the default snapshot may be STALE. Send this exact form on the first call; each wrong format costs one of the 12 depot calls.
```

## Learned rules

### Seed 1 (v3)

```
- depot tools: call them directly as `mcp.depot.depot_search`, `mcp.depot.depot_stock`, `mcp.depot.depot_price`, `mcp.depot.depot_reserve`, `mcp.depot.depot_confirm`; do not spend calls or steps on `tools.search`/`tools.list`/`pi.bash` to find them.
- depot quota: each task allows only a small number of depot calls (about 5). Errors count against the quota, so get every argument format right on the first call and never retry the same call with the same wrong format.
- depot_search `q`: wrap the words, upper case, joined with `+` and no spaces. Example: `q: "[[COPPER+GASKET]]"`. Never pass a lowercase or space-separated `q`.
- depot `part` ids: use `P#` plus the number. A catalog id `P-1002` must be passed as `part: "P#1002"`.
- depot `region`: use the compass number, not the name: `"1"`=north, `"2"`=east, `"3"`=south, `"4"`=west. Example: `region: "2"` means east.
- depot_stock/depot_price `date`: the depot wants `MM/DD/YYYY`, never `YYYY-MM-DD`, and `depot_stock` rejects a call with no date. Convert first: `2026-06-15` becomes `date: "06/15/2026"`.
- depot_stock `live`: by default a stock call returns a cached snapshot and its result may carry a `"snapshot":"STALE"` note telling you to add `live: "yes"`. When the task asks for the count that is current as of the task's date (a comparison, an order decision, or anything phrased "as of"), include `live: "yes"` on the FIRST call for each part — e.g. `depot_stock({part: "P#1006", region: "2", date: "06/15/2026", live: "yes"})`. Do not spend a second call per part re-fetching live data; that duplicate round trip is what exhausts the quota.
- depot_price: pass BOTH `qty` (prefix the number with `x`, as a string, e.g. `qty: "x12"` for 12 units) and `cur` (exactly `cur: "USD"`); a missing `cur` is a rejected call.
- depot_reserve/depot_confirm: `depot_reserve` returns a hold id like `H-40969`; `depot_confirm` needs `hold` plus `pin`, which is the digits of the hold id reversed, e.g. hold `H-40217` has `pin: "71204"`. Confirm the same hold you just reserved, before the hold goes void.
- depot_search `page`: only for a second page, and the format is the number plus a slash. Example: `page: "2/"`. Omit it for page 1.
- depot answers: read the returned fields carefully — a successful call can still return data that is not the data the task needs (e.g. a `STALE` snapshot when a live count was required). Only write `UNKNOWN` if a required value was truly never obtained, not merely because your own wrong-format call used up calls.
- pi.write/pi.read: `pi.write` succeeds, but `pi.read` is denied by policy and `pi.bash` is denied too. After writing `answer.txt` do not call `pi.read` or `pi.bash` to verify it; trust the `ok: true` result and stop.
- Tool errors elsewhere: `pi.bash` is denied by policy and `tools.list`/`tools.providers` output is truncated, so do not rely on them for discovery.
```

### Seed 2 (v3)

```
- depot (all tools): the job has a hard quota of ~5 depot calls total; never spend a call to discover a format. Study the tool schemas once (via `tools.search`/`tools.list`, which are not depot calls), then make every depot call correct on the first try.
- depot.depot_search: arg `q` must be wrapped in angle brackets with the words in UPPER CASE joined by `+`. Example: `q: "<COPPER+COUPLING>"`. A bare `"copper coupling"` or lowercase/space form returns ERR_FORMAT and still counts against the quota.
- depot.depot_search paging: when the result shows more pages, request further pages with `page: "p2"` (p then number). Example: `page: "p2"`.
- depot part ids (depot_stock, depot_price, depot_reserve, depot_confirm): the `part` arg must be `P#` followed by the number, converting catalog ids like `P-1004` to `P#1004`. Example: `part: "P#1004"`.
- depot.depot_stock: pass `part` as `P#<n>`, `region` as a compass number (north=1, east=2, south=3, west=4), and `date` as `DD.MM.YYYY`. Example: `{part:"P#1004", region:"4", date:"13.04.2026"}`.
- depot.depot_price: pass `part` as `P#<n>`, `qty` as the number immediately followed by `ea` (e.g. `"15"` becomes `"15ea"`), and `cur` as exactly lowercase `usd`. Example: `{part:"P#1004", qty:"15ea", cur:"usd"}`.
- depot.depot_reserve: same formats as the other part tools — `part` as `P#<n>`, `qty` as `<n>ea`, `region` as the compass number (e.g. `{part:"P#1005", qty:"18ea", region:"1"}`). It returns a `hold` id; pass that hold id to `depot.depot_confirm`.
- depot.depot_confirm: requires both `hold` and `pin`. `pin` is the digits of the hold id plus the reserved quantity, as a string/number. Example: hold `H-40217` for 5 units → `pin: 40222`. Omitting `pin` gives ERR_PIN, voids the hold, and forces a fresh reserve+confirm pair (two extra calls). Call it as `depot_confirm({ hold, pin })` where `pin = Number(hold.replace(/\D/g,"")) + qty`.
- depot.depot_stock: a plain call may return a `snapshot: "STALE"` count with a note to add `live: "yes"`. Always include `live: "yes"` in the same call (never a second call) so the count returned is the one the answer needs: `{part:"P#1006", region:"4", date:"15.06.2026", live:"yes"}`.
=======
- depot call refs: invoke depot tools as `mcp.depot.depot_search`, `mcp.depot.depot_stock`, etc. A ref of `depot.depot_*` fails with "Unknown Fabric provider: depot".
- depot (sequencing): reserve the last calls for the data the answer needs; do the search call(s) first to get `P#` ids, then call only stock/price/reserve/confirm you actually need, since a failed or extra call permanently consumes quota.
- fabric/pi tools: `pi.read` and `pi.bash` are denied by policy in most sessions; do not spend calls on them. Use only `pi.write` to write `answer.txt`, and rely on returned call results (e.g. `JSON.parse(r.text)`) for data, inspecting the workspace instead of re-reading files.
```

### Seed 7 (v5)

```
- depot tools (mcp.depot.*): arguments are strict strings, and a guess is a wasted call. Read the ERR_FORMAT message literally: it names the exact form, and *the example in it is the format to copy*. Known shapes: `depot_search` takes `q` = `q:` + query words in UPPER CASE joined by `::` (no spaces) + trailing `;`, e.g. `depot_search({ q: 'q:OAK::PANEL;' })`; a later page adds `page` = `p` + the number (`p3`). `part` is lowercase `p` + the digits only (catalog `P-7731` -> `p7731`). `region` is `R-` + the lower-case region name (`West` -> `R-west`, `central` -> `R-central`) — NOT the `region:...;` token form. `date` is `DD.MM.YYYY` (`2026-06-15` -> `15.06.2026`) — NOT the ISO `date:...;` form. `qty` is `x` + the number (`15` -> `x15`). `cur` is exactly `$`. `depot_reserve` takes `part` = `p<digits>`, `qty` = `x<number>`, `region` = `R-<lowercase>`; `depot_confirm` takes `hold` (`H-<n>`) plus `pin` (= the sum of the hold's digits).
- depot quota: the depot allows about 5 calls per job and failed calls still count. Do not probe formats with real calls: call `tools.describe({ref:'mcp.depot.depot_search'})` (or the relevant depot tool) once to read its input schema, then make exactly the call it specifies. After any ERR_FORMAT, fix *all* arguments using the example in that same message at once — fixing one at a time triggers the next field's error and wastes a call. Never try a series of variants.
- depot planning: before the first depot call, list from the task wording the exact data the answer needs and the exact calls that produce it (e.g. search -> part id; stock and price for that id; reserve + confirm only if the task asks to *order*). Make only those calls, one per needed datum; a call whose output is not part of the answer is a wasted call. Do not call `depot_reserve`/`depot_confirm` unless the task asks to place or confirm an order. Finish all discovery (`tools.describe`, `tools.list`) *before* the first depot call, and for each part count the calls ahead of time: search (1) + stock (1) + price (1) = 3 per part, so a two-part comparison uses at most 6 minus any page repeats — budget so the last needed call always fits inside the quota.
- depot paging: `depot_search` returns `{"matches":[...],"more":true|false}` for one page of at most 3 matches. Only pass `page` when `more` is `true` and the needed part is not in the current matches; `page:'p3'` on a single-page result is an ERR_FORMAT and a wasted call. If the part is already in the matches, use that id and stop searching.
- depot results: a returned value can be a stale cache snapshot (flagged as stale in the text). A call that returns a stale value is a wasted call whenever the answer needs a live number or a comparison. Read the task wording first: if it asks for current counts, "now", or to compare parts, include `cache:'off'` on the *first* call so the value is live — do not take the stale snapshots and then re-call with `cache:'off'`, since the re-call is exactly what exhausts the quota. Use a stale snapshot only when the task clearly accepts it. Never call the same tool with the same arguments twice in one job.
- pi tools: `pi.read` and `pi.bash` are denied by policy in this environment; do not call them. To write the answer use `pi.write({path:'answer.txt', text:'...'})` only, and trust its success message instead of reading the file back.
```

## 10. Tuner run from an empty file on the changed depot (seed 5)

Section 6 shows that a tuner run that starts from the old rules keeps no edit. This run starts from an empty file, which is the default of `pi-fabric tune run`. It used 7.1 million tokens.

| Seed | Version | Kept edit | Scoring score | Scoring pass rate | Mean tokens | Rules | Characters |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | v0 | seed (round 0) | 0.000 | 0% | 97077 | 0 | 0 |
| 5 | v1 | rule writer (round 1) | 0.517 | 25% | 57458 | 6 | 1739 |
| 5 | v2 | rule writer (round 2) | 0.975 | 88% | 25803 | 8 | 2288 |
| 5 | v3 | rule writer (round 4) | 0.975 | 88% | 20480 | 10 | 3025 |
| 5 | v4 | removal (round 5) | 1.000 | 100% | 38921 | 9 | 2789 |

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no rules | 8 | 0 | 0% (0% to 32%) | 0.00 | 94999 | 19 s | 4.1 | 3 |
| learned (tuner run from an empty file) | 24 | 23 | 96% (80% to 99%) | 0.97 | 43572 | 13 s | 0.5 | 1 |
| complete rules | 16 | 14 | 88% (64% to 97%) | 0.98 | 19921 | 9 s | 0.4 | 0 |

## 11. Settings that the bench compared

Each row is one bench run with `deepseek-v4.1-flash`. The pass rates are for held-out tasks. Each setting has one run, so a difference of less than 10 points is noise.

| Run | Change from the row above | Thinking level: main model, rule writer | Rules of a tuner run | Tokens for 3 tuner runs | Rules from 16 sessions | After the tool change: repaired rules | Sessions that failed after the change, of 16 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 4 rounds, 4 candidates | `medium`, `medium` | 83% (59 of 71) | 28.7 million | 69% | not measured | not measured |
| 2 | Fewer candidates at a high score | `medium`, `medium` | 85% (61 of 72) | 25.5 million | 69% | 63% | 7 |
| 3 | A maximum of 8 rounds, a stop at a score of 1.00, removal of a rule that only fails | `medium`, `medium` | 92% (66 of 72) | 20.9 million | 81% | 75% | 3 |
| 4 | Same logic | `medium`, `max` | 93% (67 of 72) | 32.5 million | 75% | 63% | 3 |
| 5 | Same logic | `max`, `max` | 97% (70 of 72) | 20.7 million | 75% | 88% | 7 |
| 6 | Exact arguments of the call that succeeded | `max`, `max` | 97% (70 of 72) | 25.0 million | 88% | 75% | 9 |
| 7 | Only an accepted tool call is a success | `max`, `max` | same runs as row 6 | same runs as row 6 | 81% | 88% | 7 |
| 8 | Only the newest call is proof, removal with no model call | `max`, `max` | same runs as row 6 | same runs as row 6 | 81% | 88% | 8 |

Row 6 is sections 1 to 7 of this file. Row 8 is sections 8 and 9.

## 12. Earlier run with two models

An earlier full run used `glm-5.3-flash` as the main model and `deepseek-v4.1-flash` as the rule writer, with 4 rounds.

| Harness on held-out tasks | Runs | Pass rate (95% interval) | Mean tokens |
| --- | ---: | --- | ---: |
| No rules | 24 | 13% (4% to 31%) | 145,791 |
| Learned rules of a tuner run | 72 | 89% (80% to 94%) | 23,702 |
| Complete rules | 48 | 100% (93% to 100%) | 20,905 |
| `deepseek-v4.1-flash` as the main model, no rules | 16 | 19% | |
| `deepseek-v4.1-flash` as the main model, with the rules that `glm-5.3-flash` learned | 16 | 100% | |

## Limits

- The bench is synthetic. A model cannot know the rules of the depot before a run, so the gain is near the best case. The bench does not show the size of the gain on real coding work.
- Each setting has one run. The session test has one seed, with 16 sessions before the change and 16 after it.
- A rule can describe a limit of the task suite as a fact. The suite denies the shell, and the learned rules of seed 1 say so. Section 7 shows the effect on the shell use of the general tasks.
- A call that the tool accepts with an empty result counts as a success. The changed depot accepts the mixed form `q:[[OAK]];` and returns no match.
- The sessions of section 8 and section 9 can use the shell. After the tool change, some sessions used it to look for a way around the depot.
- The partial score of a failed task counts successful depot calls. A call that succeeds with data that the task cannot use also counts.
