import sqlite3
import json
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "workout_logger.db"

def verify():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Check total count
    cursor.execute("SELECT count(*) FROM exercises")
    count = cursor.fetchone()[0]
    print(f"Total Exercises: {count}")
    
    # Check a specific example: Bench Press
    cursor.execute("""
        SELECT e.name, m.name as primary_muscle, e.secondary_muscles 
        FROM exercises e 
        JOIN muscles m ON e.primary_muscle_id = m.id 
        WHERE e.name = 'Barbell Bench Press'
    """)
    row = cursor.fetchone()
    if row:
        name, prim, sec_json = row
        # Decode secondary IDs to names
        sec_ids = json.loads(sec_json)
        sec_names = []
        if sec_ids:
            placeholders = ','.join('?' * len(sec_ids))
            cursor.execute(f"SELECT name FROM muscles WHERE id IN ({placeholders})", sec_ids)
            sec_names = [r[0] for r in cursor.fetchall()]
            
        print(f"\nExample: {name}")
        print(f"  Primary: {prim}")
        print(f"  Secondary: {', '.join(sec_names)}")
        
    conn.close()

if __name__ == "__main__":
    verify()
