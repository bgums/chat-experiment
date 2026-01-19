import sqlite3, os

DB = os.path.join(os.path.dirname(__file__), "experiment.db")
if not os.path.exists(DB):
    print('DB not found at', DB)
    raise SystemExit(1)

conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute('SELECT COUNT(1) FROM sessions')
s = cur.fetchone()[0]
cur.execute('SELECT COUNT(1) FROM participants')
p = cur.fetchone()[0]
cur.execute("SELECT COUNT(1) FROM participants p LEFT JOIN sessions s ON s.participant_id=p.id WHERE s.id IS NULL")
orphan = cur.fetchone()[0]
print(f"sessions={s}, participants={p}, participants_without_sessions={orphan}")
conn.close()
