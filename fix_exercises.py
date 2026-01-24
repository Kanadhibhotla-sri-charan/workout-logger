import sqlite3
import os

DB_PATH = "workout_logger.db"

def fix():
    print(f"Cleaning DB at {os.path.abspath(DB_PATH)}")
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        
        # 1. Delete typo exercise if exists
        c.execute("SELECT id FROM exercises WHERE name = 'Review Delt Machine'")
        row = c.fetchone()
        if row:
            print(f"Deleting 'Review Delt Machine' (ID: {row[0]})...")
            # Delete dependent logs? No, user might have used it. 
            # Ideally update them to 'Reverse Pec Deck' ID.
            # Find 'Reverse Pec Deck' ID
            c.execute("SELECT id FROM exercises WHERE name = 'Reverse Pec Deck'")
            new_row = c.fetchone()
            if new_row:
                new_id = new_row[0]
                print(f"Migrating logs to 'Reverse Pec Deck' (ID: {new_id})...")
                c.execute("UPDATE workout_exercises SET exercise_id = ? WHERE exercise_id = ?", (new_id, row[0]))
            
            c.execute("DELETE FROM exercises WHERE id = ?", (row[0],))
            print("Deleted.")
        else:
            print("'Review Delt Machine' not found.")
            
        conn.commit()

if __name__ == "__main__":
    fix()
