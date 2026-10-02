const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const root = path.join('d:', '下载', '智能调度', 'test-env', 'x-ops-console', 'src');
const files = [
  ['repositories/accounts-repo.js', 'src/repositories/accounts-repo.js'],
  ['routes/pages/accounts.js', 'src/routes/pages/accounts.js'],
  ['routes/api/plugin.js', 'src/routes/api/plugin.js'],
  ['views/accounts.njk', 'src/views/accounts.njk'],
];

const tmp = 'C:\\Temp\\ops-reset-dm';
fs.mkdirSync(tmp, { recursive: true });
for (const [rel] of files) {
  const src = path.join(root, rel);
  const dest = path.join(tmp, path.basename(rel));
  fs.copyFileSync(src, dest);
  console.log('staged', dest, fs.statSync(dest).size);
}

const ps1 = 'C:\\Temp\\ops-deploy-reset-dm.ps1';
const script = [
  "$ErrorActionPreference='Stop'",
  "$pass='Qq254673346.'",
  "$user='qq409648402'",
  "$host='192.168.0.100'",
  "$env:SSHPASS=$pass",
  "sshpass -e scp -o ConnectTimeout=12 -o StrictHostKeyChecking=no C:/Temp/ops-reset-dm/accounts-repo.js ${user}@${host}:/tmp/accounts-repo.js",
  "sshpass -e scp -o ConnectTimeout=12 -o StrictHostKeyChecking=no C:/Temp/ops-reset-dm/accounts.js ${user}@${host}:/tmp/accounts-pages.js",
  "sshpass -e scp -o ConnectTimeout=12 -o StrictHostKeyChecking=no C:/Temp/ops-reset-dm/plugin.js ${user}@${host}:/tmp/plugin.js",
  "sshpass -e scp -o ConnectTimeout=12 -o StrictHostKeyChecking=no C:/Temp/ops-reset-dm/accounts.njk ${user}@${host}:/tmp/accounts.njk",
].join("`r`n");
fs.writeFileSync(ps1, script, 'ascii');
console.log(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8' }));
