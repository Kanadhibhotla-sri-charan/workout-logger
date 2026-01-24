"""
Core service for logging workouts.
Shared by CLI and Web App.
"""
import json
from src.models.database import get_connection

def save_workout(date, day_type, raw_input, exercises):
    """
    Saves a workout to the database.
    exercises: List of dicts {name, sets, reps, weight}
    """
    conn = get_connection()
    cursor = conn.cursor()
    
    # Save Log
    # standardizing on RETURNING id for Postgres/SQLite compatibility
    cursor.execute("""
        INSERT INTO workout_logs (workout_date, day_type, exercises_raw)
        VALUES (?, ?, ?)
        RETURNING id
    """, (date, day_type, raw_input))
    
    log_id = cursor.fetchone()[0]
    
    # Save Individual Items (Exercises & Cardio)
    for item in exercises:
        # Check type (default to lift if missing for backward compat)
        item_type = item.get('type', 'lift')
        
        if item_type == 'cardio':
            # --- SAVE CARDIO ---
            c_name = item.get('name', 'Cardio')
            c_duration = item.get('duration')
            c_distance = item.get('distance')
            c_speed = item.get('speed')
            c_cals = item.get('calories')
            
            cursor.execute("""
                INSERT INTO cardio_logs (workout_log_id, activity_name, duration, distance, speed, calories)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (log_id, c_name, c_duration, c_distance, c_speed, c_cals))
            
        else:
            # --- SAVE LIFTING ---
            ex_name = item.get('name')
            if not ex_name: continue
            
            sets = item.get('sets')
            reps = item.get('reps')
            weight = item.get('weight')
            
            # Get ID and muscle info
            cursor.execute("SELECT id, primary_muscle_id, secondary_muscles FROM exercises WHERE name = ?", (ex_name,))
            row = cursor.fetchone()
            
            if not row:
                continue
                
            ex_id, prim_id, sec_json = row
            
            # Save workout_exercise with DETAILS
            cursor.execute("""
                INSERT INTO workout_exercises (workout_log_id, exercise_id, sets, reps, weight)
                VALUES (?, ?, ?, ?, ?)
                RETURNING id
            """, (log_id, ex_id, sets, reps, weight))
            
            we_id = cursor.fetchone()[0]
            
            # Save PRIMARY activation
            cursor.execute("""
                INSERT INTO muscle_activations (workout_exercise_id, muscle_id, activation_type)
                VALUES (?, ?, 'primary')
            """, (we_id, prim_id))
            
            # Save SECONDARY activations
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
        
    conn.commit()
    conn.close()
    return log_id
