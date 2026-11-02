"""Create a portable, verified archive without importing the application's DB module."""
import csv
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1]).resolve()
if destination.is_relative_to(root):
    raise SystemExit("Backup destination must be outside the project.")
if destination.exists():
    raise SystemExit("Refusing to overwrite an existing backup.")
source_path = root / "server/data/experiment.db"
source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)
destination.mkdir(parents=True)
data_dir = destination / "data"
data_dir.mkdir()
backup_path = data_dir / "experiment.db"
with sqlite3.connect(backup_path) as backup:
    source.backup(backup)
source.close()

# Retain auxiliary data tools, but never copy live SQLite sidecars as databases.
for entry in (root / "server/data").iterdir():
    if entry.name.startswith("experiment.db"):
        continue
    target = data_dir / entry.name
    if entry.is_dir():
        shutil.copytree(entry, target, ignore=shutil.ignore_patterns("__pycache__"))
    else:
        shutil.copy2(entry, target)

counts = {}
exports = destination / "tables_csv"
exports.mkdir()
with sqlite3.connect(backup_path) as backup:
    integrity = backup.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise SystemExit(f"Backup integrity check failed: {integrity}")
    tables = backup.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    for (table,) in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        cursor = backup.execute(f"SELECT * FROM {quoted}")
        rows = cursor.fetchall()
        counts[table] = len(rows)
        with (exports / f"{table}.csv").open("w", encoding="utf-8-sig", newline="") as output:
            writer = csv.writer(output)
            writer.writerow([column[0] for column in cursor.description])
            writer.writerows(rows)
    schema = backup.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").fetchall()
    (destination / "schema.sql").write_text(";\n\n".join(row[0] for row in schema) + ";\n", encoding="utf-8")
    participant_columns = [row[1] for row in backup.execute("PRAGMA table_info(participants)")]

commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=root, text=True).strip()
subprocess.run([
    "git", "archive", "--format=zip", f"--output={destination / 'original-source.zip'}", "HEAD",
    "server", "client", "scripts", "package.json", "package-lock.json", "README.md"
], cwd=root, check=True)

readme = f"""# גיבוי עצמאי של הניסוי הישן

נוצר ב־{datetime.now(timezone.utc).isoformat()} (UTC).
מקור: {root}
ענף בעת הגיבוי: {branch}
קומיט המקור הישן: {commit}

## מה נמצא כאן

- data/experiment.db — עותק SQLite עקבי שנוצר באמצעות מנגנון הגיבוי של SQLite,
  ללא הפעלת האפליקציה וללא הרצת המיגרציות החדשות. זהו קובץ השחזור הראשי.
- data/db_data_actions — כלי הנתונים הנלווים מהתיקייה המקורית, אם היו בה.
- tables_csv/ — קובץ לכל טבלה, עם כותרות ובקידוד UTF-8 התואם ל־Excel.
  אלה עותקים נוחים לעיון; ה־DB הוא המקור המלא, כולל טיפוסים וערכי NULL.
- schema.sql — תיאור מבנה הטבלאות והאינדקסים.
- original-source.zip — קוד הגרסה השמורה ב־Git לפני השינויים הנוכחיים,
  כולל הטפסים, המודולים, הפרומפטים, הגדרות הזרימה וקובצי התלויות.
  השינויים החדשים שטרם בוצע להם commit אינם כלולים בו.
- manifest.json — פרטי הגיבוי, מספר הרשומות בכל טבלה ובדיקת SHA-256 לקבצים.

## מה נשמר

הנתונים נשמרו כפי שהם, כולל שיוך הקבוצה וסדר הקריאה של הפרוטוקול הישן,
ככל שקיימים במסד המקורי. לא בוצעה המרה ל־experiment ולא הוסרה עמודה.
עמודות participants בגיבוי: {', '.join(participant_columns)}.
בדיקת תקינות SQLite הסתיימה בתוצאה: {integrity}.

מספר הרשומות בכל טבלה:
{chr(10).join(f'- {name}: {count}' for name, count in counts.items())}

## העברה ושחזור

אפשר להעביר את כל התיקייה לכל מקום במחשב, לכונן חיצוני או למיקום גיבוי פרטי.
הקבצים עצמאיים ואינם תלויים במיקום הפרויקט. מומלץ לשמור את הגיבוי הזה ללא שינוי.

לעיון: פתחי עותק של data/experiment.db בכלי SQLite, או את קובצי ה־CSV.
לשחזור הגרסה הישנה: חלצי original-source.zip לתיקייה נפרדת, התקיני את התלויות
באמצעות npm install, והגדירי SQLITE_PATH לעותק של מסד הנתונים מהגיבוי.
יש להגדיר מחדש את מפתח OpenAI ושאר הגדרות הסביבה לפי הצורך.
קובץ .env, מפתחות API ו־node_modules אינם כלולים בגיבוי.

אל תפעילי את האפליקציה החדשה מול עותק הארכיון היחיד: היא מריצה מיגרציה אוטומטית.
לעבודה עם הגרסה החדשה השתמשי במסד נפרד או בעותק נוסף.

הגיבוי לא מחק, הזיז או שינה את הנתונים המקוריים בפרויקט, ולא שינה את SQLITE_PATH.
"""
(destination / "README_HE.md").write_text(readme, encoding="utf-8-sig")

files = {}
for file in sorted(destination.rglob("*")):
    if file.is_file():
        files[str(file.relative_to(destination))] = {"bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
manifest = {"created_at_utc": datetime.now(timezone.utc).isoformat(), "source": str(source_path), "branch": branch, "source_commit": commit, "sqlite_integrity_check": integrity, "row_counts": counts, "files": files}
(destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
for relative, info in files.items():
    assert hashlib.sha256((destination / relative).read_bytes()).hexdigest() == info["sha256"]
print(json.dumps({"destination": str(destination), "integrity": integrity, "row_counts": counts, "verified_files": len(files)}, ensure_ascii=False))
