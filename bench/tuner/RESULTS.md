# Harness tuner: full bench on the quirk depot

Solver litellm/glm-5.3-flash. Proposer litellm/deepseek-v4.1-flash. Seeds 1, 2, 7. 4 rounds, 4 candidates. Total 45.2 million tokens (cached input included). Runs with no model reply: 0.

This file is the output of `node bench/tuner/bench.mjs`, with two additions: this note and the last section. Refer to [README.md](README.md) for the server, the tasks, and the commands.

- The numbers come from the second run, which uses the tuner code of this repository.
- The second run did not repeat three control arms, because they do not depend on the tuner or on the learned rules: `tuner.enabled` false, placebo, and the other solver with no rules. Their runs come from the first run on the same tasks and the same server. The token total includes them.
- The second run did not repeat the removal arms (section 5). The last section shows them for the first run.
- A run stops at 150,000 tokens or 300 seconds. The token numbers include cached input tokens.

## 1. Tuner runs

| Seed | Version | Kept edit | Scoring score | Scoring pass rate | Mean tokens | Rules | Characters |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | v0 | seed (round 0) | 0.492 | 25% | 132557 | 0 | 0 |
| 1 | v1 | proposer (round 1) | 0.733 | 38% | 32079 | 7 | 1814 |
| 1 | v2 | proposer (round 2) | 0.975 | 88% | 21937 | 9 | 2677 |
| 1 | v3 | proposer (round 3) | 1.000 | 100% | 19019 | 10 | 3331 |
| 2 | v0 | seed (round 0) | 0.392 | 13% | 142805 | 0 | 0 |
| 2 | v1 | proposer (round 1) | 0.675 | 38% | 28911 | 9 | 2334 |
| 2 | v2 | proposer (round 2) | 0.975 | 88% | 20429 | 10 | 2519 |
| 2 | v3 | proposer (round 3) | 1.000 | 100% | 19751 | 11 | 2859 |
| 7 | v0 | seed (round 0) | 0.183 | 0% | 158360 | 0 | 0 |
| 7 | v1 | proposer (round 1) | 0.808 | 63% | 36634 | 7 | 1772 |
| 7 | v2 | proposer (round 2) | 0.975 | 88% | 22754 | 10 | 2733 |

Seed 1: 16 candidates, 0 discarded as invalid, 7.5 million tokens.
Seed 2: 16 candidates, 0 discarded as invalid, 7.3 million tokens.
Seed 7: 16 candidates, 0 discarded as invalid, 8.0 million tokens.

## 2. Held-out tasks, all seeds

The tuner did not use these tasks. `no rules` is the v0 harness. `oracle` is the complete rule set from the server profile.

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no rules | 24 | 3 | 13% (4% to 31%) | 0.35 | 145791 | 73 s | 6.4 | 18 |
| learned (tuner) | 72 | 64 | 89% (80% to 94%) | 0.98 | 23702 | 22 s | 0.4 | 0 |
| oracle | 48 | 48 | 100% (93% to 100%) | 1.00 | 20905 | 21 s | 1.2 | 0 |

For each seed:

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed 1: no rules | 8 | 0 | 0% (0% to 32%) | 0.29 | 146576 | 87 s | 6.9 | 7 |
| seed 1: learned | 24 | 23 | 96% (80% to 99%) | 0.99 | 22659 | 20 s | 0.0 | 0 |
| seed 1: oracle | 16 | 16 | 100% (81% to 100%) | 1.00 | 21226 | 21 s | 1.4 | 0 |
| seed 2: no rules | 8 | 2 | 25% (7% to 59%) | 0.47 | 156124 | 65 s | 6.4 | 6 |
| seed 2: learned | 24 | 23 | 96% (80% to 99%) | 0.99 | 21617 | 19 s | 0.2 | 0 |
| seed 2: oracle | 16 | 16 | 100% (81% to 100%) | 1.00 | 19770 | 21 s | 1.0 | 0 |
| seed 7: no rules | 8 | 1 | 13% (2% to 47%) | 0.29 | 134673 | 67 s | 5.9 | 5 |
| seed 7: learned | 24 | 18 | 75% (55% to 88%) | 0.95 | 26829 | 26 s | 1.0 | 0 |
| seed 7: oracle | 16 | 16 | 100% (81% to 100%) | 1.00 | 21720 | 22 s | 1.3 | 0 |

