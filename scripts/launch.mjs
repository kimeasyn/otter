import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const data=process.env.OTTER_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(),'.local','share'),'otter');
const child=spawn(resolve('artifacts/dev/otterd'),[],{stdio:'inherit',env:{...process.env,OTTER_DATA_DIR:data,OTTER_WEB_DIR:resolve('apps/web/dist')}});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code ?? 1));
for(let attempt=0;attempt<100;attempt++) {
  try {
    const connection=JSON.parse(await readFile(join(data,'connection.json'),'utf8'));
    if(connection.pid===child.pid) {
      console.log(`\nOtter is ready. Open this private URL in your browser:\n${connection.url}/#token=${connection.token}\n`);
      console.log('For home-server access, forward the port over SSH first (see README).');
      break;
    }
  } catch { /* daemon is starting */ }
  await new Promise(resolve=>setTimeout(resolve,100));
}
