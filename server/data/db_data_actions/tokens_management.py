import argparse
import sqlite3
import os
import shutil
import sys

DB = os.path.join(os.path.dirname(__file__), "experiment.db")
if not os.path.exists(DB):
    print(f"DB not found at {DB}")
    raise SystemExit(1)


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def list_tokens(db_path):
    conn = connect(db_path)
    cur = conn.cursor()
    cur.execute('SELECT session_token FROM sessions')
    rows = cur.fetchall()
    if not rows:
        print('No sessions found')
    else:
        for r in rows:
            print(r[0])
    conn.close()


def find_upcoming_tokens(db_path):
    # upcoming & not opened: status = 'pending' AND started_at IS NULL
    conn = connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT session_token, id FROM sessions WHERE (status = 'pending' OR status IS NULL) AND (started_at IS NULL)")
    rows = cur.fetchall()
    conn.close()
    return [r['session_token'] for r in rows]


def print_commented_deletes(tokens):
    if not tokens:
        print('-- No tokens to delete')
        return
    print('-- Commented SQL to delete the following session tokens:')
    for t in tokens:
        print(f"-- DELETE FROM messages WHERE session_persona_id IN (SELECT id FROM session_personas WHERE session_id = (SELECT id FROM sessions WHERE session_token = '{t}'));")
        print(f"-- DELETE FROM messages WHERE participant_id = (SELECT participant_id FROM sessions WHERE session_token = '{t}') AND session_number = (SELECT session_number FROM sessions WHERE session_token = '{t}');")
        print(f"-- DELETE FROM form_responses WHERE participant_id = (SELECT participant_id FROM sessions WHERE session_token = '{t}') AND session_number = (SELECT session_number FROM sessions WHERE session_token = '{t}');")
        print(f"-- DELETE FROM session_personas WHERE session_id = (SELECT id FROM sessions WHERE session_token = '{t}');")
        print(f"-- DELETE FROM sessions WHERE session_token = '{t}';")
        print(f"-- (Optional) DELETE FROM participants WHERE id = (SELECT participant_id FROM sessions WHERE session_token = '{t}');")


def backup_db(db_path):
    bak = f"{db_path}.bak"
    shutil.copy2(db_path, bak)
    print(f"Backup created: {bak}")
    return bak


