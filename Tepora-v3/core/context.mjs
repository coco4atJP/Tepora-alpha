import {createHash} from 'node:crypto';
/** A stable identity for one model destination (provider kind, endpoint and model). */
export const destination=s=>createHash('sha256').update(JSON.stringify([s.provider,s.baseUrl,s.model])).digest('hex');
