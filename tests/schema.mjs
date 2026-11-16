// Applies every migration in order, exactly as `wrangler d1 migrations apply` would.
import {readFileSync,readdirSync} from 'node:fs';
const dir=new URL('../migrations/',import.meta.url);
export const migrations=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort().map(f=>({name:f,sql:readFileSync(new URL(f,dir),'utf8')}));
export const schema=migrations.map(m=>m.sql).join('\n');
