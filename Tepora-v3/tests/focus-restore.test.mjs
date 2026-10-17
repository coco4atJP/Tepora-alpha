import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Exercise the production functions without booting the application or a native service.
const app=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function captureFocus(scope)'),app.indexOf('function captureScroll(scope)'));
function fixture(){
 const document={activeElement:null},queries=[];
 const {captureFocus,restoreFocus}=vm.runInNewContext(`${source}\n({captureFocus,restoreFocus})`,{document});
 let children=[];
 const scope={
  contains:el=>el===scope||children.includes(el),
  querySelectorAll:selector=>{
   queries.push(selector);
   assert.ok(['[id]','[data-action]'].includes(selector),'identity values must never become selector syntax');
   return children.filter(el=>selector==='[id]'?!!el.id:el.dataset.action!==undefined);
  },
  focus:options=>{assert.equal(options.preventScroll,true);document.activeElement=scope;}
 };
 const make=({dataset={},id='',tagName='BUTTON',type='',value=''}={})=>{
  const el={dataset,id,tagName,type,value,focus:options=>{assert.equal(options?.preventScroll,true);document.activeElement=el;}};
  return el;
 };
 return {document,scope,queries,make,captureFocus,restoreFocus,replace:elements=>{children=elements;}};
}

test('focus outside the render scope and the scope itself are not captured',()=>{
 const f=fixture();
 assert.equal(f.captureFocus(f.scope),null);
 f.document.activeElement=f.make({dataset:{action:'widget-toggle'}});
 assert.equal(f.captureFocus(f.scope),null);
 f.document.activeElement=f.scope;
 assert.equal(f.captureFocus(f.scope),null);
 f.restoreFocus(f.scope,null);
 assert.deepEqual(f.queries,[]);
});

test('repeated widget checkbox redraws retain the exact native input value after reordering',()=>{
 const f=fixture(),checkbox=value=>f.make({dataset:{action:'widget-toggle'},tagName:'INPUT',type:'checkbox',value});
 let target=checkbox('focus');f.replace([checkbox('clock'),target,checkbox('memo')]);f.document.activeElement=target;
 for(let i=0;i<3;i++){
  const key=f.captureFocus(f.scope);target=checkbox('focus');
  f.replace([checkbox('clock'),checkbox('memo'),target]);f.restoreFocus(f.scope,key);
  assert.equal(f.document.activeElement,target);
 }
});

test('pin and widget reorder buttons retain data-widget rather than the first same-action sibling',()=>{
 for(const action of ['toggle-pin-widget','widget-up','widget-down']){
  const f=fixture(),button=widget=>f.make({dataset:{action,widget}}),old=button('schedule');
  f.replace([button('weather'),old]);f.document.activeElement=old;const key=f.captureFocus(f.scope);
  const target=button('schedule');f.replace([button('weather'),button('memo'),target]);f.restoreFocus(f.scope,key);
  assert.equal(f.document.activeElement,target,action);
 }
});

test('existing action identities and scene/view keys survive replacements, including empty and CSS-special values',()=>{
 for(const name of ['id','view','value','tab','scene','widget'])for(const value of ['', 'target', 'a\"]#b\\c\n']){
  const f=fixture(),data={[name]:value,action:'choose'},old=f.make({dataset:data});
  f.replace([old]);f.document.activeElement=old;const key=f.captureFocus(f.scope);
  const target=f.make({dataset:data});f.replace([f.make({dataset:{action:'choose',[name]:'different'}}),target]);
  f.restoreFocus(f.scope,key);assert.equal(f.document.activeElement,target,`${name}: ${JSON.stringify(value)}`);
 }
});

test('element IDs are compared literally and keep precedence over action fallback',()=>{
 const f=fixture(),id='a\"]#b\\c',old=f.make({id,dataset:{action:'old'}});
 f.replace([old]);f.document.activeElement=old;const key=f.captureFocus(f.scope);
 const target=f.make({id,dataset:{action:'new'}});f.replace([f.make({id:'other',dataset:{action:'old'}}),target]);
 f.restoreFocus(f.scope,key);assert.equal(f.document.activeElement,target);
});

test('a missing identity falls back to the scope without selecting another widget',()=>{
 const f=fixture(),old=f.make({dataset:{action:'toggle-pin-widget',widget:'memo'}});
 f.replace([old]);f.document.activeElement=old;const key=f.captureFocus(f.scope);
 f.replace([f.make({dataset:{action:'toggle-pin-widget',widget:'weather'}})]);f.restoreFocus(f.scope,key);
 assert.equal(f.document.activeElement,f.scope);
});

test('editable field values do not become focus identity, while radio values do',()=>{
 for(const [tagName,type] of [['INPUT','text'],['SELECT','select-one']]){
  const f=fixture(),old=f.make({tagName,type,value:'before',dataset:{action:'field'}});
  f.replace([old]);f.document.activeElement=old;const key=f.captureFocus(f.scope);
  const target=f.make({tagName,type,value:'after',dataset:{action:'field'}});f.replace([target]);f.restoreFocus(f.scope,key);
  assert.equal(f.document.activeElement,target);
 }
 const f=fixture(),radio=value=>f.make({tagName:'INPUT',type:'radio',value,dataset:{action:'choice'}}),old=radio('b');
 f.replace([old]);f.document.activeElement=old;const key=f.captureFocus(f.scope),target=radio('b');
 f.replace([radio('a'),target]);f.restoreFocus(f.scope,key);assert.equal(f.document.activeElement,target);
});
