import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const historical = JSON.parse(await fs.readFile(path.join(here, 'historical-eight.json')));
const filter = historical.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const supervisor = ['supervisor-admin-activation', 'supervisor-admin', 'supervisor-daemon-exit', 'supervisor-failure-stop', 'supervisor-native-control', 'supervisor-operation-lock', 'supervisor-startup', 'supervisor'].map(s => s + '.test.ts');
function checkReport(report, kind) {
  const files = report.testResults ?? [];
  const assertions = files.flatMap(file => file.assertionResults ?? []);
  const selected = kind === 'historical' ? assertions.filter(a => historical.some(name => a.fullName.endsWith(name))) : assertions;
  assert(selected.length > 0, 'No executed assertions');
  assert(selected.every(a => a.status === 'passed' || a.status === 'failed'), 'Skipped or unexecuted required assertion');
  if (kind === 'historical') {
    assert.equal(selected.length, 8);
    for (const name of historical) assert.equal(selected.filter(a => a.fullName.endsWith(name)).length, 1);
  }
  if (kind === 'supervisor') {
    for (const name of supervisor) assert(files.some(f => path.basename(f.name) === name), `Missing ${name}`);
    assert.equal(files.filter(f => supervisor.includes(path.basename(f.name))).flatMap(f => f.assertionResults).length, 139);
  }
  return { total: selected.length, passed: selected.filter(a => a.status === 'passed').length, failed: selected.filter(a => a.status === 'failed').length };
}
if (process.argv.includes('--self-check')) {
  assert.equal(historical.length, 8);
  for (const name of historical) assert(new RegExp(filter).test(name));
  const valid = {testResults:[{assertionResults:historical.map(fullName=>({fullName,status:'passed'}))}]};
  assert.equal(checkReport(valid, 'historical').passed, 8);
  assert.throws(()=>checkReport({testResults:[]}, 'historical'));
  valid.testResults[0].assertionResults[0].status='pending';
  assert.throws(()=>checkReport(valid, 'historical'));
  console.log('Validator self-check PASS');
  process.exit(0);
}
const role = process.env.VALIDATION_ROLE;
assert(['parent','candidate'].includes(role));
const source = path.resolve('source');
const evidence = path.join(process.env.RUNNER_TEMP, 'm64-evidence-' + role);
await fs.mkdir(evidence, {mode:0o700});
const save = (name, value) => fs.writeFile(path.join(evidence, name), JSON.stringify(value,null,2)+'\n', {mode:0o600});
try {
  const packageHashes = {};
  for (const file of ['validate.mjs','validation-plan.json','historical-eight.json','frozen-delta.bundle']) packageHashes[file]=createHash('sha256').update(await fs.readFile(path.join(here,file))).digest('hex');
  await save('validator-identity.json',{workflowCommit:process.env.GITHUB_SHA,workflowRef:process.env.GITHUB_REF,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,packageHashes});
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.version, 'v24.20.0');
  const privateRoot = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'm64-private-'));
  await fs.chmod(privateRoot, 0o700);
  const home = path.join(privateRoot, 'home');
  const tmp = path.join(privateRoot, 'tmp');
  await fs.mkdir(home, {mode:0o700});
  await fs.mkdir(tmp, {mode:0o700});
  const env = {PATH:process.env.PATH, HOME:home, TMPDIR:tmp, CI:'true', LANG:'en_US.UTF-8', IRIS_RUNTIME_DATA_ROOT:path.join(privateRoot,'runtime'), TARGET_SHA:process.env.TARGET_SHA, TARGET_TREE:process.env.TARGET_TREE, BASELINE_SHA:'1dce8053aa6fcd52b2766b6b96538bea5f202409', HISTORICAL_FILTER:filter};
  const exec = (cmd,args,cwd=source) => execFileSync(cmd,args,{cwd,env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024}).trim();
  assert.equal(exec('pnpm',['--version']), '10.15.0');
  assert.equal(exec('git',['rev-parse','HEAD']), env.TARGET_SHA);
  assert.equal(exec('git',['rev-parse','HEAD^{tree}']), env.TARGET_TREE);
  assert.equal(exec('git',['status','--porcelain']), '');
  if (role === 'candidate') assert.equal(exec('git',['rev-parse','HEAD^']), '0b2c2723736701ca69ac52967029012ec090c840');
  const config = exec('git',['config','--local','--list']);
  assert(!/extraheader|credential\./i.test(config), 'Checkout retains credential configuration');
  for (const root of ['/Users/RARW', '/Users/bill']) await assert.rejects(fs.access(root), {code:'ENOENT'});
  assert.match(exec('/bin/ps',['-p',String(process.pid),'-o','pid=,lstart=']), new RegExp(String(process.pid)));
  const identity = exec('/usr/bin/python3',['-I','-S','apps/runtime/macos-safety-helper.py','process-start',String(process.pid)]);
  assert(identity && identity !== 'null');
  const server = createServer();
  server.listen({host:'127.0.0.1',port:0});
  await once(server,'listening');
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const child = spawn(process.execPath,['-e',"console.log('READY');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],{env,stdio:['pipe','pipe','pipe']});
  const exited = once(child,'exit');
  const timer = setTimeout(()=>{ console.error('Disposable child deadline exceeded');process.exit(1); },10000);
  try { assert.match(String((await once(child.stdout,'data'))[0]), /READY/); child.stdin.end(); assert.equal((await exited)[0],0); } finally { clearTimeout(timer); }
  const first=path.join(tmp,'first'), second=path.join(tmp,'second'), link=path.join(tmp,'link');
  await fs.writeFile(first,'m64'); await fs.rename(first,second); await fs.symlink(second,link);
  assert.equal(await fs.readFile(link,'utf8'),'m64'); await fs.unlink(link); await fs.unlink(second);
  await save('environment.json',{status:'PASS',role,platform:process.platform,node:process.version,pnpm:'10.15.0',sha:env.TARGET_SHA,tree:env.TARGET_TREE,loopback:true,ps:true,processStart:true,disposableChild:true,filesystem:true,githubHosted:true,environmentKeys:Object.keys(env),productionCredentialsInherited:false,protectedOwnerHomesAbsent:true});
  const results=[];
  async function run(name,command,index) {
    const log = await fs.open(path.join(evidence,index+'.log'),'w',0o600);
    try {
      const child=spawn('/bin/bash',['-euo','pipefail','-c',command],{cwd:source,env,stdio:['ignore',log.fd,log.fd]});
      const [code,signal]=await once(child,'exit');
      results.push({name,code,signal});
      return code===0;
    } finally { await log.close(); }
  }
  if (!await run('Frozen dependency install','pnpm install --frozen-lockfile --ignore-scripts','install')) throw new Error('Dependency installation failed; no tests executed');
  const plan=JSON.parse(await fs.readFile(path.join(here,'validation-plan.json')));
  for (const [index,item] of plan.entries()) {
    let command=item.command;
    const report=path.join(evidence,index+'.json');
    if (command.includes('vitest run')) command=command.replace('vitest run',`vitest run --maxWorkers=1 --reporter=verbose --reporter=json --outputFile='${report}'`);
    await run(item.name,command,index);
    if (command.includes('vitest run')) {
      try { results.at(-1).coverage=checkReport(JSON.parse(await fs.readFile(report)),index===0?'historical':item.name.startsWith('Run all Supervisor')?'supervisor':'all'); }
      catch(error) { results.at(-1).coverageError=String(error); }
    }
  }
  const finalIdentity = {sha:exec('git',['rev-parse','HEAD']),tree:exec('git',['rev-parse','HEAD^{tree}']),status:exec('git',['status','--porcelain']),diff:exec('git',['diff','HEAD','--name-only'])};
  await save('final-source-identity.json',finalIdentity);
  await save('results.json',results);
  assert.equal(finalIdentity.sha, env.TARGET_SHA);
  assert.equal(finalIdentity.tree, env.TARGET_TREE);
  assert.equal(finalIdentity.status, '', 'Source changed during validation');
  assert.equal(finalIdentity.diff, '');
  assert(results.every(r=>r.code===0 && !r.coverageError), 'Validation failed; inspect individual results and assertions');
} catch(error) {
  await save('failure.json',{error:String(error),stack:error.stack});
  console.error(error);
  process.exitCode=1;
}