## 3. Pass rate for each kind of task

`no rules` uses the v0 runs on all three task sets. `learned` and `oracle` use the held-out runs.

| Kind | Depot calls | no rules | learned | oracle |
| --- | --- | --- | --- | --- |
| id | 1 | 7 of 9 | 9 of 9 | 6 of 6 |
| stock | 2 | 0 of 9 | 9 of 9 | 6 of 6 |
| price | 2 | 0 of 9 | 8 of 9 | 6 of 6 |
| both | 3 | 0 of 9 | 9 of 9 | 6 of 6 |
| order | 3 | 0 of 9 | 5 of 9 | 6 of 6 |
| compare | 4 | 0 of 9 | 6 of 9 | 6 of 6 |
| total | 4 | 0 of 9 | 9 of 9 | 6 of 6 |
| list | 2 | 4 of 9 | 9 of 9 | 6 of 6 |

## 4. Controls (seed 1, held-out tasks)

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| learned rules, `tuner.enabled` false | 16 | 2 | 13% (3% to 36%) | 0.33 | 149427 | 66 s | 5.9 | 13 |
| placebo: 10 unrelated rules | 16 | 1 | 6% (1% to 28%) | 0.32 | 148022 | 66 s | 6.7 | 13 |
| learned rules in a full-size file | 16 | 15 | 94% (72% to 99%) | 0.99 | 24412 | 10 s | 0.0 | 0 |
| solver litellm/deepseek-v4.1-flash, no rules | 16 | 3 | 19% (7% to 43%) | 0.44 | 108472 | 33 s | 5.3 | 7 |
| solver litellm/deepseek-v4.1-flash, learned rules | 16 | 16 | 100% (81% to 100%) | 1.00 | 21846 | 11 s | 0.0 | 0 |

## 6. Changed server (rules of seed 1, server on seed 5)

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old rules (stale) | 24 | 2 | 8% (2% to 26%) | 0.38 | 81226 | 113 s | 14.5 | 3 |
| after the tuner (v4) | 24 | 23 | 96% (80% to 99%) | 0.99 | 22544 | 13 s | 0.0 | 0 |

- v0: seed (round 0), scoring score 0.300, 10 rules.
- v1: proposer (round 1), scoring score 0.783, 10 rules.
- v2: proposer (round 2), scoring score 1.000, 10 rules.
- v3: proposer (round 3), scoring score 1.000, 10 rules.
- v4: removal (round 4), scoring score 1.000, 9 rules.

## 7. General tasks with no depot

The learned file of seed 1 has 3331 characters.

| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| learned rules on | 18 | 18 | 100% (82% to 100%) | 1.00 | 14266 | 10 s | 0.2 | 0 |
| learned rules off | 18 | 18 | 100% (82% to 100%) | 1.00 | 12339 | 12 s | 0.2 | 0 |

Runs that used the shell: 7 of 18 with the rules on, 9 of 18 with the rules off.

## Learned rules

### Seed 1 (v3)

