
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
const origin = performance.now();
const records = [];
const output = process.env.PI_RESUME_TRACE ?? path.join(os.tmpdir(), 'pi-startup-' + process.pid + '.json');
if (!process.env.PI_RESUME_TRACE_QUIET) console.error('Startup trace: ' + output);
let tracing = true;
const flush = () => fs.writeFileSync(output, JSON.stringify(records), { mode: 0o600 });
function mark(name, fields={}) {
  if (!tracing) return;
  records.push({name,atMs:Math.round((performance.now()-origin)*100)/100,...fields});
  if (name === 'init.end' || records.length >= 2000) {
    tracing = false;
    flush();
  }
}
function wrap(target, key, name=key) {
  if (typeof target?.[key] !== 'function') return;
  const original = target[key];
  target[key] = function(...args) {
    const start=performance.now(); mark(name+'.start');
    const done=()=>mark(name+'.end',{wallMs:Math.round((performance.now()-start)*100)/100});
    try { const result=original.apply(this,args); if(result?.then)return result.then(value=>{done();return value;},error=>{done();throw error;}); done();return result; } catch(error){done();throw error;}
  };
}
globalThis.__resumeProfileClass = Base => class extends Base {
  constructor(...args) {
    super(...args);
    mark('interactive.constructed',{messages:this.session.state.messages.length,extensions:this.session.resourceLoader.getExtensions().extensions.length});
    for (const key of ['init','getChangelogForDisplay','getExtensionChangelogUpdates','bindCurrentSessionExtensions','rebindCurrentSession','showLoadedResources','showStartupNoticesIfNeeded','updateAvailableProviderCount','renderInitialMessages','renderSessionEntries','renderSessionItems','setupAutocompleteProvider','updateEditorBorderColor','updateTerminalTitle']) wrap(this,key);
    wrap(this.ui,'renderNow','tui.renderNow');
    wrap(this.session.modelRuntime,'refresh','model.refresh');
    for(const ext of this.session.resourceLoader.getExtensions().extensions) {
      for(const [event,handlers] of ext.handlers) {
        ext.handlers.set(event,handlers.map(handler=>{
          const holder={handler};wrap(holder,'handler','hook.'+event+':'+ext.path);return holder.handler;
        }));
      }
    }
    const originalNotices=this.showStartupNoticesIfNeeded;
    this.showStartupNoticesIfNeeded=(...values)=>{mark('notices.state',{coreChangelog:!!this.changelogMarkdown,extensionChangelogs:this.extensionChangelogUpdates.length});return originalNotices.apply(this,values);};
    const terminal=this.ui.terminal;
    if(terminal?.write){
      const write=terminal.write;let first=true,restored=false;
      terminal.write=function(data,...rest){
        if(first){first=false;mark('terminal.firstWrite');}
        if(!restored&&process.env.PI_RESUME_TRACE_SENTINEL && String(data).includes(process.env.PI_RESUME_TRACE_SENTINEL)){restored=true;mark('terminal.restoredFrame');}
        return write.call(this,data,...rest);
      };
    }
    const originalStop=this.stop;let stopping=false;
    this.stop=(...values)=>{
      const result=originalStop.apply(this,values);
      if(process.env.PI_RESUME_TRACE_BENCHMARK === '1' && !stopping){stopping=true;mark('interactive.stopped');void this.runtimeHost.dispose().then(()=>{mark('runtime.disposed');process.exit(0);},error=>{mark('runtime.disposeError',{error:String(error)});process.exit(1);});}
      return result;
    };
  }
};
globalThis.__resumeProfileMethods = (type, names) => { for (const name of names) if (typeof Object.getOwnPropertyDescriptor(type.prototype, name)?.value === 'function') wrap(type.prototype, name, 'fabric.' + type.name + '.' + name); };
mark('preload');
// Interpose only in memory: do not edit the installed CLI or extensions.
let instrumented = false;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const fabric = process.env.PI_RESUME_TRACE_FABRIC === '1' && url.includes('/pi-fabric/dist/');
    if (!url.startsWith('file:') || (!url.includes('/dist/bundle/') && !fabric) || loaded.source == null) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    if (fabric) {
      const classes = ['FabricState', 'FabricRuntimeState', 'RuntimeStateBuiltins'];
      const appendix = classes.filter(name => source.includes('var ' + name + ' = class')).map(name => '\nglobalThis.__resumeProfileMethods(' + name + ', ["bootstrap","ensure","initialize","tools","mesh","memory","settleComponents"]);').join('');
      return appendix ? { ...loaded, source: source + appendix } : loaded;
    }
    const needle = 'new InteractiveMode(';
    const count = source.split(needle).length - 1;
    if (!count) return loaded;
    if (count !== 1 || instrumented) throw new Error('Unexpected Pi CLI layout; refusing ambiguous instrumentation');
    instrumented = true;
    mark('cli.instrumented');
    return { ...loaded, source: source.replace(needle, 'new (globalThis.__resumeProfileClass(InteractiveMode))(') };
  },
});
process.on('exit', code => { mark('process.exit', { code, instrumented }); flush(); });
