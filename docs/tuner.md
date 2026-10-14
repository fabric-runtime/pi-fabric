# Harness tuner

The tuner gives your agent a memory for the rules of your tools. When the agent finds the correct way to call a tool after some failures, Fabric writes a short rule. The next session starts with that rule, so it does not make the same failures again.

The model does not change. Only its instructions change. The tuner is off by default, and one switch turns it on: `/fabric tuner on`.

## Summary

### What you get

The numbers come from the [benchmark](#benchmark): a tool with rules that its schema does not show, and tasks that the tuner did not see. The model is `deepseek-v4.1-flash` at the `max` thinking level.

| Measure | Tuner off | Tuner on, rules from 16 sessions | Tuner on, rules from a tuner run |
| --- | ---: | ---: | ---: |
| Tasks that pass | 17% | 81% | 97% |
| Mean tokens for each task | 78,394 | 30,487 | 32,065 |
| Work for you | | One command | A task suite and one command |
| Cost of the rules | | 5,046 tokens for 3 rules | 4 to 14 million tokens, one time |

```text
Tasks that pass (each block is 5 points)

Tuner off                      17%  ███
Rules from 16 sessions         81%  ████████████████
Rules from a tuner run         97%  ███████████████████
Complete rules, from a script  90%  ██████████████████
```

| Benefit | Cause |
| --- | --- |
| More tasks pass on tools with rules that the schema hides | The agent gets the formats, the call order, and the hidden fields of your tools before its first call. |
| Fewer tokens and less time | The agent stops its trial and error at the start of each session. |
| No work for you | With the tuner on, the rules come from your normal sessions. |
| Rules stay correct | When a tool changes and a rule fails, Fabric removes or corrects the rule. |
| Any Pi model, and no training | The main model and the rule writer are `provider/model` keys from `pi --list-models`. |
| You own the result | The rules are plain text in one file of 8,000 characters at most. `pi-fabric tune undo` removes the last edit. |

### What to expect

- **The first sessions on a new tool do not change.** The agent must find the correct call one time. In the bench, the first rules came after session 1 or 2.
- **A new rule applies from the next session.** Start one with `/new`. The session that caused the rule does not get it. [Design decisions](#design-decisions) gives the reason.
- **Later sessions fail less and cost less.** In the bench, the failed tool calls fell from 14 of 42 in sessions 1 to 8 to 9 of 37 in sessions 9 to 16. The mean tokens fell from 71,426 to 28,676.
- **After a tool changes, the repair is slow.** Each rule must fail, the main model must find the new form, and Fabric must write the rule again. In the bench, 8 of the 16 sessions after the change failed. After those sessions, 88% of the held-out tasks passed. With the old rules, 0% passed.

Do not expect these things:

- **A gain on tasks that the model does well.** On general coding tasks, all runs passed with the rules on and with the rules off. The rules added approximately 2,000 tokens to each run.
- **A measured value for a rule from a session.** Fabric does not do a real task again, so a rule from a session has no score. Read the notices.
- **Rules for failures that give no error.** The learning from sessions finds only calls that fail. A call that returns old data or one page of a list gives it nothing. A task suite finds those rules.
- **A low cost for a tuner run.** One run of `pi-fabric tune run` on the bench used 4 to 14 million tokens with cached input included.
- **A proof for real coding work.** The benchmark is synthetic, so use its numbers as an upper limit. No measurement of the gain on real projects exists yet.

## Contents

- [Words in this document](#words-in-this-document)
- [Turn it on](#turn-it-on)
- [How it works](#how-it-works)
- [Design decisions](#design-decisions)
- [Two sources of rules](#two-sources-of-rules)
- [Task suite](#task-suite), [commands](#commands), [one round](#one-round), and [outputs](#outputs)
- [Isolation and limits](#isolation-and-limits)
- [Method](#method)
- [Benchmark](#benchmark)

## Words in this document

| Word | Meaning |
| --- | --- |
| Main model | The model of your session. It does the tasks and calls the tools. |
| Rule writer | A second model call that writes a rule from a short report of failures. It has no tools and does no task. The paper names it the proposer. |
| Rule | One `- ` bullet in `learned.md`, for example the format that one tool accepts. |
| `learned.md` | The file of rules, `<agent-dir>/fabric/tuner/learned.md`. Fabric adds it to the system prompt. |
| Session | One conversation with Pi, from its start to `/new` or to the end of the process. |
| Tuner run | One run of `pi-fabric tune run` on a task suite. It tries rule edits and keeps the edits that make the score better. |
| Held-out task | A task that the tuner did not use. It shows if the rules help on new work. |
| Seed | A number that selects one set of rules for the bench server. A different seed is a different tool. |
| Complete rules | The full rule set of the bench server, which a script writes. It is the best result that rules can give. |

## Turn it on

```text
/fabric tuner on
```

The command opens the same model picker as `/fabric settings`. The default is `Inherit`: the rule writer then uses the model and the thinking level of your session. Select a different model if you want a cheaper or a stronger rule writer. A closed dialog keeps the current value. In `fabric.json`, the same switch is:

```json
{ "tuner": { "enabled": true } }
```

`tuner.enabled` (default `false`) is the one switch. Three options change its behavior. You do not have to set them.

| Option | Default | Effect |
| --- | --- | --- |
| `tuner.capture` | `true` | `false` stops the learning from sessions. Fabric then only reads `learned.md`. |
| `tuner.autoAccept` | `true` | `false` keeps each new rule as a suggestion. You decide with `pi-fabric tune review`, `accept`, and `reject`. |
| `tuner.writerModel` | `""` | The Pi `provider/model` that writes the rule edits. An empty value is `Inherit`: the model and the thinking level of your session. `pi-fabric tune` from a shell has no session, so it uses the default model of Pi. |

The **Tuner** section of `/fabric settings` has the switch and the options. `/fabric tuner` changes the same values from the prompt, with completion for each key and value:

```text
/fabric tuner                          # show the values, the number of learned rules, and a suggestion that waits
/fabric tuner on|off                   # on also opens the model picker
/fabric tuner capture on|off
/fabric tuner autoAccept on|off
/fabric tuner writerModel              # open the model picker
/fabric tuner writerModel <provider/model>|inherit
```

The command saves to the project `fabric.json` in a trusted project, and to the global file in other sessions.

### What you see

Fabric shows a notice at each step, so that you know that the tuner works:

| Moment | Notice |
| --- | --- |
| You turn the tuner on | `Fabric tuner is on. Rule writer: ...` with the model, what Fabric learns from, and that a new rule applies from the next session |
| The first message of each session | `Fabric tuner: 4 learned rules in the prompt of this session.` |
| A problem repeated, and a rule update starts | `Fabric tuner: a rule update for <tool> started. A notice shows the result.` |
| The rule update changed the file | `The Fabric tuner changed learned.md. A new session (/new) uses the change.` with the rules that it added and removed |
| The rule writer found nothing to write | `The Fabric tuner wrote no rule for <tool>` with the reason |
| The rule writer gave no reply | `The Fabric tuner got no reply from the rule writer <model>.` Select a different model in that case. |
| A suggestion waits, with `tuner.autoAccept` off | `The Fabric tuner has a rule suggestion. Run "pi-fabric tune review".` |

A result notice shows at the next tool result or at your next message. `/fabric tuner` shows the values and the number of learned rules at any time.

## How it works

Two models have a part in the flow. The main model is the model of your session, and it does the work. The rule writer is a second model call that only writes rules.

```text
 SESSION 1                                    SESSION 2 (/new, or a new Pi process)

 main model calls a tool      -> error        Fabric reads learned.md one time
 main model changes the call  -> error        and adds it to the system prompt
 main model changes the call  -> error                      |
 main model changes the call  -> success                    v
              |                               main model reads the rule
              v                               first call to the tool -> success
 capture: 2 failures and 1 success
              |
              v
 rule writer: a separate process with a short report
              |
              v
 learned.md gets one rule, and session 1 shows a notice
```

1. **Capture.** Fabric records each failed top-level tool result in `<agent-dir>/fabric/tuner/failures.jsonl`. The target of a failure is the first `mcp.<server>.<tool>` or `pi.<tool>` in the call that did not succeed. A call with no such name has the tool name as its target.
2. **The call that succeeded.** After a failure, Fabric records the first call to the same target that succeeds. For a call inside `fabric_exec` code, Fabric records the exact arguments that the tool accepted.
3. **Corrections.** Fabric also records a message in which you correct the agent, with the last tool call of the agent as context. A message is a correction when it starts with a word such as "no", "do not", "stop", "wrong", "never", or "I told you". The target of these steps is `user`.
4. **Trigger.** Fabric starts the rule writer in one of three conditions:

   | Condition | Number |
   | --- | --- |
   | One target fails, and then a call to it succeeds | 2 failures |
   | One target only fails | 4 failures |
   | You correct the agent | 2 corrections |

   The count includes all sessions, and the 2 failures can be in one session. A session with no failure and no correction starts no rule writer call.
5. **Rule.** The rule writer is a separate process with no session history. It gets its instructions, the current `learned.md`, and a report of 16,000 characters at most. For each target, the report has a maximum of 5 different failures and the newest call when that call succeeded. The rule writer writes one edit, or it answers that no rule is necessary.
6. **Accept.** Fabric writes the edit to `learned.md` and shows one notice with the edit at the next tool result or at your next message. `accepted.jsonl` records each accepted edit with its diagnosis.
7. **Next session.** A new session (`/new`, or a new Pi process) reads `learned.md` and has the rule in its system prompt. The session that caused the rule does not get it.
8. **Repair.** A target can fail again after Fabric wrote a rule for it, because the tool changed or because the rule is wrong. The same numbers then start a repair:

   | Condition | What Fabric does |
   | --- | --- |
   | The newest call to the target succeeded | The rule writer corrects the rule from the exact arguments of that call. |
   | No call succeeded after the failures | Fabric removes the rules of the tool (the rules that start with its name). In their place, it writes a note with facts: the calls that the tool rejected. The error text of the tool does not go in. No model has a part in this step. When a call succeeds later, step 5 changes the note into a rule. |

```sh
pi-fabric tune undo     # remove the last accepted edit from learned.md
pi-fabric tune suggest --min 1   # start the rule writer by hand for each target with a failure
```

With `tuner.autoAccept` set to `false`, step 6 changes. Fabric saves the edit in `suggestion.json` and shows a notice. Use these commands:

```sh
pi-fabric tune review   # the diagnosis, the rules that the edit adds and removes, and the evidence
pi-fabric tune accept   # write the edit to learned.md
pi-fabric tune reject   # discard the edit
```

## Design decisions

| Decision | Reason |
| --- | --- |
| A new rule applies from the next session, and the current session keeps its prompt. | The provider caches the system prompt. A change in the middle of a session loses the cache, and the next request then pays the full price for the full conversation. The current session also has no need for the rule: the failure and the correct call are in its context. |
| The main model finds the correct call. The rule writer only writes it down. | The rule writer has no tools, so it cannot try a call. A call that the tool accepted is the only proof of a format. |
| Only a tool call that the tool accepted is a success. | Code that catches its errors returns no error. In the bench, such code counted as a success, and the rule writer copied a wrong format from it 6 times. |
| Only the newest call is proof. | A success from before a tool change says nothing about the tool now. In the bench, an old success with new errors gave a rule that mixed the two formats. |
| A rule that only fails goes out, and a note with facts takes its place. Code writes the note, and no model does. | With no call that succeeded, a model can only guess, and the agent obeys a wrong guess before it reads the error. The facts are safe and useful: the next session does not try the rejected calls again. The error text stays out, because the prompt tells the agent to obey learned.md, and a tool must not write instructions there. The agent gets the error text from its own call. |
| The trigger is 2 failures, and 1 failure is not sufficient. | One failure is frequently a slip of the model and not a property of the tool. Normal work has many single failures, and a rule for each one fills the file with rules for one task. No measurement compares 2 with 3. |
| The rule writer is a separate process with a short report. | The session does not wait for it, and the session cache stays the same. A rule writer call used 1,000 to 6,000 tokens in the bench. |
| The report has the exact arguments of the call that succeeded. | Agents frequently try many formats in one piece of code. From the code alone, the rule writer cannot see which format the tool accepted. |
| The rules are one plain file with a maximum of 8,000 characters. | The prompt cost has a limit, you can read and edit each rule, and `pi-fabric tune undo` removes the last edit. |
| One switch turns on the rules, the capture, and the automatic accept. | The three parts have no use alone. The two options are for a user who wants to be the judge of each rule. |
| The rule writer inherits the model and the thinking level of your session. | One model is then sufficient, with no setup. The bench found no gain from a higher level for the rule writer, so a cheaper model is a safe selection. |
| Each step shows a notice. | The rule writer is a separate process, and a new rule applies only from the next session. With no notice, you cannot see that the tuner works. |
| The model of the agent stays the same. | Fabric trains no model. In an earlier bench run, the rules also helped a second model that did not learn them. |

The learning from sessions has these limits:

- **A new rule has no score.** Fabric does not do a real task again, so nothing measures the rule. Set `tuner.autoAccept` to `false` when you want to be the judge of each rule.
- **One suggestion at a time.** Fabric starts no rule writer call while a suggestion waits.
- **Bounded cost.** A rule writer call uses the captured steps of its targets and then deletes them. A call that gives no rule also doubles the number of failures that those targets need for the next call. `suggest.log` records each rule writer call and its outcome.
- **Untrusted text.** A tool result can contain instructions. The rule writer prompt identifies the report as data. The note for a rule that only fails quotes a maximum of 200 characters of each error. Read each notice, and use `pi-fabric tune undo` for a rule that is wrong.
- **Detection is a heuristic.** A result is a failure when Pi marks it as an error, when it starts with an error word, or when it contains `Error: `. The word list for corrections is English.
- **Bounded file.** At 1 MB, Fabric drops the older half of `failures.jsonl`.
- **Only failures.** A call that returns wrong data with no error gives the capture no step. Use `pi-fabric tune run` with a task suite for such rules.

## Two sources of rules

| Source | What you do | How Fabric knows that a rule is good |
| --- | --- | --- |
| Your sessions | Nothing. Fabric records repeated tool failures and your corrections. | A rule comes only from a call that the tool accepted. It has no score. |
| A task suite | You write tasks with a check script, and you run `pi-fabric tune run`. | Scoring tasks select each edit, and held-out tasks give the final comparison. |

The sections that follow are for the task suite.

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
| `SUITE.md` | A description of the suite for the rule writer |
| `mcporter.json` | MCP servers for the tasks. Fabric replaces `{{CELL}}` with the identifier of the run. |
| `fabric.json` | Fabric configuration for each run, for example `approvals.actions` rules that deny the shell |

`check.sh` and `setup.sh` get `TUNER_CELL` (the identifier of the run) and `TUNER_CELL_DIR`.

## Commands

```sh
pi-fabric tune eval  --tasks <dir> --set feedback            # one harness, one report
pi-fabric tune run   --tasks <dir> --rounds 8 --candidates 4 # the loop
pi-fabric tune apply --dir <out>                             # copy the last kept version to the agent directory
```

`pi-fabric tune suggest`, `review`, `accept`, `reject`, and `undo` are for [the learning from sessions](#how-it-works).

`--model` selects the main model and `--writer` selects the rule writer. Both take a `provider/model` key from `pi --list-models`. A key can end with a thinking level, for example `provider/model:high`. With no level, a model uses the `defaultThinkingLevel` of your Pi settings, so a tuner run thinks as much as your sessions do. `tuner.writerModel` accepts the same form. `--budget <tokens>` and `--budget-usd <usd>` stop the loop cleanly. `--timeout` and `--max-tokens` limit one task run. `--reps` runs each task more than one time.

## One round

1. The rule writer gets the suite description, the current `learned.md`, the report on the feedback set, and the list of earlier edits. For a failed run, the report shows the failed tool steps and an excerpt of the transcript. Each rule writer call returns a diagnosis and SEARCH/REPLACE blocks.
2. Fabric discards an edit that does not apply, that changes nothing, or that makes the file larger than 200 lines or 8,000 characters. Before it discards the edit, Fabric asks the rule writer one more time and gives the reason.
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
| `tuples.jsonl` | Each (report, harness, edit, reward) tuple, for later rule writer training |
| `summary.md` | The kept edits and the held-out comparison |
| `cells/` | The trimmed transcript and the result of each run |

## Isolation and limits

- Each run gets a new work directory and a new agent directory. The agent directory holds the credentials of the selected model provider, the Fabric configuration, and the candidate `learned.md`. Fabric deletes it after the run.
- `pi-fabric tune run` and `pi-fabric tune eval` do not write to the real agent directory. Only `pi-fabric tune apply`, `pi-fabric tune accept`, and `pi-fabric tune undo` write `learned.md` there. With the tuner on, sessions and `pi-fabric tune suggest` write `failures.jsonl`, `accepted.jsonl`, and `learned.md` there. With `tuner.autoAccept` set to `false`, `pi-fabric tune suggest` writes `suggestion.json` and does not write `learned.md`.
- A run is a process in a directory. It is not a container. Run only tasks that you wrote. Use `fabric.json` in the tasks directory to deny the shell when the tasks do not need it.
- The token total includes cached input tokens.
- The scores of a small scoring set are noisy. Use `--reps`, partial scores, or more tasks before you trust a small difference.

## Method

The method comes from the paper [Harness Learning Enables Generalizable Test-Time Adaptation](https://arxiv.org/abs/2609.35738). The paper changes the harness of a model at test time and keeps the model fixed. Its loop has four steps: run tasks, write a report of the runs, let a model edit the harness, and keep an edit only when the score is better. The paper names that model the proposer, and this document names it the rule writer.

Fabric uses that loop with these decisions:

| Subject | Decision in Fabric |
| --- | --- |
| The harness | One Markdown file of rules, `learned.md`. Fabric does not edit skills, tools, or its own prompt. |
| The rule writer | A standard model from the Pi model list. Fabric trains no rule writer. |
| The report | For each failed run: the failed tool steps and an excerpt of the transcript, at most 24,000 characters in total. |
| The edit | SEARCH/REPLACE blocks on `learned.md`. Fabric asks one more time when an edit does not apply. |
| The selection | A candidate replaces its parent on a higher score on the scoring set, or on the same score with at least 10% fewer tokens. |
| Old rules | One candidate in each round is the file without its oldest rule, so a rule with no value leaves the file. |
| Three task sets | The rule writer gets reports from the feedback set only. The scoring set selects. The held-out set gives the final comparison. |
| Scope of a rule | The rule writer must start each rule with the tool or the kind of task that it applies to. |
| Data for later | `tuples.jsonl` keeps each (report, harness, edit, reward) tuple, so a rule writer can get training later. |

The learning from sessions is an addition of Fabric. It uses the same rule writer and the same edit format, but it has no scoring step, because Fabric does not do a real task again. A real task can have effects that must not occur two times.

## Benchmark

`bench/tuner` has a bench server, a task suite, and a driver. [bench/tuner/README.md](../bench/tuner/README.md) gives the commands, and [bench/tuner/RESULTS.md](../bench/tuner/RESULTS.md) gives the full report.

### Design

- **Server.** The quirk depot is an MCP server with 5 tools and a catalog of 42 parts. Its rules are not in the tool schema, and they come from a seed. A model cannot know them before a run. For example, with seed 1 the search text `oak panel` must be `[[OAK+PANEL]]`, and with seed 5 it must be `q:OAK+PANEL;`.
- **Four classes of rule.** Field formats (an error names the first violated rule only), paging, old data with no error, and a reserve and confirm protocol with a pin.
- **Quota.** Each run can make 5 depot calls, so an agent with no rules uses its calls on errors.
- **Tasks.** 24 tasks: 8 kinds of question in each of 3 disjoint sets (feedback, scoring, held-out). Each task has a check script with an exact answer.
- **Isolation.** Each run gets a new work directory and a new agent directory. The suite denies the shell and file reads, so an agent cannot read the server source.
- **Models.** The main model and the rule writer are `deepseek-v4.1-flash` at the `max` thinking level.
- **Tuner runs.** 3 seeds (3 different sets of rules), a maximum of 8 rounds, and a maximum of 4 candidates in each round.
- **Arms on the held-out set.** No rules, the learned rules, and the complete rules that a script writes from the server profile.
- **Controls.** The learned rules with the switch off, 10 unrelated rules, the learned rules in a file of 7,900 characters, and general coding tasks with no depot.
- **Trigger.** The sessions of the bench used a trigger of 3 failures. The default is now 2.
- **Sessions.** 16 Pi sessions in sequence in one agent directory with only `tuner.enabled` on, and a quota of 12 calls. The depot then changes to the rules of seed 5, and 16 more sessions run.
- **Measures.** The pass rate with a 95% interval, the mean tokens for each run with cached input included, and the mean time.

The full bench does approximately 600 task runs and uses 45 million tokens.

### Results on held-out tasks

| Harness | Runs | Pass rate (95% interval) | Mean tokens for each run | Mean time |
| --- | ---: | --- | ---: | ---: |
| No rules | 24 | 17% (7% to 36%) | 78,394 | 24 s |
| Learned rules of a tuner run | 72 | 97% (90% to 99%) | 32,065 | 14 s |
| Complete rules | 48 | 90% (78% to 95%) | 20,416 | 12 s |

| Seed | No rules | Learned rules | Complete rules | Tokens for the tuner run |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2 of 8 | 23 of 24 | 16 of 16 | 4.3 million |
| 2 | 2 of 8 | 23 of 24 | 13 of 16 | 7.2 million |
| 7 | 0 of 8 | 24 of 24 | 14 of 16 | 13.5 million |

The learned rules pass more runs than the complete rules. The difference is inside the noise of the bench. The complete rules have only the formats. The learned rules also have advice, for example that an error uses one call of the quota.

### Controls

| Control or condition | Runs | Pass rate | What it shows |
| --- | ---: | --- | --- |
| Learned rules with `tuner.enabled` set to `false` | 16 | 19% | The gain comes from the rules in the prompt. |
| Placebo: 10 unrelated rules | 16 | 13% | More prompt text gives no gain. |
| Learned rules in a file of 7,900 characters | 16 | 100% | The rules work at the size limit. |
| General coding tasks with no depot: rules on and rules off | 18 each | 100% and 100% | The rules do no damage to unrelated tasks. They add 2,255 tokens to each run. |
| Second main model: no rules, then the same learned rules | 16 each | 19%, then 100% | The rules help a model that did not learn them. This row is from an earlier run, in which `glm-5.3-flash` learned the rules and `deepseek-v4.1-flash` used them. |

### Rules from sessions

16 Pi sessions ran in sequence on the depot of seed 1, with only the switch on. Fabric wrote 3 rules from 3 rule writer calls, with no review. The calls used 5,046 tokens in total.

| Sessions | Passed | Failed depot calls | Mean tokens for each session |
| --- | ---: | ---: | ---: |
| 1 to 8 | 7 of 8 | 14 of 42 | 71,426 |
| 9 to 16 | 7 of 8 | 9 of 37 | 28,676 |

The held-out tasks of the same seed, with the quota of 5 calls:

| Harness | Runs | Pass rate (95% interval) | Mean tokens for each run |
| --- | ---: | --- | ---: |
| No rules | 8 | 25% (7% to 59%) | 83,812 |
| Rules from the 16 sessions | 16 | 81% (57% to 93%) | 30,487 |
| Rules from a tuner run | 24 | 96% (80% to 99%) | 20,442 |
| Complete rules | 16 | 100% (81% to 100%) | 19,923 |

### After a tool change

Before session 17, the depot changed to the rules of seed 5. All the rules in `learned.md` became wrong. The same agent directory then ran 16 more sessions.

| Sessions | Passed | Failed depot calls | Mean tokens for each session | Edits of `learned.md` |
| --- | ---: | ---: | ---: | ---: |
| 17 to 24 | 5 of 8 | 72 of 132 | 189,717 | 4 |
| 25 to 32 | 3 of 8 | 37 of 95 | 138,689 | 5 |

Session 17, the first one after the change, passed: the main model found the new search form with 18 failed calls. Fabric then wrote the rules again, one tool at a time. In 7 bench runs, 3 to 9 of the 16 sessions after the change failed.

The held-out tasks on the changed depot:

| Harness | Runs | Pass rate (95% interval) | Mean tokens for each run |
| --- | ---: | --- | ---: |
| No rules | 8 | 0% (0% to 32%) | 74,172 |
| Rules from before the change | 16 | 0% (0% to 19%) | 34,096 |
| Rules after the 16 sessions on the changed depot | 16 | 88% (64% to 97%) | 33,990 |
| Rules of a tuner run that starts from the old rules | 16 | 0% (0% to 19%) | 45,189 |
| Rules of a tuner run that starts from an empty file | 24 | 96% (80% to 99%) | 43,572 |

A tuner run that started from the old rules kept no edit: with wrong rules in the prompt, each candidate had a score near 0. So after a tool change, do a tuner run from an empty file, which is the default of `pi-fabric tune run`. That run used 7.1 million tokens.

### Settings that the bench compared

Each row is one bench run with `deepseek-v4.1-flash`. The pass rates are for held-out tasks.

| Run | Change from the row above | Thinking level: main model, rule writer | Rules of a tuner run | Tokens for 3 tuner runs | Rules from 16 sessions | After the tool change: repaired rules | Sessions that failed after the change, of 16 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 4 rounds, 4 candidates | `medium`, `medium` | 83% | 28.7 million | 69% | not measured | not measured |
| 2 | Fewer candidates at a high score | `medium`, `medium` | 85% | 25.5 million | 69% | 63% | 7 |
| 3 | A maximum of 8 rounds, a stop at a score of 1.00, removal of a rule that only fails | `medium`, `medium` | 92% | 20.9 million | 81% | 75% | 3 |
| 4 | Same logic | `medium`, `max` | 93% | 32.5 million | 75% | 63% | 3 |
| 5 | Same logic | `max`, `max` | 97% | 20.7 million | 75% | 88% | 7 |
| 6 | Exact arguments of the call that succeeded | `max`, `max` | 97% | 25.0 million | 88% | 75% | 9 |
| 7 | Only an accepted tool call is a success | `max`, `max` | same runs as row 6 | same runs as row 6 | 81% | 88% | 7 |
| 8 | Only the newest call is proof, removal with no model call | `max`, `max` | same runs as row 6 | same runs as row 6 | 81% | 88% | 8 |

What the comparison shows:

- **The `max` thinking level of the main model gave the best result.** The pass rate was the highest and the token use was the lowest, because a failed call costs more tokens than the thinking does.
- **The thinking level of the rule writer made no difference that the bench can measure.** A rule writer call is small at each level.
- **The stop rules save tokens.** A tuner run stops at a score of 1.00, and it uses fewer candidates near that score.
- **The changes of rows 6 to 8 did not make the repair faster.** They remove wrong proof from the report of the rule writer. The number of failed sessions stayed between 7 and 9, and the repaired rules stayed between 75% and 88%.
- **The repair was faster at the `medium` level: 3 failed sessions.** A probable cause: at `max`, the main model tries many forms in one piece of code and catches the errors, so the capture sees fewer failures.
- **A difference of less than 10 points is noise.** Each row is one run. Rows 2 to 4 have almost the same tuner logic, and they gave 85%, 92%, and 93%.

### What the bench corrected

The bench found these defects in the tuner, and the code now has a correction for each one:

- The report hid the successful tool results of a failed run, so no seed learned the rule for old data. The report now adds a transcript excerpt.
- The rules had no scope. The rule writer must now start each rule with the tool or the kind of task.
- A tuner run kept an edit at a score of 0, because the edit used fewer tokens. At a score of 0, only a higher score wins now.
- Code that catches its errors counted as a success. Only a tool call that the tool accepted is a success now.
- A success from before a tool change counted as proof for the failures after it. Only the newest call is proof now.
- With only error text, the rule writer mixed the old format with the words of the error. Fabric now removes a rule that only fails and writes the rejected calls in its place, with no model call. This last step has a test and no bench run.

### Limits of the bench

- The bench is synthetic. The depot rules are unknown to the model, so the gain is near the best case.
- The bench does not measure real coding work.
- Each setting has one run, and the session test has one seed with 16 sessions before the change and 16 after it.
- A rule can describe a limit of the task suite as a fact. The suite denies the shell, and the learned rules of seed 1 say so. On the general coding tasks, the shell use fell from 10 of 18 runs to 1 of 18 with those rules. All the runs passed.
- A call that the tool accepts with an empty result counts as a success. The changed depot accepts the mixed form `q:[[OAK]];` and returns no match, and one rule got that form.
- The sessions of the bench can use the shell. After the tool change, some sessions used it to look for a way around the depot, which cost tokens and time.
- The partial score of a failed task counts successful depot calls, also calls with data that the task cannot use.
