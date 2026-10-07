import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../../core/store.mjs';
import {NetworkPolicy} from '../../core/network-policy.mjs';
import {ProviderRegistry} from '../../core/provider-registry.mjs';
import {AgentRuntime} from '../../core/agent/runtime.mjs';
import {Capabilities} from '../../core/capabilities.mjs';
import {scriptedModel} from './scripted-model.mjs';
/** `decision`: base URL of a System One server to connect as the decision model. */
export async function agentFixture(t,handler,{context=null,settings=null,profile={},reopen=null,decision=null}={}){
 const dir=reopen?.dir||await mkdtemp(path.join(os.tmpdir(),'tepora-agent-'));
 const model=reopen?.model||await scriptedModel(handler,{context});
 const store=new Store(dir),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network);
 if(!reopen)registry.save({profiles:[{id:'local',protocol:'chat-completions',baseUrl:model.url,model:'m',domain:'device',capabilities:{tools:true},firstByteTimeoutMs:10000,idleTimeoutMs:5000,...profile}],routes:{main:{primary:'local'}}},0);
 if(settings)store.value('agent-settings',settings);
 const events=[];store.listeners.add(e=>{if(e.type.startsWith('agent.'))events.push(e);});
 const capabilities=new Capabilities(store,network);
 if(decision&&!reopen)capabilities.save({profiles:[{id:'d1',name:'decision',protocol:'system-one',baseUrl:decision,model:'d1:test',domain:'device'}],routes:{decision:'d1'}},capabilities.get().revision);
 const rt=new AgentRuntime(store,{registry,network,capabilities,workRoot:path.join(dir,'work')});
 const cleanup=async({keep=false}={})=>{await rt.close();capabilities.close();store.close();if(!keep){await model.close();await rm(dir,{recursive:true,force:true});}};
 let closed=false;t.after(async()=>{if(!closed)await cleanup();});
 return {dir,store,rt,model,registry,events,restart:async()=>{closed=true;await cleanup({keep:true});return agentFixture(t,handler,{reopen:{dir,model},decision});}};
}
