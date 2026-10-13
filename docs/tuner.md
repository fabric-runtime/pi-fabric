# Harness tuner

The tuner improves the harness of a model from execution feedback. The model does not change. The idea comes from "Harness Learning Enables Generalizable Test-Time Adaptation" (arXiv 2609.35738). Fabric uses the test-time loop of that paper with a standard proposer model. Fabric does not train a proposer.

The harness that the tuner edits is one file of learned rules, `<agent-dir>/fabric/tuner/learned.md`. The tuner is off by default, and one switch turns it on.

## Contents

- [The goal](#the-goal)
- [Benefits](#benefits)
- [What to expect](#what-to-expect)
- [Turn it on](#turn-it-on)
- [How Fabric learns from sessions](#how-fabric-learns-from-sessions)
- [Task suite](#task-suite), [commands](#commands), [one round](#one-round), and [outputs](#outputs)
- [Isolation and limits](#isolation-and-limits)
- [Method](#method)
- [Benchmark](#benchmark)

## The goal

An agent starts each session with no knowledge of your environment. It does not know the formats that your tools accept, the order of their calls, or your conventions. It finds them by trial and error, and it does the same trial and error in the next session.

The tuner keeps what a session found. It writes short rules for your environment into one file, and Fabric gives that file to the agent at the start of each session. The model stays the same. Only its instructions change.

The tuner has two sources of rules:

| Source | What you do | How Fabric knows that a rule is good |
| --- | --- | --- |
| Your sessions | Nothing. Fabric records repeated tool failures and your corrections. | It does not know. A rule from a session has no score. |
| A task suite | You write tasks with a check script, and you run `pi-fabric tune run`. | Scoring tasks select each edit, and held-out tasks give the final comparison. |

## Benefits

| Benefit | Cause |
| --- | --- |
| More tasks pass on tools with rules that the schema hides | The agent gets the formats, the call order, and the hidden fields of your tools before its first call. |
| Fewer tokens and less time | The agent stops its trial and error at the start of each session. |
| No work for the user | With the tuner on, the rules come from your normal sessions. |
| Measured rules when you want them | With a task suite, each edit has a measured value on tasks that the proposer did not see. |
| Repair after a tool change | A new tuner run on the changed tool corrects the rules that became wrong. |
| Same model, any Pi model | The solver and the proposer are `provider/model` keys from `pi --list-models`. The rules that one solver learned also helped a second solver. |
| Bounded prompt cost | Fabric reads one file of at most 8,000 characters one time for each session, so the prompt prefix stays stable. |
| You own the result | The rules are plain text in one file. Fabric records each rule that it adds, and `pi-fabric tune undo` removes the last one. |

## What to expect

These statements come from the [benchmark](#benchmark). The benchmark is synthetic, so use the numbers as an upper limit.

Expect a gain in these conditions:

- **A tool has rules that its schema does not show.** On the bench, held-out tasks pass in 13% of the runs with no rules and in 89% with the rules of a tuner run.
- **The agent uses its calls on errors.** With the rules, a run on the bench uses approximately one sixth of the tokens.
- **You use the same environment again and again.** In the two live tests, the first rule from sessions came after the second session.

Do not expect these things:

- **A gain on tasks that the model does well.** On general coding tasks, all runs passed with the rules on and with the rules off. The rules add approximately 2,000 tokens to each run.
- **A correct rule each time from sessions.** In the live test, 1 of 4 rules from sessions was partly wrong. Read the notices.
- **Rules for failures that give no error.** The learning from sessions finds only calls that fail. A call that returns stale data or one page of a list gives it nothing. A task suite finds those rules.
- **A low cost for a tuner run.** One run of `pi-fabric tune run` on the bench used 7 to 8 million tokens with cached input included. A rule from a session used approximately 1,100 tokens for its proposer call.
- **A proof for real coding work.** No measurement of the gain on real projects exists yet.

## Turn it on

```text
/fabric tuner on
```

or in `fabric.json`:

```json
{ "tuner": { "enabled": true } }
```

`tuner.enabled` (default `false`) is the one switch. With it on, Fabric does these things:

- It adds the learned rules to the system prompt at `before_agent_start`. Fabric reads the file one time for each session, so the prompt prefix stays stable. Fabric uses a maximum of 8,000 characters.
- It learns new rules from your sessions: it records repeated tool failures and your corrections, and a proposer model writes a rule from them.
- It writes each new rule to `learned.md`, shows a notice with the rule, and records the edit. `pi-fabric tune undo` removes the last one.

Each rule in `learned.md` is one `- ` bullet.

Three options change this behavior. You do not have to set them.

| Option | Default | Effect |
| --- | --- | --- |
| `tuner.capture` | `true` | `false` stops the learning from sessions. Fabric then only reads `learned.md`. |
| `tuner.autoAccept` | `true` | `false` keeps each new rule as a suggestion. You decide with `pi-fabric tune review`, `accept`, and `reject`. |
| `tuner.proposerModel` | `""` | The Pi `provider/model` that writes the rule edits. An empty value selects the default model of Pi. |

The **Tuner** section of `/fabric settings` has the switch and the options. `/fabric tuner` changes the same values from the prompt, with completion for each key and value:

```text
/fabric tuner                          # show the values, the number of learned rules, and a suggestion that waits
/fabric tuner on|off
/fabric tuner capture on|off
/fabric tuner autoAccept on|off
/fabric tuner proposerModel            # select a model from the Pi model list
/fabric tuner proposerModel <provider/model>|inherit
```

The command saves to the project `fabric.json` in a trusted project, and to the global file in other sessions.

## How Fabric learns from sessions

1. **Capture.** Fabric records each failed top-level tool result in `<agent-dir>/fabric/tuner/failures.jsonl`. Fabric also records the first call to the same target that succeeds after a failure. The target is the first `mcp.<server>.<tool>` or `pi.<tool>` in the call. A call with no such name has the tool name as its target.
2. **Corrections.** Fabric also records a message in which you correct the agent, with the last tool call of the agent as context. A message is a correction when it starts with a word such as "no", "do not", "stop", "wrong", "never", or "I told you". The target of these steps is `user`.
3. **Trigger.** When a target has 3 failures and then a success, Fabric starts `pi-fabric tune suggest` as a separate process. A target that only fails starts it at 6 failures. 3 corrections also start it.
4. **Repair.** A target can fail again after Fabric wrote a rule for it, because the tool changed or because the rule is wrong. The same thresholds then start the proposer again. When a later call succeeded, the proposer corrects the rule from that call. When no call succeeded, the proposer removes the rule, because the agent finds a format faster with no rule than with a wrong one.
5. **Rule.** The proposer gets the current `learned.md` and the captured steps of the target. It writes one edit, or it answers that no rule is necessary.
6. **Accept.** Fabric writes the edit to `learned.md` and shows one notice with the edit at the next tool result. `accepted.jsonl` records each accepted edit with its diagnosis. A new rule has no score and can be wrong, so read the notices.

```sh
pi-fabric tune undo     # remove the last accepted edit from learned.md
pi-fabric tune suggest --min 1   # start the proposer by hand for each target with a failure
```

With `tuner.autoAccept` set to `false`, step 6 changes. Fabric saves the edit in `suggestion.json` and shows a notice. Use these commands:

```sh
pi-fabric tune review   # the diagnosis, the rules that the edit adds and removes, and the evidence
pi-fabric tune accept   # write the edit to learned.md
pi-fabric tune reject   # discard the edit
```

The learning from sessions has these limits:

- **A new rule has no score.** Fabric does not do a real task again, so nothing measures the rule. Set `tuner.autoAccept` to `false` when you want to be the judge of each rule.
- **One suggestion at a time.** Fabric starts no proposer call while a suggestion waits.
- **Bounded cost.** A proposer call uses the captured steps of its targets and then deletes them. A call that gives no rule also doubles the number of failures that those targets need for the next call. `suggest.log` records each proposer call and its outcome.
- **Untrusted text.** A tool result can contain instructions. The proposer prompt identifies the report as data. Read each notice, and use `pi-fabric tune undo` for a rule that is wrong.
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
pi-fabric tune run   --tasks <dir> --rounds 8 --candidates 4 # the loop
pi-fabric tune apply --dir <out>                             # copy the last kept version to the agent directory
```

`pi-fabric tune suggest`, `review`, `accept`, `reject`, and `undo` are for [the learning from sessions](#how-fabric-learns-from-sessions).

`--model` selects the solver and `--proposer` selects the proposer. Both take a `provider/model` key from `pi --list-models`. A key can end with a thinking level, for example `provider/model:high`. With no level, a model uses the `defaultThinkingLevel` of your Pi settings, so a tuner run thinks as much as your sessions do. `tuner.proposerModel` accepts the same form. `--budget <tokens>` and `--budget-usd <usd>` stop the loop cleanly. `--timeout` and `--max-tokens` limit one task run. `--reps` runs each task more than one time.

## One round

1. The proposer gets the suite description, the current `learned.md`, the report on the feedback set, and the list of earlier edits. For a failed run, the report shows the failed tool steps and an excerpt of the transcript. Each proposer call returns a diagnosis and SEARCH/REPLACE blocks.
2. Fabric discards an edit that does not apply, that changes nothing, or that makes the file larger than 200 lines or 8,000 characters. Before it discards the edit, Fabric asks the proposer one more time and gives the reason.
3. When the file has entries, one candidate slot is a removal test: the file without the entry that has the oldest confirmation.
4. Fabric runs each candidate on the scoring set.
5. The best candidate replaces the parent when it has a higher score, or the same score with at least 10% fewer tokens. A removal candidate also wins an equal score. At a score of 0, only a higher score wins, because fewer tokens then only shows that the agent stops earlier.
6. A removal candidate with a lower score confirms the value of its entry. `rules.json` records the value and the tasks that the entry helped.
7. Fabric runs the kept version on the feedback set and writes the next report.

The loop stops before `--rounds` in two conditions: the scoring score is 1.00, or 2 rounds in sequence kept no edit. At a scoring score of 0.8 and above, a round uses half of the candidates, because their scores are then almost the same.

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
- `pi-fabric tune run` and `pi-fabric tune eval` do not write to the real agent directory. Only `pi-fabric tune apply`, `pi-fabric tune accept`, and `pi-fabric tune undo` write `learned.md` there. With the tuner on, sessions and `pi-fabric tune suggest` write `failures.jsonl`, `accepted.jsonl`, and `learned.md` there. With `tuner.autoAccept` set to `false`, `pi-fabric tune suggest` writes `suggestion.json` and does not write `learned.md`.
- A run is a process in a directory. It is not a container. Run only tasks that you wrote. Use `fabric.json` in the tasks directory to deny the shell when the tasks do not need it.
- The token total includes cached input tokens.
- The scores of a small scoring set are noisy. Use `--reps`, partial scores, or more tasks before you trust a small difference.

## Method

The method comes from the paper [Harness Learning Enables Generalizable Test-Time Adaptation](https://arxiv.org/abs/2609.35738). The paper changes the harness of a model at test time and keeps the model fixed. Its loop has four steps: run tasks, write a report of the runs, let a proposer edit the harness, and keep an edit only when the score is better.

Fabric uses that loop with these decisions:

| Subject | Decision in Fabric |
| --- | --- |
| The harness | One Markdown file of rules, `learned.md`. Fabric does not edit skills, tools, or its own prompt. |
| The proposer | A standard model from the Pi model list. Fabric trains no proposer. |
| The report | For each failed run: the failed tool steps and an excerpt of the transcript, at most 24,000 characters in total. |
| The edit | SEARCH/REPLACE blocks on `learned.md`. Fabric asks one more time when an edit does not apply. |
| The selection | A candidate replaces its parent on a higher score on the scoring set, or on the same score with at least 10% fewer tokens. |
| Old rules | One candidate in each round is the file without its oldest rule, so a rule with no value leaves the file. |
| Three task sets | The proposer gets reports from the feedback set only. The scoring set selects. The held-out set gives the final comparison. |
| Scope of a rule | The proposer must start each rule with the tool or the kind of task that it applies to. |
| Data for later | `tuples.jsonl` keeps each (report, harness, edit, reward) tuple, so a proposer can get training later. |

The learning from sessions is an addition of Fabric. It uses the same proposer and the same edit format, but it has no scoring step, because Fabric does not do a real task again. A real task can have effects that must not occur two times.

## Benchmark

`bench/tuner` has a bench server, a task suite, and a driver. [bench/tuner/README.md](../bench/tuner/README.md) gives the commands, and [bench/tuner/RESULTS.md](../bench/tuner/RESULTS.md) gives all the results.

### Design

- **Server.** The quirk depot is an MCP server with 5 tools and a catalog of 42 parts. Its rules are not in the tool schema, and they come from a seed. A model cannot know them before a run.
- **Four classes of rule.** Field formats (an error names the first violated rule only), paging, stale data with no error, and a reserve and confirm protocol with a pin.
- **Quota.** Each run can make 5 depot calls, so an agent with no rules uses its calls on errors.
- **Tasks.** 24 tasks: 8 kinds of question in each of 3 disjoint sets (feedback, scoring, held-out). Each task has a check script with an exact answer.
- **Isolation.** Each run gets a new work directory and a new agent directory. The suite denies the shell and file reads, so an agent cannot read the server source.
- **Models.** The solver is `glm-5.3-flash` and the proposer is `deepseek-v4.1-flash`.
- **Tuner runs.** 3 seeds (3 different sets of rules), 4 rounds, and 4 candidates in each round.
- **Arms on the held-out set.** No rules, the learned rules (2 repetitions), and oracle rules that a script writes from the server profile.
- **Controls.** The learned rules with the switch off, 10 unrelated rules, the learned rules in a file of 7,900 characters, a second solver, a changed server, general coding tasks with no depot, and the learned file without one rule.
- **Measures.** The pass rate with a 95% interval, the mean tokens for each run with cached input included, and the mean time.

### Results on held-out tasks

| Harness | Runs | Pass rate (95% interval) | Mean tokens for each run | Mean time |
| --- | ---: | --- | ---: | ---: |
| No rules | 24 | 13% (4% to 31%) | 145,791 | 73 s |
| Learned rules after 4 tuner rounds | 72 | 89% (80% to 94%) | 23,702 | 22 s |
| Oracle rules | 48 | 100% (93% to 100%) | 20,905 | 21 s |

Two seeds reach 23 of 24. One seed stays at 18 of 24, because its tuner run did not learn the pin rule or the stale-data rule.

### Controls

| Control or condition | Runs | Pass rate | What it shows |
| --- | ---: | --- | --- |
| Learned rules with `tuner.enabled` set to `false` | 16 | 13% | The gain comes from the rules in the prompt. |
| Placebo: 10 unrelated rules | 16 | 6% | More prompt text gives no gain. |
| Learned rules in a file of 7,900 characters | 16 | 94% | The rules work at the size limit. |
| Second solver: no rules, then the same learned rules | 16 each | 19%, then 100% | The rules help a model that did not learn them. |
| Changed server: stale rules, then the rules after a new tuner run | 24 each | 8%, then 96% | Stale rules fail, and a new run repairs them. |
| General coding tasks with no depot: rules on and rules off | 18 each | 100% and 100% | The rules do no damage to unrelated tasks. |

### Rules from sessions

A live test ran 16 Pi sessions in sequence on the depot of one seed, with a quota of 12 calls. Fabric wrote 4 rules from 4 proposer calls, with no review.

| Harness on the held-out tasks of that seed | Runs | Pass rate (95% interval) | Mean tokens for each run |
| --- | ---: | --- | ---: |
| No rules | 8 | 0% (0% to 32%) | 146,576 |
| Rules from the 16 sessions | 16 | 63% (39% to 82%) | 43,861 |
| Rules from a tuner run | 24 | 96% (80% to 99%) | 22,659 |

In the sessions, the mean tokens fell from 96,718 (sessions 1 to 8) to 56,133 (sessions 9 to 16), and the failed depot calls fell from 14 to 6. One of the 4 rules was partly wrong.

### What the bench corrected

The first full run found two defects in the tuner, and the numbers above are from the second run.

- The report hid the successful tool results of a failed run, so no seed learned the stale-data rule. The report now adds a transcript excerpt. The held-out pass rate went from 81% to 89%.
- The rules had no scope. A rule that was true only in the bench halved the use of the shell on unrelated tasks. The proposer must now start each rule with the tool or the kind of task.

### Limits of the bench

- The bench is synthetic. The depot rules are unknown to the model, so the gain is near the best case.
- The bench does not measure real coding work.
- The live test has 16 sessions and one seed.
- The partial score of a failed task counts successful depot calls, also calls with data that the task cannot use.