```
- depot.depot_search: `q` must be a string wrapped as `[[WORD+WORD]]` — words upper case, joined with `+`, no spaces. Example: `mcp.depot.depot_search({q:'[[COPPER+FLANGE]]'})`. A bare string or a JS array is rejected.
- depot.depot_search: if the result reports multiple pages, fetch the next page with `page` formatted as the number then a slash, e.g. `{q:'[[COPPER]]', page:'2/'}`. Never pass `page:'[[2]]'`.
- depot tools: the job has one small shared quota (about 5 depot calls) across all depot tools. Count your calls before starting; on any `ERR_QUOTA` no reload, retry, wait, or new tool call can add calls, so get the formats right on the first try and never repeat a failed call blindly.
- depot tools: a format error message states exactly one rule for the offending argument; read it and change only that argument. Do not re-send the same wrong shape, and do not probe by guessing several variants of the same call.
- depot tools: call them as `mcp.depot.<tool>(args)` in fabric_exec, e.g. `await mcp.depot.depot_stock({part:'P#1002', region:'EAST', date:'2026-02-11'})`. Before calling, confirm argument shapes with `await tools.describe({ref:'mcp.depot.depot_stock'})` — `tools.describe` takes `{ref}`, not `{server}` or `{provider}`.
- depot task answer: after the depot calls succeed, write the answer with `pi.write({path:'answer.txt', text:'<answer>'})`. `pi.read`, `pi.bash`, and `pi.grep` on files are denied by policy, so do not try to read the answer back; treat a successful `pi.write` as done.
- depot tasks: choose the tool for the question — `depot_search` to find a part by name words, `depot_stock` for units in one region/date, `depot_price` for a price, plus `depot_reserve`/`depot_confirm` for orders. `depot_search` takes upper-case name words; every other tool has its own strict formats, so send each argument in depot form on the first call (a wrong shape is still charged to the quota, and `tools.describe` does not reveal these formats).
- depot tools `depot_stock`/`depot_price`/`depot_reserve`/`depot_confirm`: `part` is `P#`+number (search id `P-1004` becomes `part:'P#1004'`), `region` is the compass number (north `'1'`, east `'2'`, south `'3'`, west `'4'`), `date` is `MM/DD/YYYY` (`2026-04-13` becomes `'04/13/2026'`), and `qty` is `x`+number (`18` becomes `'x18'`). Each tool needs its own required args, so send them all on the first call: `depot_stock` = part+region+date (`await mcp.depot.depot_stock({part:'P#1002', region:'2', date:'02/11/2026'})`), `depot_price` = part+qty+`cur:'USD'` (`await mcp.depot.depot_price({part:'P#1003', qty:'x12', cur:'USD'})` -> `{"total":"108.00"}`), `depot_reserve` = part+region+qty with no date.
- depot.depot_confirm: needs `hold` and `pin` in one call. `hold` is the id exactly as `depot_reserve` returned it (`H-12303`; `H#12303` is refused), and `pin` is the digits of that hold id reversed (`H-40217` -> `pin:'71204'`). A wrong `hold` or `pin` voids the hold, so compute `pin` before calling; if the hold was voided, call `depot_reserve` again before confirming.
- depot.depot_stock: the default response can be a STALE snapshot; when the task needs the current count, pass the live flag in the same call, e.g. `await mcp.depot.depot_stock({part:'P#1002', region:'2', date:'02/11/2026', live:'yes'})`, so you spend one call instead of two.
```

### Seed 2 (v3)

```
- depot: call depot tools only as `mcp.depot.depot_search`, `mcp.depot.depot_stock`, `mcp.depot.depot_price`, `mcp.depot.depot_reserve`, `mcp.depot.depot_confirm`. `tools.describe({ref: 'depot.depot_search'})` and `tools.describe({server: 'depot'})` both error with "Unknown Fabric provider: depot"; if you need the schema, call `tools.search({query: 'depot'})`.
- depot: the job has a hard quota of 5 depot calls total, and a rejected call still counts against it. Never spend a call to probe a format; use the formats below on the first try.
- depot_search: `q` must be `<WORD+WORD>` with uppercase words joined by `+` and no spaces, e.g. `{q: '<COPPER+VALVE>'}`. Plain `'copper valve'`, `'<copper valve>'`, and `'<COPPER VALVE>'` are all rejected with ERR_FORMAT. Results give at most 3 matches per page.
- depot_search: the page argument is `p` plus the number with no wrapper, e.g. `{q: '<COPPER>', page: 'p2'}`; `page: '2'` and `page: '<2>'` are rejected. The error text states how many pages exist, so page once only if you actually need more matches.
- depot_stock: `part` is the search id with `-` changed to `#` (`P-1002` -> `P#1002`), `region` is a bare compass digit (north=1, east=2, south=3, west=4, e.g. `'2'`), `date` is `DD.MM.YYYY` (`2026-02-11` -> `'11.02.2026'`). Example: `{part: 'P#1002', region: '2', date: '11.02.2026'}`. A rejected call still consumes quota.
- depot_stock: a returned `snapshot: STALE` count is not the live stock; if the task needs the current count, use one call with `live: 'yes'` added, e.g. `{part: 'P#1002', region: '2', date: '11.02.2026', live: 'yes'}`.
- depot_price: `part` is `P#<n>` from the search id (`P-1003` -> `P#1003`), `qty` is the number then `ea` (`{qty: '12ea'}`), and `cur` is exactly lowercase `usd`. Example: `{part: 'P#1003', qty: '12ea', cur: 'usd'}`.
- depot_reserve and depot_confirm: reserve and confirm only after stock and price succeed; a confirm returns the order code, which is the only value to write for order tasks. Reserve/confirm consume quota, so do not call them to test arguments.
- depot_confirm: `pin` is required and equals the numeric part of the hold id plus the reserved quantity, e.g. hold `H-90414` reserved for 18 units -> `{hold: 'H-90414', pin: '90432'}` (90414 + 18). A confirm without the correct pin errors and voids that hold, so compute the pin before calling; if a hold is voided you must reserve again.
- task output: write the final answer to `answer.txt` with `pi.write({path: 'answer.txt', text: '...'})` — `pi.read`, `pi.ls`, and `pi.find` are denied by the Fabric approvals policy, so never use them to look for tool output or files.
- task output: when a needed depot value could not be obtained before the quota ran out, the depot tools return `ERR_QUOTA` on every later call; stop calling depot and write `UNKNOWN` rather than spending more turns.
```

### Seed 7 (v2)

```
- depot tools reject malformed input with `ERR_FORMAT` and charge the call against a small per-job quota, so always send the documented wire format on the first call; guessing argument names or shapes wastes quota (e.g. `depot_search({query: 'x'})` and `depot_search({q: 'copper gasket'})` both fail with zero useful data).
- depot.depot_search: takes exactly one arg `q`, a string wrapped as `q:` then the search words in UPPER CASE joined with `::` and a trailing `;` — no spaces inside. Example: `mcp.depot.depot_search({q: 'q:BRASS::ELBOW;'})`. The first attempt must already use this form; `{q: 'brass elbow'}`, `{q: 'q:brass elbow'}`, and `{query: ...}` are all rejected.
- depot.depot_price: args are `part` (lowercased catalog id with the dash removed, e.g. catalog `P-1003` -> `p1003`), `qty` (an `x` then the number, e.g. `x12`), and `cur` (e.g. `USD`). Send all three in that format on the first call.
- depot.depot_stock: takes three required args and ALL must be present and correctly formatted on the first call or the call is rejected and still charged: `part` (lowercased no-dash id, e.g. `p1004`), `region` (exactly `R-` + the lower-case region name, e.g. `west` -> `R-west`; a bare `west` or `R-West` is rejected), and `date` (reformatted to `DD.MM.YYYY` with dots, e.g. `2026-04-13` -> `13.04.2026`; the ISO form is rejected). Example: `mcp.depot.depot_stock({part: 'p1004', region: 'R-west', date: '13.04.2026'})`.
- depot.depot_price: the `cur` arg is the literal character `$`, not a currency code — `USD` is rejected with `ERR_FORMAT [cur]`. Full call: `mcp.depot.depot_price({part: 'p1008', qty: 'x24', cur: '$'})`.
- depot format errors reveal only ONE bad field per rejected call, so never probe field-by-field; assemble the whole arg object in the documented wire forms before the first call, and when a call is rejected fix the named field only.
- depot.depot_search: optional paging arg is `page` (not `p`) with the form `p` + number, e.g. page 3 -> `p3`; total pages are reported in the `page` error or result.
- depot.depot_reserve and depot.depot_confirm: these mutate state, so get `part`/`qty` right from the price or stock result before calling them; a rejected reserve still consumes quota.
- fabric discovery: `tools.list()` shows refs like `mcp.depot.depot_search`; call `tools.describe({ref: 'mcp.depot.depot_search'})` for each depot tool's exact schema instead of probing with trial calls, since every probe on a depot tool costs quota.
- pi.* filesystem tools (`pi.read`, `pi.bash`, `pi.grep`, `pi.ls`) are denied by the Fabric approvals policy in this environment, so do not use them to look up tool schemas or config; use `tools.list()`, `tools.describe()`, and `tools.catalog()` instead.
```

## First run and the corrections

The first run used 50.7 million tokens on the same seeds. It found two defects in the tuner, and the second run measures the corrections.

| Defect | Evidence in the first run | Correction |
| --- | --- | --- |
| The report for the proposer showed only the failed tool steps of a failed run. A call that succeeds with data that the task cannot use was not visible. | No seed learned the stale-data rule. `compare` tasks: 0 of 9 pass with the learned rules, 6 of 6 with the oracle rules. On the changed server, the proposer merged the old and the new search format into a text that the server accepts and that matches nothing. | The report shows the failed tool steps and a transcript excerpt for each failed run. |
| The learned rules had no scope. | All seeds learned a rule that the shell is denied, which is true only in this suite. On the general tasks, the runs that used the shell decreased from 12 of 18 to 6 of 18. | The proposer must start each rule with the server, tool, or kind of task that it applies to. |

| Measure | First run | Second run |
| --- | --- | --- |
| Held-out pass rate, learned rules, all seeds | 58 of 72 (81%) | 64 of 72 (89%) |
| Held-out pass rate, seed 1 / seed 2 / seed 7 | 21 / 19 / 18 of 24 | 23 / 23 / 18 of 24 |
| `compare` tasks with the learned rules | 0 of 9 | 6 of 9 |
| Changed server, after the tuner | 0 of 24 | 23 of 24 |
| General tasks: runs that used the shell, rules on / off | 6 / 12 of 18 | 7 / 9 of 18 |
| Other solver with the learned rules | 12 of 16 | 16 of 16 |

The first run also had a defect in the general tasks of the bench: the work directory took the module type from a `package.json` above it, so one task could not pass. Each general task has its own `package.json` now. For that reason, compare the pass rates of the general tasks only in the second run.

### Value of each learned rule (first run, seed 1, held-out tasks)

Each row is the learned file without one rule. The full file has a pass rate of 88% and a score of 0.98.

| Removed rule | Runs | Pass rate | Score change | Token change | Kinds that failed |
| --- | --- | --- | --- | --- | --- |
| - Call depot tools directly as `mcp.depot.depot_search`, `mcp.depot.depot_stock`, `mcp.depot.depot_price`, `mc… | 16 | 81% | -0.01 | +35024 | stock, compare |
| - Each job allows only 5 depot calls total, and a call rejected for bad format still counts. Send well-formed … | 16 | 88% | 0.00 | -79 | compare |
| - `depot_search` argument `q`: wrap the words in double square brackets, upper case, joined with `+` and no sp… | 16 | 44% | -0.25 | +13046 | stock, both, order, compare, total |
| - Part ids: write them as `P#<number>` (letter P, hash, digits). A catalog id printed `P-1002` becomes `P#1002… | 16 | 75% | -0.03 | +2092 | stock, order, compare |
| - `region`: a compass number, not a name: north=1, east=2, south=3, west=4. Example: `region: '2'`. | 16 | 81% | -0.01 | +2848 | both, compare |
| - `date`: US form `MM/DD/YYYY`, never ISO. Example: `2026-02-11` becomes `date: '02/11/2026'`. | 16 | 88% | -0.01 | +2030 | compare |
| - `page`: the number followed by a slash. Example: page 3 becomes `page: '3/'`. The error reports how many pag… | 16 | 81% | -0.01 | +2447 | price, compare |
| - Quantity argument `qty` is the letter `x` then digits, never bare digits: 24 becomes `qty: 'x24'`. This hold… | 16 | 75% | -0.03 | +380 | stock, price, compare |
| - `depot_price` arguments: `part` as `P#<number>`, `qty` as `x<digits>`, `cur` as the plain code, all without … | 16 | 69% | -0.05 | +3300 | both, compare, total |
| - `depot_reserve` arguments: `part` as `P#<number>`, `qty` as `x<digits>`, plus `region` and `date`. Example: … | 16 | 88% | 0.00 | +1015 | compare |
| - `depot_confirm` needs `hold` and `pin` together; `pin` is the digits of the hold id in reverse order. Exampl… | 16 | 75% | -0.02 | +2059 | both, order, compare |
| - Read task-relevant fields from each success before the next call; if a stock/price call returns nothing usef… | 16 | 88% | 0.00 | +1162 | compare |
| - Write the answer once at the end with `pi.write({path: 'answer.txt', content: ...})`. Do not use `pi.read`, … | 16 | 88% | 0.00 | +4465 | compare |

