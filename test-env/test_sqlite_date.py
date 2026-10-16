import sqlite3
con = sqlite3.connect(':memory:')
cur = con.cursor()
rows = [('2026/8/23 10:10:20',), ('2026/08/23 10:10:20',), ('2026-08-23 10:10:20',), ('2026/8/5 10:10:20',), ('2026-08-05 10:10:20',)]
cur.execute('CREATE TABLE t(c TEXT)')
cur.executemany('INSERT INTO t VALUES (?)', rows)
print('date() on slash:', cur.execute("SELECT c, date(c) FROM t").fetchall())
print('range test >= date(2026-08-10):', cur.execute("SELECT c FROM t WHERE date(c) >= date('2026-08-10')").fetchall())
print('LIKE test:', cur.execute("SELECT c FROM t WHERE c LIKE '2026/8/23 %'").fetchall())