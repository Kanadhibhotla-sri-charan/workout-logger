"""
Script to cleanup duplicate logs and update dates.
"""
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "workout_logger.db"

def cleanup():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 1. Get today's logs (using local date from system usually, but just fetching all for now to see)
    print("\n--- RECENT WORKOUT LOGS ---")
    cursor.execute("SELECT id, workout_date, exercises_raw FROM workout_logs ORDER BY id DESC LIMIT 5")
    rows = cursor.fetchall()
    
    if not rows:
        print("No logs found.")
        return

    for r in rows:
        print(f"ID: {r[0]} | Date: {r[1]} | {r[2]}")
        
    print("-" * 40)
    keep_id = input("Enter the ID you want to KEEP (others with same date will be deleted? No, let's just pick specific IDs to delete): \nActually, better: Enter the ID of the ONE log you want to KEEP and UPDATE to 2026-01-14: ")
    
    if not keep_id.strip().isdigit():
        print("Invalid ID.")
        return
        
    keep_id = int(keep_id)
    
    # 2. Get the date of the one we are keeping to find duplicates
    cursor.execute("SELECT workout_date FROM workout_logs WHERE id=?", (keep_id,))
    row = cursor.fetchone()
    if not row:
        print("ID not found.")
        return
    
    target_date = row[0]
    
    # 3. Find others on that date to delete
    cursor.execute("SELECT id FROM workout_logs WHERE workout_date=? AND id != ?", (target_date, keep_id))
    others = cursor.fetchall()
    other_ids = [o[0] for o in others]
    
    if other_ids:
        print(f"\nFound duplicate/extra logs on {target_date}: IDs {other_ids}")
        confirm = input("Delete these extra logs? (y/n): ")
        if confirm.lower() == 'y':
            ids_str = ','.join(map(str, other_ids))
            cursor.execute(f"DELETE FROM workout_logs WHERE id IN ({ids_str})")
            print(f"[OK] Deleted {len(other_ids)} logs.")
    else:
        print("No other logs found on that date to delete.")

    # 4. Update the date
    new_date = "2026-01-14"
    print(f"\nUpdating Log ID {keep_id} date from {target_date} -> {new_date}")
    confirm_upd = input("Proceed? (y/n): ")
    if confirm_upd.lower() == 'y':
        cursor.execute("UPDATE workout_logs SET workout_date=? WHERE id=?", (new_date, keep_id))
        conn.commit()
        print("[OK] Date updated successfully!")
    
    conn.close()

if __name__ == "__main__":
    cleanup()
