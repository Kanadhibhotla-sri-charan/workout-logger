"""
Backfill muscle activations for existing workout exercises.
Run this once to fix old logs that didn't track activations.
"""
import sqlite3
import json
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "workout_logger.db"

def backfill():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    print("Checking for exercises missing activations...")
    
    # Get all workout_exercises
    cursor.execute("SELECT id, exercise_id FROM workout_exercises")
    workouts = cursor.fetchall()
    
    updated_count = 0
    
    for we_id, ex_id in workouts:
        # Check if activations exist
        cursor.execute("SELECT count(*) FROM muscle_activations WHERE workout_exercise_id=?", (we_id,))
        if cursor.fetchone()[0] > 0:
            continue # Already has activations
            
        # Get exercise details
        cursor.execute("SELECT primary_muscle_id, secondary_muscles FROM exercises WHERE id=?", (ex_id,))
        row = cursor.fetchone()
        if not row:
            continue
            
        prim_id, sec_json = row
        
        # Insert Primary
        cursor.execute("""
            INSERT INTO muscle_activations (workout_exercise_id, muscle_id, activation_type)
            VALUES (?, ?, 'primary')
        """, (we_id, prim_id))
        
        # Insert Secondary
        if sec_json:
            try:
                sec_ids = json.loads(sec_json)
                for sid in sec_ids:
                    cursor.execute("""
                        INSERT INTO muscle_activations (workout_exercise_id, muscle_id, activation_type)
                        VALUES (?, ?, 'secondary')
                    """, (we_id, sid))
            except:
                pass
                
        updated_count += 1
        
    conn.commit()
    conn.close()
    print(f"[OK] Backfilled activations for {updated_count} exercises.")

if __name__ == "__main__":
    backfill()
