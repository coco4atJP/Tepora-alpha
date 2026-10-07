/** Build-time compatibility data only. The Rust service never executes JS to
 * load its defaults; parity tests detect drift while domain ports continue. */
import {writeFile} from 'node:fs/promises';
import {DEFAULT_SETTINGS} from '../../core/policy.mjs';
import {AGENT_DEFAULTS} from '../../core/agent/runtime.mjs';
import {defaultPersonas} from '../../core/persona.mjs';
import {DISPLAY_DEFAULT} from '../../web/display-model.mjs';
import {AVATAR_DEFAULT} from '../../web/avatar/model.mjs';
const data={settings:DEFAULT_SETTINGS,agent:AGENT_DEFAULTS,personas:defaultPersonas(),display:DISPLAY_DEFAULT,avatar:AVATAR_DEFAULT};
await writeFile(new URL('../defaults.json',import.meta.url),JSON.stringify(data,null,2)+'\n');
