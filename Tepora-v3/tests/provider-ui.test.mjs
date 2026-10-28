import test from 'node:test';
import assert from 'node:assert/strict';
import {providerRouteChoices,providerFallbackChoices,providerConnectionStatus} from '../web/provider-presets.mjs';

const profiles=[
 {id:'local',name:'このPC',domain:'device',enabled:true,capabilities:{vision:true}},
 {id:'cloud',name:'API',domain:'cloud',enabled:true,capabilities:{vision:null}},
 {id:'disabled',domain:'device',enabled:false,capabilities:{vision:true}},
 {id:'plan-a',domain:'cloud',authMode:'chatgpt',accountId:'account-a',enabled:true,capabilities:{vision:true}},
 {id:'plan-a-backup',domain:'cloud',authMode:'chatgpt',accountId:'account-a',enabled:true,capabilities:{vision:true}},
 {id:'plan-b',domain:'cloud',authMode:'chatgpt',accountId:'account-b',enabled:true,capabilities:{vision:true}},
 {id:'pi-oauth-a',domain:'cloud',authMode:'pi-oauth',accountId:'pi-a',enabled:true,capabilities:{vision:true}},
 {id:'pi-oauth-a-backup',domain:'cloud',authMode:'pi-oauth',accountId:'pi-a',enabled:true,capabilities:{vision:true}},
 {id:'pi-key-a',domain:'cloud',authMode:'pi-key',accountId:'pi-a',enabled:true,capabilities:{vision:true}}
];
test('named role choices exclude disabled profiles and keep vision and dictation constraints',()=>{
 assert.equal(providerRouteChoices(profiles,'main').some(p=>p.id==='disabled'),false);
 assert.equal(providerRouteChoices(profiles,'vision').some(p=>p.id==='cloud'),false);
 assert.deepEqual(providerRouteChoices(profiles,'dictation').map(p=>p.id),['local']);
});
test('named fallback choices preserve account and billing boundaries',()=>{
 assert.deepEqual(providerFallbackChoices(profiles,'main','local').map(p=>p.id),['cloud']);
 assert.deepEqual(providerFallbackChoices(profiles,'main','plan-a').map(p=>p.id),['plan-a-backup']);
 assert.deepEqual(providerFallbackChoices(profiles,'main','pi-oauth-a').map(p=>p.id),['pi-oauth-a-backup']);
 assert.deepEqual(providerFallbackChoices(profiles,'dictation','local'),[]);
 assert.deepEqual(providerFallbackChoices(profiles,'main','missing'),[]);
});
test('registration and saved credentials never imply that a connection was tested',()=>{
 assert.deepEqual(providerConnectionStatus({domain:'device'}),{label:'接続テストはまだです',tone:'idle'});
 assert.equal(providerConnectionStatus({domain:'cloud',keyPresent:true}).label,'接続テストはまだです');
 assert.equal(providerConnectionStatus({domain:'cloud',keyPresent:false,probe:{ok:true}}).label,'APIキー未設定');
 assert.equal(providerConnectionStatus({authMode:'pi-oauth',authStatus:{connected:false},probe:{ok:true}}).label,'再ログインが必要');
 assert.equal(providerConnectionStatus({domain:'cloud',keyPresent:true,probe:{ok:true}}).label,'接続テスト済み');
 assert.equal(providerConnectionStatus({enabled:false,probe:{ok:true}}).label,'無効');
 assert.equal(providerConnectionStatus({probe:{ok:false}}).label,'接続を確認してください');
});
