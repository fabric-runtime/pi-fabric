import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricInvocationContext } from "../src/protocol.js";
import { AttachedMonitors, localMonitorParticipants, type MonitorParticipantSnapshot, type MonitorParticipants } from "../src/core/attached-monitors.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { ShellEventInbox } from "../src/core/shell-inbox.js";
import { TasksProvider } from "../src/providers/tasks-provider.js";
import { observeExisting } from "../src/core/observation-actions.js";
import { ProviderParticipantRegistry } from "../src/topology/provider-participants.js";
import type { AgentManager } from "../src/agents/manager.js";

const cleanup: Array<() => Promise<void>> = [];
const context = { extensionContext: { sessionManager: { getSessionId: () => "owner" } } } as FabricInvocationContext;
function harness(participants?: MonitorParticipants) {
  const jobs = new FabricShellJobStore();
  const monitors = new AttachedMonitors(jobs, participants);
  const provider = new TasksProvider(jobs, () => monitors);
  cleanup.push(async () => { monitors.close(); await jobs.close(); });
  return { jobs, monitors, provider, start: (target: {kind: "task" | "participant"; id: string}, options = {}) =>
    (target.kind === "task" ? provider.invoke("observe", { id: target.id, delivery: "ui", intervalMs: 1000, timeoutMs: 10000, ...options }, context) : observeExisting(monitors, "participant", { id: target.id, delivery: "ui", intervalMs: 1000, timeoutMs: 10000, ...options }, context)) as Promise<{task: {id:string}}> };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

describe("attached monitors", () => {
  it("attaches without restarting, filters future output, and always replays failure including partial lines", async () => {
    const h = harness(); const source = h.jobs.begin("bash", "build"); source.spill();
    source.append(Buffer.from("BUILD: before attachment\n"));
    const {task} = await h.start({kind:"task", id:source.id}, {match:"BUILD:"});
    const observer = h.jobs.get(task.id)!;
    source.append(Buffer.from("ignored\nBUILD: running\nBUILD: final"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(observer.replay(0).lines).toEqual(["BUILD: running"]);
    await source.finish(9);
    const page = observer.replay(0);
    expect(page.lines).toHaveLength(3);
    expect(page.lines[1]).toBe("BUILD: final");
    expect(JSON.parse(page.lines[2]!)).toMatchObject({event:"terminal", data:{status:"failed",exitCode:9}});
    expect(source.abort.signal.aborted).toBe(false);
    expect(h.jobs.list()).toHaveLength(2);
  });

  it("stopping or expiring the observer never aborts the target and detaches output listeners", async () => {
    const h = harness(); const source = h.jobs.begin("bash", "build"); source.spill();
    const a = await h.start({kind:"task",id:source.id});
    await h.provider.invoke("stop", {id:a.task.id}, context);
    const stopped = h.jobs.get(a.task.id)!; const cursor = stopped.eventCount;
    source.append(Buffer.from("after stop\n"));
    expect(stopped.eventCount).toBe(cursor);
    const b = await h.start({kind:"task",id:source.id}, {timeoutMs:1000});
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.jobs.get(b.task.id)!.status).toBe("timed_out");
    expect(source.abort.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tracks only operational changes, emits quiet once per period and refuses replacement generations", async () => {
    let snapshot: MonitorParticipantSnapshot = { id:"agent",generation:"run1",name:"worker",status:"running",terminal:false,progress:{turns:0} };
    const listeners = new Set<() => void>();
    const h = harness({get:()=>snapshot,subscribe:listener=>{listeners.add(listener); return ()=>{listeners.delete(listener);};}});
    const {task} = await h.start({kind:"participant",id:"agent"},{events:["quiet","progress","blocked"],quietAfterMs:2000});
    const observer = h.jobs.get(task.id)!;
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(4000);
    expect(observer.replay(0).lines.map(line=>JSON.parse(line).event)).toEqual(["quiet"]);
    snapshot = {...snapshot,progress:{turns:1,blocked:true}};
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(1000);
    expect(observer.replay(0).lines.map(line=>JSON.parse(line).event)).toEqual(["quiet","progress","blocked"]);
    snapshot = {...snapshot,generation:"run2"};
    for (const listener of [...listeners]) listener();
    expect(JSON.parse(observer.replay(0).lines.at(-1)!)).toMatchObject({event:"unavailable"});
    expect(listeners.size).toBe(0);
  });

  it("detects provider re-registration even within the same millisecond and excludes agent text", async () => {
    const registry = new ProviderParticipantRegistry();
    const agent = {id:"a",name:"A",status:"running",turns:1,toolCalls:2,text:"secret transcript",currentTool:"read"};
    const manager = {status:()=>agent,subscribeUi:()=>()=>{}} as unknown as AgentManager;
    const source = localMonitorParticipants(manager, registry);
    expect(JSON.stringify(source.get("a"))).not.toContain("secret transcript");
    const registration = registry.view("p","call");
    const first = registration.register({id:"x",label:"X",stop:async()=>({confirmed:true})});
    const h = harness(source); const {task} = await h.start({kind:"participant",id:first.ref});
    first.dispose(); registration.register({id:"x",label:"X",stop:async()=>({confirmed:true})});
    expect(h.jobs.get(task.id)!.finished).toBe(true);
    expect(h.jobs.get(task.id)!.replay(0).lines.join()).toContain("unavailable");
  });

  it("validates discovery, capabilities, target types and observation-only controls", async () => {
    const h = harness(); const source = h.jobs.begin("bash","build"); source.spill();
    expect((await h.provider.list({})).map(d=>d.name)).toContain("observe");
    expect(await h.provider.describe("start")).toBeUndefined();
    await expect(h.start({kind:"task",id:"missing"})).rejects.toThrow("Unknown local");
    await expect(h.start({kind:"task",id:source.id},{delivery:undefined})).rejects.toThrow();
    await expect(h.start({kind:"task",id:source.id},{events:["quiet"]})).rejects.toThrow("quietAfterMs");
    const {task} = await h.start({kind:"task",id:source.id});
    await expect(h.start({kind:"task",id:task.id})).rejects.toThrow("another attached monitor");
    const abort = new AbortController();
    const waiting = h.provider.invoke("watch",{id:task.id,after:0,timeoutMs:10000},{...context,signal:abort.signal});
    abort.abort(new Error("cancel wait"));
    await expect(waiting).rejects.toThrow("cancel wait");
    expect(h.jobs.get(task.id)!.abort.signal.aborted).toBe(false);
    expect(source.abort.signal.aborted).toBe(false);
    expect(await h.provider.invoke("list",{},context)).toHaveLength(2);
  });

  it("shares the eight-monitor cap and closes every subscription on provider unload", async () => {
    const h = harness(); const source = h.jobs.begin("bash","build"); source.spill();
    for(let i=0;i<8;i++) await h.start({kind:"task",id:source.id});
    await expect(h.start({kind:"task",id:source.id})).rejects.toThrow("At most 8");
    h.monitors.close();
    expect(source.abort.signal.aborted).toBe(false);
    expect(h.jobs.live().filter(job=>job.options.observes).every(job=>job.abort.signal.aborted)).toBe(true);
    await expect(h.start({kind:"task",id:source.id})).rejects.toThrow("closed");
  });

  it("replaces a source completion wakeup, while UI-only observers leave normal delivery alone", async () => {
    const h = harness(); const handlers = new Map<string,(event:any,ctx:any)=>void>();
    const sendMessage = vi.fn();
    const ctx = {hasUI:false,isIdle:()=>true,hasPendingMessages:()=>false} as ExtensionContext;
    const inbox = new ShellEventInbox({sendMessage,on:(name:string,fn:any)=>{handlers.set(name,fn);return ()=>handlers.delete(name);}} as unknown as ExtensionAPI,ctx,h.jobs);
    cleanup.push(async()=>inbox.close());
    const source=h.jobs.begin("bash","build");source.spill();
    const {task}=await h.start({kind:"task",id:source.id},{delivery:"wake"});
    await expect(h.start({kind:"task",id:source.id},{delivery:"wake"})).rejects.toThrow("wake monitor already");
    // Terminal metadata precedes the published completion (which follows async log cleanup).
    const published = new Promise<void>(resolve => {
      const off = h.jobs.subscribe(event => {
        if (event.type === "finished" && event.job.id === task.id) { off(); resolve(); }
      });
    });
    await source.finish(1);
    await published;
    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0].details.ids).toEqual([task.id]);
    expect(sendMessage.mock.calls[0]![0].content).toContain('"status":"failed"');
    sendMessage.mockClear();
    const other=h.jobs.begin("bash","other");other.spill();
    await h.start({kind:"task",id:other.id});
    await other.finish(0);await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0].details.ids).toEqual([other.id]);
    sendMessage.mockClear();
    const raced = h.jobs.begin("bash", "finish during observer stop"); raced.spill();
    const watch = await h.start({kind:"task",id:raced.id},{delivery:"wake"});
    h.jobs.stop(watch.task.id);
    await raced.finish(0); await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage.mock.calls.flatMap(call => call[0].details.ids)).toContain(raced.id);
    const branched = h.jobs.begin("bash", "survive branch change"); branched.spill();
    const branchWatch = await h.start({kind:"task",id:branched.id},{delivery:"wake"});
    handlers.get("session_tree")!({}, ctx);
    expect(h.jobs.get(branchWatch.task.id)!.abort.signal.aborted).toBe(true);
    expect(branched.abort.signal.aborted).toBe(false);
  });
});
