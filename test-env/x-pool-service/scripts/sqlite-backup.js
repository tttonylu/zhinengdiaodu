const Database = require('better-sqlite3');
const src = process.argv[2] || '/data/x-pool.sqlite';
const dest = process.argv[3] || '/data/migrate-to-test.sqlite';
const db = new Database(src);
db.backup(dest)
  .then(() => {
    console.log('backup ok', src, '->', dest);
    db.close();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
