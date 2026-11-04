import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopSupported} from '../core/computer/desktop.mjs';

test('desktop app control is reported unsupported (not an error) on Linux and Windows',()=>{
 for(const platform of ['linux','win32'])assert.equal(desktopSupported(platform),false);
});
