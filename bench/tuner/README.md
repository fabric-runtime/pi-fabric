# bench/tuner: quirk depot

A bench for the [harness tuner](../../docs/tuner.md). It measures one thing: can the tuner learn the rules of an MCP server that the tool schema does not show?

## The server

`quirk-server.mjs` is one process with three surfaces:

| Surface | Path | Purpose |
| --- | --- | --- |
| HTTP backend | `/api/search`, `/api/stock`, `/api/price`, `/api/reserve`, `/api/confirm` | The depot data with strict rules |
| MCP server | `/mcp/<cell>` | The same five operations as MCP tools. The path names the run. |
| Admin | `/admin/profile`, `/admin/cell/<cell>` | Read or change the rules, and read the call log of a run |

The depot has four classes of rule. Each class gives a different feedback signal:

| Class | Rule | Signal |
| --- | --- | --- |
| Format | Each field has an unusual format | `ERR_FORMAT` with the first violated rule only |
| Paging | A search returns 3 matches for each page, and the `page` field has its own format | `more: true` in a successful result |
| Stale data | `depot_stock` needs one more field that the schema does not show | No error. The call returns an old count and a note. |
| Protocol | `depot_confirm` needs a pin that comes from the hold id | `ERR_PIN`, and the hold becomes void |

Each run has a quota of calls (default 5), so an agent that does not know the rules uses its quota on errors.

The rules come from a seed. Change them while the server runs:

```sh
node quirk-server.mjs --port 4747 --seed 1 --quota 5
curl localhost:4747/admin/profile                          # the active rules
curl -X POST localhost:4747/admin/profile -d '{"seed":2}'  # new rules, same data
node quirk-server.mjs --oracle --seed 1                    # the complete rules as a learned.md
node quirk-server.mjs --demo                               # self-check
```

## The tasks

`node quirk-server.mjs --make-tasks tasks` writes 24 tasks: 8 kinds of question in each of three disjoint sets (feedback, scoring, held-out). The kinds need 1 to 4 successful depot calls. The answers do not depend on the seed. `tasks/fabric.json` denies the shell and file reads, so an agent cannot read the server source or call the depot outside its quota.

## One tuner run

```sh
bun run build
node bench/tuner/quirk-server.mjs &
node dist/cli/index.js tune run --tasks bench/tuner/tasks --dir bench/results/tuner/run1 \
  --model litellm/deepseek-v4.1-flash --writer litellm/deepseek-v4.1-flash
```

## The full bench

```sh
bun run build
node bench/tuner/bench.mjs --out bench/results/tuner/full --rounds 8 \
  --model litellm/deepseek-v4.1-flash:max --writer litellm/deepseek-v4.1-flash:max \
  --transfer-model litellm/deepseek-v4.1-flash:max
```

The full bench does approximately 600 task runs. It takes 30 to 45 minutes and uses 45 million tokens with cached input included.

## A quick run

Use one seed and no control parts when you change the tuner and want a fast answer:

```sh
node bench/tuner/bench.mjs --out bench/results/tuner/quick --seeds 1 --rounds 8 \
  --skip controls,loo,drift,general --model <provider/model> --writer <provider/model>
```

To do one part again, delete its directory in the output directory and give the same command. For example, delete `live/` and `seed-1/arms/live/` to do only the session part again. That takes approximately 12 minutes.

Do not run `bun run build` while a bench runs. The build deletes `dist/`, and the bench uses it.

`bench.mjs` starts its own servers and writes `REPORT.md` and `results.json`. It runs these parts:

| Part | Content |
| --- | --- |
| Tuner runs | One run for each seed (default seeds 1, 2, and 7). Each seed is a different set of rules. |
| Held-out arms | No rules, the learned rules, and the complete rules, for each seed |
| Controls | The learned rules with `tuner.enabled` false, 10 unrelated rules, the learned rules in a file of 7,900 characters, and a different main model when `--transfer-model` is not the main model |
| Rule values | The learned file without one rule, for each rule |
| Changed server | The learned rules of the first seed on a server with a different seed, then a tuner run that starts from them |
| General tasks | 6 small coding tasks with no depot, with the learned rules on and off |
| One switch | 16 Pi sessions in one agent directory with only `tuner.enabled` on. Fabric writes the rules from the failures of the sessions with no review. The depot then changes to the rules of a different seed, and 16 more sessions run. The held-out tasks run with the rules from before and after the change. This part starts together with the tuner runs. |

Each part skips itself when its output is there, so you can start a stopped bench again with the same command. `--skip controls,loo,drift,general,live` runs only the tuner runs and the held-out arms.

[RESULTS.md](RESULTS.md) has the results of the last full bench.

The bench is synthetic. It shows that the loop works on rules that a model cannot know before the run. It does not show the size of the gain on real coding work.
