import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'otter-smoke-'));
const data = join(temp, 'data');
const repo = join(temp, 'repo');
await mkdir(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {stdio: 'pipe'});
git('init', '-b', 'main');
git('-c', 'user.name=Otter Test', '-c', 'user.email=otter@example.invalid', 'commit', '--allow-empty', '-m', 'baseline');
let child;
async function start() {
  child = spawn(resolve('artifacts/dev/otterd'), [], {env:{...process.env, OTTER_BIND:'127.0.0.1:0', OTTER_DATA_DIR:data, OTTER_WEB_DIR:resolve('apps/web/dist')}, stdio:['ignore','pipe','pipe']});
  let errors=''; child.stderr.on('data', chunk=>{errors+=chunk;});
  for(let attempt=0;attempt<100;attempt++) {
    if(child.exitCode!==null) throw new Error(`Daemon exited: ${errors}`);
    try {const connection=JSON.parse(await readFile(join(data,'connection.json'),'utf8')); if(connection.pid===child.pid) return connection;} catch { /* wait for startup */ }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Daemon did not become ready');
}
async function stop() {
  if(child && child.exitCode===null) {const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGINT');await exited;}
}
try {
  let connection=await start();
  const request=async(path,body)=>{
    const response=await fetch(connection.url+'/api'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  assert.equal((await fetch(connection.url+'/api/health')).status,401);
  assert.match(await (await fetch(connection.url)).text(),/<title>Otter<\/title>/);
  const project=await request('/projects',{path:repo});
  const detail=await request('/projects/'+project.id);
  assert.equal(detail.worktrees.length,1);
  assert.equal(detail.worktrees[0].branch,'main');
  assert.equal(detail.worktrees[0].dirty,false);
  const oldToken=connection.token;
  await stop();connection=await start();
  assert.notEqual(connection.token,oldToken);
  assert.equal((await request('/projects'))[0].id,project.id);
  assert.equal((await request('/projects/'+project.id)).worktrees[0].head,detail.worktrees[0].head);
  console.log('PASS: native daemon startup, authenticated HTTP, frontend serving, real Git registration, SQLite persistence and token rotation on restart');
} finally {await stop();await rm(temp,{recursive:true,force:true});}
