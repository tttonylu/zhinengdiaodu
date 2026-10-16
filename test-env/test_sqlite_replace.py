import sqlite3, tempfile, os

f = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
f.close()
con = sqlite3.connect(f.name)
cur = con.cursor()
rows = [
    ('2026/8/23 10:10:20',),
    ('2026/08/23 10:10:20',),
    ('2026-08-23 10:10:20',),
    ('2026/8/5 8:00:00',),
    ('2026/8/15 9:30:00',),
]
cur.execute('CREATE TABLE t(c TEXT)')
cur.executemany('INSERT INTO t VALUES (?)', rows)

print('== raw datetime() on slash ==')
for r in cur.execute('SELECT c, datetime(c) FROM t'):
    print(r)

print('== datetime(replace(c,\'/\',\'-\')) ==')
for r in cur.execute("SELECT c, datetime(replace(c,'/','-')) FROM t"):
    print(r)

print('== julianday(replace()) ==')
for r in cur.execute("SELECT c, julianday(replace(c,'/','-')) FROM t"):
    print(r)

print('== range filter with replace ==')
print(cur.execute("SELECT c FROM t WHERE datetime(replace(c,'/','-')) <= datetime('now','-1 hours')").fetchall())

print('== mixed format ordering via replace for sort ==')
for r in cur.execute("SELECT c FROM t ORDER BY datetime(replace(c,'/','-')) DESC"):
    print(r)

os.unlink(f.name)
print('done')