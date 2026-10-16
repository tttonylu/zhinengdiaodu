const http = require('http');
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}
(async () => {
  const base = 'http://192.168.0.100:15680';
  // 1. scripts pool version
  const pool = JSON.parse(await get(base + '/api/scripts/pool'));
  console.log('pool version:', pool.version, '| mode:', pool.mode);
  // 2. dashboard funnel heading + online label
  const dash = await get(base + '/dashboard');
  console.log('funnel heading:', dash.includes('今日私信漏斗（事件口径）') ? 'NEW(今日私信漏斗)' : (dash.includes('今日事件漏斗') ? 'OLD(今日事件漏斗)' : '?'));
  console.log('online label has 15min:', dash.includes('15分钟内心跳') ? 'YES' : 'NO');
  // 3. accounts ghost toggle
  const acc = await get(base + '/accounts');
  console.log('accounts has ghost toggle:', acc.includes('显示幽灵') || acc.includes('隐藏幽灵') ? 'YES' : 'NO');
  // 4. analytics title
  const ana = await get(base + '/analytics');
  console.log('analytics length:', ana.length);
  // 5. dm-records
  const dm = await get(base + '/dm-records?limit=1');
  const total = dm.match(/共\s*(\d+)\s*条/);
  console.log('dm records total:', total ? total[1] : '?');
})();
