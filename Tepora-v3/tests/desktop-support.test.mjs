import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopBackend,desktopSupported} from '../core/computer/desktop.mjs';
import {desktopToggleText} from '../web/provider-settings.mjs';

const X11={DISPLAY:':0',XDG_SESSION_TYPE:'x11'};

test('desktop app control has a backend on macOS, Windows and Linux X11',()=>{
 assert.deepEqual(['darwin','win32','linux'].map(p=>desktopBackend(p,X11).id),['macos','windows','linux-x11']);
 for(const platform of ['darwin','win32','linux'])assert.equal(desktopSupported(platform,X11),true,platform);
 assert.match(desktopBackend('win32',{}).label,/UI Automation/);assert.match(desktopBackend('linux',X11).label,/X11.*AT-SPI/);
});

test('Wayland, a missing display and other systems are reported unsupported (not an error)',()=>{
 const cases=[
  ['linux',{XDG_SESSION_TYPE:'wayland',DISPLAY:':0',WAYLAND_DISPLAY:'wayland-0'},'wayland'],
  ['linux',{XDG_SESSION_TYPE:'Wayland'},'wayland'],
  ['linux',{WAYLAND_DISPLAY:'wayland-0'},'wayland'],
  ['linux',{},'no-display'],['linux',{DISPLAY:''},'no-display'],
  ['freebsd',X11,'platform'],['android',{},'platform'],
 ];
 for(const [platform,env,reason]of cases){
  const b=desktopBackend(platform,env);
  assert.equal(b.supported,false,`${platform} ${JSON.stringify(env)}`);assert.equal(b.reason,reason);assert.ok(b.message.length>20);
  assert.equal(desktopSupported(platform,env),false);
 }
 assert.match(desktopBackend('linux',{XDG_SESSION_TYPE:'wayland'}).message,/Wayland.*X11/);
 // An X11 session with XWayland-style leftovers stays on X11 when the session says x11.
 assert.equal(desktopBackend('linux',{...X11,WAYLAND_DISPLAY:'wayland-0'}).supported,true);
});

test('the settings sheet names the backend, and explains an unsupported session instead of hiding it',()=>{
 assert.match(desktopToggleText({supported:true,backend:'macos'}).label,/Mac/);
 assert.match(desktopToggleText({supported:true,backend:'windows'}).label,/Windows/);
 assert.match(desktopToggleText({supported:true,backend:'linux-x11'}).label,/Linux.*X11/);
 assert.match(desktopToggleText({supported:false,reason:'wayland'}).note,/Wayland.*ブラウザ操作だけ/);
 assert.match(desktopToggleText({supported:false,reason:'no-display'}).note,/X11/);
 assert.match(desktopToggleText({supported:false,reason:'platform'}).note,/このOS.*ブラウザ操作だけ/);
 assert.doesNotMatch(desktopToggleText({supported:false,reason:'platform'}).note,/macOSのみ/);
});
