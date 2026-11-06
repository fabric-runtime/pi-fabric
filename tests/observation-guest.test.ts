import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { AttachedMonitors } from "../src/core/attached-monitors.js";
import { TasksProvider } from "../src/providers/tasks-provider.js";
import { FabricExecutionService } from "../src/execution-service.js";

describe.each(["typescript","python"] as const)("%s attached monitor integration", kernel => {
  it("discovers, attaches and stops an observer through the real guest bridge", async () => {
    const jobs=new FabricShellJobStore(); const registry=new ActionRegistry();
    const monitors=new AttachedMonitors(jobs);registry.register(new TasksProvider(jobs, () => monitors));
    const source=jobs.begin("bash","existing work");source.spill();
    const config=normalizeFabricConfig({fullCodeMode:true,approvals:{read:"allow",execute:"allow"},executor:{kernel,pythonRuntime:"monty"}});
    const service=new FabricExecutionService(registry,config);
    const context={cwd:process.cwd(),sessionManager:{getSessionId:()=>"guest",getSessionFile:()=>undefined}} as unknown as ExtensionContext;
    await expect(registry.describe("monitors.start", { extensionContext: context } as never)).rejects.toThrow();
    const code=kernel==="typescript" ? `
const started = await tools.call({ref:"tasks.observe",args:{id:"${source.id}",delivery:"ui"}});
const listed = await tools.call({ref:"tasks.list",args:{}});
const stopped = await tools.call({ref:"tasks.stop",args:{id:started.task.id}});
return {count:listed.length,stopped:stopped.stopped};` : `
started = await tools.call(ref="tasks.observe", args={"id":"${source.id}","delivery":"ui"})
listed = await tools.call(ref="tasks.list", args={})
stopped = await tools.call(ref="tasks.stop", args={"id":started["task"]["id"]})
return {"count":len(listed),"stopped":stopped["stopped"]}`;
    try {
      const result=await service.execute({code,context,signal:undefined,parentToolCallId:"monitor-probe",onPartial(){}});
      expect(result.success,JSON.stringify(result)).toBe(true);
      expect(result.value).toEqual({count:2,stopped:true});
      expect(source.abort.signal.aborted).toBe(false);
    } finally {monitors.close();await registry.close();await jobs.close();}
  });
});
