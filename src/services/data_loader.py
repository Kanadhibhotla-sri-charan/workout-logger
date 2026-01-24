"""
Script to load exercises from JSON into the database.
Handles mapping text names to database IDs.
"""
import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "workout_logger.db"
DATA_PATH = Path(__file__).parent.parent / "data" / "exercises.json"

# Fuzzy/Direct link when the JSON name implies a group but DB needs a specific muscle
# This maps "Group Name" -> "Default Specific Muscle"
MUSCLE_DEFAULTS = {
    "Quads": "Rectus Femoris", 
    "Hamstrings": "Biceps Femoris",
    "Glutes": "Gluteus Maximus",
    "Calves": "Gastrocnemius",
    "Biceps": "Long Head Bicep",
    "Triceps": "Long Head Tricep",
    "Shoulders": "Front Delts",
    "Chest": "Mid Pecs",
    "Back": "Outer Lats",
    "Traps": "Traps",         # Exists as specific muscle
    "Lats": "Outer Lats",
    "Forearms": None          # We don't track forearms yet, will ignore
}

def get_db():
    return sqlite3.connect(DB_PATH)

def find_muscle_id(cursor, muscle_name):
    """
    Find muscle ID by name. 
    1. Try exact match.
    2. Try mapping default (e.g. Quads -> Rectus Femoris).
    3. Return None if not found.
    """
    # 1. Exact Match
    cursor.execute("SELECT id FROM muscles WHERE name = ?", (muscle_name,))
    row = cursor.fetchone()
    if row:
        return row[0]
    
    # 2. Check Defaults/Mapping
    start_name = muscle_name
    if muscle_name in MUSCLE_DEFAULTS:
        mapped_name = MUSCLE_DEFAULTS[muscle_name]
        if mapped_name:
            cursor.execute("SELECT id FROM muscles WHERE name = ?", (mapped_name,))
            row = cursor.fetchone()
            if row:
                return row[0]
            
    print(f"   [WARN] Muscle '{start_name}' not found in DB.")
    return None

def load_exercises():
    print(f"Loading exercises from {DATA_PATH}...")
    
    with open(DATA_PATH, 'r') as f:
        data = json.load(f)
        
    conn = get_db()
    cursor = conn.cursor()
    
    added_count = 0
    skipped_count = 0
    
    for ex in data['exercises']:
        name = ex['name']
        aliases = json.dumps(ex['aliases'])
        p_muscle = ex['primary_muscle']
        s_muscles_list = ex.get('secondary_muscles', [])
        ex_type = ex['type']
        
        # Resolve Primary Muscle ID
        p_id = find_muscle_id(cursor, p_muscle)
        if not p_id:
            print(f"❌ Skipping '{name}': Primary muscle '{p_muscle}' invalid.")
            skipped_count += 1
            continue
            
        # Resolve Secondary Muscle IDs
        s_ids = []
        for sm in s_muscles_list:
            mid = find_muscle_id(cursor, sm)
            if mid:
                s_ids.append(mid)
        
        try:
            cursor.execute("""
                INSERT OR IGNORE INTO exercises 
                (name, aliases, primary_muscle_id, secondary_muscles, exercise_type)
                VALUES (?, ?, ?, ?, ?)
            """, (name, aliases, p_id, json.dumps(s_ids), ex_type))
            
            if cursor.rowcount > 0:
                added_count += 1
            else:
                # Already exists
                pass
                
        except Exception as e:
            print(f"Error inserting {name}: {e}")
            
    conn.commit()
    conn.close()
    
    print(f"\n[OK] Done! Added {added_count} new exercises.")
    if skipped_count > 0:
        print(f"[WARN] Skipped {skipped_count} exercises due to missing primary muscles.")

if __name__ == "__main__":
    load_exercises()