def execute_delete_tokens(db_path, tokens):
    if not tokens:
        print('No tokens to delete')
        return
    conn = connect(db_path)
    cur = conn.cursor()
    deleted = 0
    for t in tokens:
        cur.execute('SELECT id FROM sessions WHERE session_token = ? LIMIT 1', (t,))
        r = cur.fetchone()
        if not r:
            print(f"Token not found (skipping): {t}")
            continue
        sid = r['id']

        # Load session metadata
        cur.execute('SELECT participant_id, session_number FROM sessions WHERE id = ? LIMIT 1', (sid,))
        meta = cur.fetchone()
        pid = meta['participant_id']
        s_num = meta['session_number']

        # Delete messages linked to session_personas for this session
        cur.execute('SELECT id FROM session_personas WHERE session_id = ?', (sid,))
        persona_rows = cur.fetchall()
        persona_ids = [pr['id'] for pr in persona_rows]
        if persona_ids:
            cur.execute(f"DELETE FROM messages WHERE session_persona_id IN ({','.join(['?']*len(persona_ids))})", persona_ids)

        # Delete messages that have participant_id and session_number (non-persona messages)
        cur.execute('DELETE FROM messages WHERE participant_id = ? AND session_number = ?', (pid, s_num))

        # Delete form responses for this participant/session
        cur.execute('DELETE FROM form_responses WHERE participant_id = ? AND session_number = ?', (pid, s_num))

        # Delete session_personas for this session
        cur.execute('DELETE FROM session_personas WHERE session_id = ?', (sid,))

        # Finally delete the session row
        cur.execute('DELETE FROM sessions WHERE id = ?', (sid,))
        deleted += 1
        print(f"Deleted session id={sid} token={t}")

        # If participant has no remaining sessions, delete participant and any remaining form_responses/messages
        cur.execute('SELECT COUNT(1) as cnt FROM sessions WHERE participant_id = ?', (pid,))
        cnt = cur.fetchone()[0]
        if cnt == 0:
            # Delete any leftover messages/form_responses for this participant (safety)
            cur.execute('DELETE FROM messages WHERE participant_id = ?', (pid,))
            cur.execute('DELETE FROM form_responses WHERE participant_id = ?', (pid,))
            cur.execute('DELETE FROM session_personas WHERE participant_id = ?', (pid,))
            cur.execute('DELETE FROM participants WHERE id = ?', (pid,))
            print(f"Deleted participant id={pid} (no remaining sessions)")
    conn.commit()
    conn.close()
    print(f"Total deleted: {deleted}")

    # Final cleanup pass: remove any participants that are fully orphaned
    # (no sessions, no messages, no form_responses, no session_personas)
    conn = connect(db_path)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT p.id FROM participants p
        LEFT JOIN sessions s ON s.participant_id = p.id
        LEFT JOIN messages m ON m.participant_id = p.id
        LEFT JOIN form_responses f ON f.participant_id = p.id
        LEFT JOIN session_personas sp ON sp.participant_id = p.id
        GROUP BY p.id
        HAVING COUNT(DISTINCT s.id) = 0 AND COUNT(DISTINCT m.id) = 0 AND COUNT(DISTINCT f.id) = 0 AND COUNT(DISTINCT sp.id) = 0
        """
    )
    orphan_rows = cur.fetchall()
    orphan_ids = [r['id'] for r in orphan_rows]
    if orphan_ids:
        print(f"Found orphan participant ids to delete: {orphan_ids}")
        cur.execute(f"DELETE FROM participants WHERE id IN ({','.join(['?']*len(orphan_ids))})", orphan_ids)
        conn.commit()
        print(f"Deleted {len(orphan_ids)} orphan participant(s).")
    else:
        print('No orphan participants found.')
    conn.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--db', default=DB, help='Path to experiment.db')
    p.add_argument('--list', action='store_true', help='List all session tokens')
    p.add_argument('--delete-upcoming', action='store_true', help='Print commented SQL for upcoming tokens (safe preview)')
    p.add_argument('--delete-token', help='Print commented SQL for a specific token')
    p.add_argument('--execute', action='store_true', help='Actually execute deletions (requires confirmation)')
    p.add_argument('--yes', action='store_true', help='Auto-confirm deletions (skip interactive prompt)')
    p.add_argument('--backup', action='store_true', help='Create DB backup before executing')
    args = p.parse_args()

    db_path = args.db

    if args.list:
        list_tokens(db_path)
        return

    if args.delete_token:
        tok = args.delete_token
        print('-- Preview:')
        print_commented_deletes([tok])
        if args.execute:
            if args.backup:
                backup_db(db_path)
            if args.yes:
                execute_delete_tokens(db_path, [tok])
            else:
                resp = input(f"Are you sure you want to DELETE session with token={tok}? Type 'yes' to proceed: ")
                if resp.strip().lower() == 'yes':
                    execute_delete_tokens(db_path, [tok])
                else:
                    print('Aborted.')
        else:
            print("(Not executed; add --execute to actually delete.)")
        return

    if args.delete_upcoming:
        tokens = find_upcoming_tokens(db_path)
        print('-- Upcoming tokens that are pending and have not started:')
        for t in tokens:
            print(t)
        print('')
        print_commented_deletes(tokens)
        if args.execute:
            if args.backup:
                backup_db(db_path)
            if not tokens:
                print('No tokens to delete.')
                return
            if args.yes:
                execute_delete_tokens(db_path, tokens)
            else:
                resp = input(f"Are you sure you want to DELETE {len(tokens)} upcoming session(s)? Type 'yes' to proceed: ")
                if resp.strip().lower() == 'yes':
                    execute_delete_tokens(db_path, tokens)
                else:
                    print('Aborted.')
        else:
            print("(Not executed; add --execute to actually delete.)")
        return

    p.print_help()


    
