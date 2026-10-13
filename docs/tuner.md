# Harness tuner

The tuner improves the harness of a model from execution feedback. The model does not change. The idea comes from "Harness Learning Enables Generalizable Test-Time Adaptation" (arXiv 2609.35738). Fabric uses the test-time loop of that paper with a standard proposer model. Fabric does not train a proposer.

The harness that the tuner edits is one file of learned rules, `<agent-dir>/fabric/tuner/learned.md`. The tuner is off by default.

## Use the learned rules

```json
{ "tuner": { "enabled": true, "proposerModel": "provider/model" } }
```

- `tuner.enabled` (default `false`) adds the learned rules to the system prompt at `before_agent_start`. Fabric reads the file one time for each session, so the prompt prefix stays stable. Fabric uses a maximum of 8,000 characters.
- `tuner.proposerModel` (default `""`) is the Pi `provider/model` that proposes edits in `pi-fabric tune`. An empty value selects the solver model.

Each rule in `learned.md` is one `- ` bullet.

## Suggestions from real sessions

```json
{ "tuner": { "capture": true, "autoAccept": false, "proposerModel": "provider/model" } }
```

`tuner.capture` (default `false`) makes Fabric propose rules from the tool failures of your real sessions and from your corrections. This mode needs no task suite, and you make the decision on each rule. The **Tuner** section of `/fabric settings` has the same switches.

`/fabric tuner` changes the same values from the prompt, with completion for each key and value:

```text
/fabric tuner                          # show the values, the number of learned rules, and a suggestion that waits
/fabric tuner enabled on|off
/fabric tuner capture on|off
/fabric tuner autoAccept on|off
/fabric tuner proposerModel            # select a model from the Pi model list
/fabric tuner proposerModel <provider/model>|inherit
```

The command saves to the project `fabric.json` in a trusted project, and to the global file in other sessions.

1. **Capture.** Fabric records each failed top-level tool result in `<agent-dir>/fabric/tuner/failures.jsonl`. Fabric also records the first call to the same target that succeeds after a failure. The target is the first `mcp.<server>.<tool>` or `pi.<tool>` in the call. A call with no such name has the tool name as its target.
2. **Corrections.** Fabric also records a message in which you correct the agent, with the last tool call of the agent as context. A message is a correction when it starts with a word such as "no", "do not", "stop", "wrong", "never", or "I told you". The target of these steps is `user`.
3. **Trigger.** When a target has 3 failures and then a success, Fabric starts `pi-fabric tune suggest` as a separate process. A target that only fails starts it at 6 failures. 3 corrections also start it.
4. **Suggestion.** The proposer gets the current `learned.md` and the captured steps of the target. It writes one edit, or it answers that no rule is necessary. Fabric saves an edit in `suggestion.json`.
5. **Decision.** While a suggestion waits, Fabric shows one notice at the first tool result of a Pi process. Use these commands:

```sh
pi-fabric tune review   # the diagnosis, the rules that the edit adds and removes, and the evidence
pi-fabric tune accept   # write the edit to learned.md
pi-fabric tune reject   # discard the edit
pi-fabric tune undo     # remove the last accepted edit from learned.md
pi-fabric tune suggest --min 1   # start a suggestion by hand for each target with a failure
```

`tuner.autoAccept` (default `false`) removes the decision step. Fabric writes each suggestion to `learned.md` with no review and shows one notice with the edit. `accepted.jsonl` records each accepted edit with its diagnosis, and `pi-fabric tune undo` removes the last one. A suggestion has no score and can be wrong, so use this switch only when you read the notices.

This mode has these limits:

- **With `tuner.autoAccept` off, no rule enters `learned.md` without `pi-fabric tune accept`.** Fabric does not do a real task again, so a suggestion has no score. You are the judge.
- **One suggestion at a time.** Fabric starts no proposer call while a suggestion waits.
- **Bounded cost.** A proposer call uses the captured steps of its targets and then deletes them. It also doubles the number of failures that those targets need for the next call.
- **Untrusted text.** A tool result can contain instructions. The proposer prompt identifies the report as data. Read each suggestion before you accept it.
- **Detection is a heuristic.** A result is a failure when Pi marks it as an error, when it starts with an error word, or when it contains `Error: `. The word list for corrections is English.
- **Bounded file.** At 1 MB, Fabric drops the older half of `failures.jsonl`.
- **Only failures.** A call that returns wrong data with no error gives the capture no step. Use `pi-fabric tune run` with a task suite for such rules.

[bench/tuner/RESULTS.md](../bench/tuner/RESULTS.md) has a live test of this mode.

## Task suite

A task is a directory:

| File | Purpose |
| --- | --- |
| `task.md` | The prompt |
| `check.sh` | Exit code 0 is a pass. The script can print `score: <0..1>` for a partial score. |
| `setup.sh` | Optional. Runs in the work directory before the agent. |
| `fixture/` | Optional. Fabric copies it into the work directory. |

The tasks directory can also contain these files:

| File | Purpose |
| --- | --- |
| `splits.json` | `{ "feedback": [], "scoring": [], "heldout": [] }`. The three sets must be disjoint. Without the file, Fabric assigns the sorted task names in turn. |
| `SUITE.md` | A description of the suite for the proposer |
| `mcporter.json` | MCP servers for the tasks. Fabric replaces `{{CELL}}` with the identifier of the run. |
| `fabric.json` | Fabric configuration for each run, for example `approvals.actions` rules that deny the shell |

`check.sh` and `setup.sh` get `TUNER_CELL` (the identifier of the run) and `TUNER_CELL_DIR`.

## Commands

```sh
pi-fabric tune eval  --tasks <dir> --set feedback            # one harness, one report
pi-fabric tune run   --tasks <dir> --rounds 5 --candidates 4 # the loop
pi-fabric tune apply --dir <out>                             # copy the last kept version to the agent directory
```

`pi-fabric tune suggest`, `review`, `accept`, `reject`, and `undo` are for [suggestions from real sessions](#suggestions-from-real-sessions).

`--model` selects the solver and `--proposer` selects the proposer. Both take a `provider/model` key from `pi --list-models`. `--budget <tokens>` and `--budget-usd <usd>` stop the loop cleanly. `--timeout` and `--max-tokens` limit one task run. `--reps` runs each task more than one time.

## One round

1. The proposer gets the suite description, the current `learned.md`, the report on the feedback set, and the list of earlier edits. For a failed run, the report shows the failed tool steps and an excerpt of the transcript. Each proposer call returns a diagnosis and SEARCH/REPLACE blocks.
2. Fabric discards an edit that does not apply, that changes nothing, or that makes the file larger than 200 lines or 8,000 characters. Before it discards the edit, Fabric asks the proposer one more time and gives the reason.
3. When the file has entries, one candidate slot is a removal test: the file without the entry that has the oldest confirmation.
4. Fabric runs each candidate on the scoring set.
5. The best candidate replaces the parent when it has a higher score, or the same score with at least 10% fewer tokens. A removal candidate also wins an equal score.
6. A removal candidate with a lower score confirms the value of its entry. `rules.json` records the value and the tasks that the entry helped.
7. Fabric runs the kept version on the feedback set and writes the next report.

After the last round, Fabric runs `v0` and the last kept version on the held-out set.

## Outputs

| Path | Content |
| --- | --- |
| `harnesses/vN/learned.md` | Each kept version, in a Git repository with the scores in each commit message |
| `diffs/vN.diff` | The diff of each kept edit |
| `reports/vN.md` | The report on the feedback set, at most 24,000 characters |
| `results.csv` | One row for each candidate: version, parent, scores, tokens, spend |
| `rules.json` | The record of each entry: version that added it, last confirmation, value |
| `tuples.jsonl` | Each (report, harness, edit, reward) tuple, for later proposer training |
| `summary.md` | The kept edits and the held-out comparison |
| `cells/` | The trimmed transcript and the result of each run |

## Isolation and limits

- Each run gets a new work directory and a new agent directory. The agent directory holds the credentials of the selected model provider, the Fabric configuration, and the candidate `learned.md`. Fabric deletes it after the run.
- `pi-fabric tune run` and `pi-fabric tune eval` do not write to the real agent directory. Only `pi-fabric tune apply`, `pi-fabric tune accept`, and `pi-fabric tune undo` write `learned.md` there. With `tuner.capture` on, sessions and `pi-fabric tune suggest` write `failures.jsonl`, `suggestion.json`, and `accepted.jsonl` there. With `tuner.autoAccept` on, `pi-fabric tune suggest` also writes `learned.md`.
- A run is a process in a directory. It is not a container. Run only tasks that you wrote. Use `fabric.json` in the tasks directory to deny the shell when the tasks do not need it.
- The token total includes cached input tokens.
- The scores of a small scoring set are noisy. Use `--reps`, partial scores, or more tasks before you trust a small difference.

## Benchmark

`bench/tuner` has a bench server, a task suite, and a driver for the tuner. The server is an MCP server with rules that its tool schema hides. [bench/tuner/README.md](../bench/tuner/README.md) gives the commands, and [bench/tuner/RESULTS.md](../bench/tuner/RESULTS.md) gives the measured results and the limits.
