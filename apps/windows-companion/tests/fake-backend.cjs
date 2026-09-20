const { spawn } = require('node:child_process');
const readline = require('node:readline');
let child;
const mode = process.argv[2];
const input = readline.createInterface({ input: process.stdin });
process.stdout.write('{"event":"desktop.ready"}\n');
input.on('line', line => {
  if (line === 'start') {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    process.stdout.write(JSON.stringify({ testChild: child.pid }) + '\n');
    process.stdout.write('{"event":"production.host_connected"}\n');
  }
  if (line === 'stop' && mode !== 'stuck') {
    child?.kill(); input.close(); process.exit(0);
  }
});
