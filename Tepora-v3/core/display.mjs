import {invariant} from './policy.mjs';
import {DISPLAY_DEFAULT,validateDisplay} from '../web/display-model.mjs';
export {DISPLAY_DEFAULT,WIDGETS,validateDisplay} from '../web/display-model.mjs';
export class Display {
  constructor(store) {this.store=store;}
  get() {return this.store.value('display')||structuredClone(DISPLAY_DEFAULT);}
  change(patch,expectedRevision) {
    const old=this.get();
    invariant(expectedRevision===old.revision,'The display changed in another window. Reload before saving.',409);
    const next=validateDisplay(patch,old);
    next.revision=old.revision+1;
    const history=this.store.value('display-history')||[];
    this.store.value('display-history',[...history,old].slice(-20));
    this.store.value('display',next);
    this.store.emit('display.updated',next);
    return next;
  }
  undo(expectedRevision) {
    const current=this.get(),history=this.store.value('display-history')||[];
    invariant(current.revision===expectedRevision,'Display revision conflict',409);
    invariant(history.length,'Nothing to undo',409);
    const next={...history.pop(),revision:current.revision+1};
    this.store.value('display-history',history);this.store.value('display',next);
    this.store.emit('display.updated',next);return next;
  }
  reset(expectedRevision) {
    const {schema,revision,...patch}=DISPLAY_DEFAULT;
    return this.change(patch,expectedRevision);
  }
  export() {
    const {schema,revision,...settings}=this.get();
    return {format:'tepora-display',version:1,settings};
  }
  import(preset,expectedRevision) {
    invariant(preset?.format==='tepora-display'&&preset.version===1,'Unsupported display preset');
    invariant(Object.keys(preset).every(k=>['format','version','settings'].includes(k)),'Presets cannot include capabilities');
    return this.change(preset.settings,expectedRevision);
  }
}