Only the search rule has a clear value. A difference of 1 or 2 runs in 16 is at the noise level.

## Suggestions from real sessions (live test)

This test is for `tuner.capture`: the mode that proposes rules from the tool failures of real sessions, with no task suite. See [the tuner guide](../../docs/tuner.md#suggestions-from-real-sessions).

Method: one agent directory with `tuner.capture` and `tuner.enabled` on and an empty `learned.md`. 16 Pi sessions ran in sequence, one for each feedback and scoring task, against the depot of seed 1. The sessions had a quota of 12 calls and no deny rules, so an agent with no rules can correct its calls. A script accepted each suggestion with no review. A person who reads each suggestion will get a better file.

| Session | Task | Result | Failed depot calls | Tokens | Suggestion accepted after it |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | id | pass | 3 of 4 | 132,767 | |
| 2 | stock | pass | 5 of 8 | 92,770 | search format |
| 3 | price | FAIL | 0 of 2 | 231,256 | Fabric `tools.call` refs |
| 4 | both | pass | 4 of 9 | 161,018 | stock and price formats |
| 5 | order | pass | 1 of 5 | 57,590 | |
| 6 | compare | pass | 0 of 6 | 23,799 | |
| 7 | total | pass | 0 of 4 | 47,888 | |
| 8 | list | pass | 1 of 3 | 26,656 | |
| 9 | id | pass | 0 of 1 | 12,216 | |
| 10 | stock | pass | 0 of 3 | 25,955 | |
| 11 | price | FAIL | 1 of 3 | 116,093 | |
| 12 | both | FAIL | 1 of 6 | 51,980 | stock and price formats, second edit |
| 13 | order | pass | 1 of 5 | 121,611 | |
| 14 | compare | pass | 0 of 6 | 24,720 | |
| 15 | total | pass | 0 of 4 | 17,980 | |
| 16 | list | FAIL | 3 of 13 | 78,512 | |

| Measure | Sessions 1 to 8 | Sessions 9 to 16 (the same 8 kinds) |
| --- | ---: | ---: |
| Mean tokens for each session | 96,718 | 56,133 |
| Failed depot calls | 14 of 41 | 6 of 41 |
| Sessions that passed | 7 of 8 | 5 of 8 |

The failed depot calls and the tokens decreased. The pass rate did not increase: with a quota of 12 calls, an agent with no rules can recover. The two `price` sessions failed on the format of the answer, which no rule covers.

The final file has 4 rules and 1,872 characters. The loop made 4 proposer calls. In an earlier test, one proposer call used 1,107 tokens.

| Rule | Assessment |
| --- | --- |
| `depot_search`: the format of `q` | Correct and complete |
| `depot_stock` and `depot_price`: the formats of `part`, `region`, `date`, `qty`, and `cur` | The formats are correct. The rule also tells the agent to use only `tools.call`, which is false. |
| `fabric_exec`: refs of `tools.call` | Partly wrong. It tells the agent that `tools.search` and `tools.providers` do not exist. |
| `fabric_exec`: the code must be valid JavaScript | True, with small value |

The held-out tasks give the comparison with the tuner. The conditions are those of the bench: seed 1, a quota of 5 calls, and the deny rules of the suite.

| Harness | Runs | Pass | Rate (95% interval) | Mean tokens |
| --- | ---: | ---: | --- | ---: |
| No rules | 8 | 0 | 0% (0% to 32%) | 146,576 |
| Rules from the live test: 16 sessions, 4 proposer calls | 16 | 10 | 63% (39% to 82%) | 43,861 |
| Rules from the tuner: 4 rounds, 7.5 million tokens | 24 | 23 | 96% (80% to 99%) | 22,659 |
| Oracle rules | 16 | 16 | 100% (81% to 100%) | 21,226 |

With the rules from the live test, `id`, `stock`, `price`, `both`, and `total` pass in all runs. `order`, `compare`, and `list` fail in all runs. Their rules are the pin, the stale data, and the paging. The capture cannot find the stale data and the paging, because those calls return no error.

A second check used one Pi process in RPC mode with `tuner.autoAccept` on. The user corrected the agent 3 times about lower case file names. Fabric started the proposer after the third correction, wrote one rule to `learned.md` with no review, and showed the notice in the next session. `pi-fabric tune undo` removed the rule. The rule was more general than the corrections: it tells the agent to obey each convention that the user states.

An early version started the proposer at the third failure. Its suggestion was incomplete, because the agent did not yet have a correct call. The trigger now waits for the first call that succeeds after the failures.

## Limits

- The live test has 16 sessions and one seed. Its differences are at the noise level, except for the held-out comparison with no rules.
- The bench is synthetic. A model cannot know the rules of the depot before a run, so the gain is near the best case. The bench does not show the size of the gain on real coding work.
- Seed 7 stays at 18 of 24 in the two runs. Its tuner run did not learn the pin rule or the stale-data rule in 4 rounds.
- The partial score of a failed task counts successful depot calls. A call that succeeds with data that the task cannot use also counts.
- One tuner run used 7 to 8 million tokens. The 16 runs with no rules at the start use approximately 2.2 million of them.
