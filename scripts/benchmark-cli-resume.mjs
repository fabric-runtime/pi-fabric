// Profile the actual bundled CLI in a Linux pseudo-terminal, with synthetic histories.
// All instrumentation and settings live in a disposable private directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const index = args.indexOf("--extensions-file");
assert(index >= 0, "Pass --extensions-file with the isolated extension paths");
const eagerActors = args.includes("--eager-actors");
const configured = JSON.parse(fs.readFileSync(args[index + 1], "utf8"));
function entries(entry) {
  if (fs.statSync(entry).isFile()) return [entry];
  const manifest = path.join(entry, "package.json");
  if (fs.existsSync(manifest)) {
    const paths = JSON.parse(fs.readFileSync(manifest, "utf8")).pi?.extensions;
    if (paths?.length) return paths.flatMap(file => entries(path.resolve(entry, file)));
  }
  for (const name of ["index.ts", "index.js"]) if (fs.existsSync(path.join(entry, name))) return [path.join(entry, name)];
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap(item => item.isDirectory() ? entries(path.join(entry,item.name)) : /\.(ts|js|mjs)$/.test(item.name) && !item.name.endsWith(".d.ts") ? [path.join(entry,item.name)] : []);
}
const extensions = configured.flatMap(entries);
const root = fs.mkdtempSync(path.join(process.cwd(), ".resume-cli-profile-"));
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const preload = fileURLToPath(new URL("./trace-cli-startup.mjs", import.meta.url));
const provider = path.join(root, "offline.mjs");
fs.writeFileSync(provider, `export default pi => pi.registerProvider('offline-resume', {api:'offline-resume',apiKey:'synthetic',baseUrl:'http://invalid.local',models:[{id:'fixture',name:'Offline fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1024}],streamSimple(){throw Error('No model calls allowed in this startup profile');}});`);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  for (const scenario of ["core-resumed", "stack-resumed", "stack-empty"]) {
    const work = path.join(root, scenario);
    fs.mkdirSync(work);
    const agentDir = path.join(work, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({defaultProvider:"offline-resume",defaultModel:"fixture",defaultProjectTrust:"never",lastChangelogVersion:"0.0.0",compaction:{enabled:false},extensions:["-builtin:codemode","-builtin:tool_search","-builtin:mcp",...(scenario.startsWith("stack")?extensions:[]),provider]}));
    const eager = eagerActors && scenario === "stack-resumed";
    fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({fullCodeMode:true,mcp:{enabled:eager},mesh:{enabled:eager},memory:{enabled:eager},agents:{enabled:eager},residency:{enabled:false},ui:{enabled:false}}));
    if (eager) {
      const actorRoot = path.join(work, ".pi/fabric/mesh/actors");
      fs.mkdirSync(actorRoot, {recursive:true});
      fs.writeFileSync(path.join(actorRoot,"actors.json"),JSON.stringify({format:1,actors:[{id:"a".repeat(32),name:"Idle fixture",instructions:"Synthetic idle actor. No events.",status:"idle",events:[],topics:[],createdAt:1,updatedAt:1}]}));
    }
    const session = path.join(work, "fixture.jsonl");
    const rows=[{type:"session",version:3,id:crypto.randomUUID(),timestamp:new Date(0).toISOString(),cwd:work}];
    let parentId=null;
    if(!scenario.endsWith("empty"))for(let i=0;i<4;i++){const id=crypto.randomUUID();rows.push({type:"message",id,parentId,timestamp:new Date(0).toISOString(),message:{role:"user",content:"RESUME_SENTINEL synthetic message "+i,timestamp:0}});parentId=id;}
    fs.writeFileSync(session, rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
    const trace=path.join(work,"trace.json");
    const output=path.join(work,"terminal.log");
    const env={...process.env,TERM:"xterm-256color",PI_CODING_AGENT_DIR:agentDir,PI_FABRIC_AGENT_DIR:agentDir,PI_STARTUP_BENCHMARK:"1",PI_OFFLINE:"1",PI_TIMING:"1",PI_RESUME_TRACE:trace,PI_RESUME_TRACE_QUIET:"1",PI_RESUME_TRACE_BENCHMARK:"1",PI_RESUME_TRACE_SENTINEL:"RESUME_SENTINEL",PI_RESUME_TRACE_FABRIC:"1"};
    const command="stty cols 120 rows 40; exec "+[process.execPath,"--import",pathToFileURL(preload).href,cli,"--session",session].map(quote).join(" ");
    let error;
    try{execFileSync("script",["-q","-e","-c",command,output],{cwd:work,env,timeout:45000,stdio:["ignore","pipe","pipe"],maxBuffer:8*1024*1024});}catch(e){error=String(e);}
    const records=fs.existsSync(trace)?JSON.parse(fs.readFileSync(trace,"utf8")):[];
    const terminal=fs.existsSync(output)?fs.readFileSync(output,"utf8"):"";
    console.log(JSON.stringify({type:"cli-resume-profile",scenario,completed:!error&&records.some(row=>row.name==="init.end"),records,...(error?{error,terminalTail:terminal.slice(-4000)}:{})}));
    assert(!error, scenario+": "+error);
    assert(records.some(row=>row.name==="init.end"), "CLI did not finish initialization");
    const state=records.find(row=>row.name==="interactive.constructed");
    assert.equal(state.messages,scenario.endsWith("empty")?0:4);
    if (eager) assert(records.some(row => row.name === "fabric.FabricRuntimeState.initialize.end"), "Actor-recovery fixture did not activate Fabric");
  }
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
