"""
Categorizes a list of exercises into a structured workout report.
Determines Day Type (Push/Pull/Legs) and groups by muscle.
"""
import sqlite3
from pathlib import Path
from collections import Counter

DB_PATH = Path(__file__).parent.parent.parent / "workout_logger.db"

class WorkoutCategorizer:
    def __init__(self):
        pass
        
    def categorize(self, exercise_names):
        """
        Input: ["Barbell Bench Press", "Lateral Raise", ...]
        Output: Dictionary with Day Type, Muscle Groups, etc.
        """
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Prepare report structure
        report = {
            "day_type": "UNKNOWN",
            "exercises": [],
            "muscle_counts": Counter(),
            "category_counts": Counter() # Push/Pull/Legs counts
        }
        
        for ex_name in exercise_names:
            # Get details for this exercise
            cursor.execute("""
                SELECT e.name, m.name, mg.name, mg.category 
                FROM exercises e
                JOIN muscles m ON e.primary_muscle_id = m.id
                JOIN muscle_groups mg ON m.muscle_group_id = mg.id
                WHERE e.name = ?
            """, (ex_name,))
            
            row = cursor.fetchone()
            if row:
                real_name, muscle_name, group_name, category = row
                
                report["exercises"].append({
                    "name": real_name,
                    "muscle": muscle_name,
                    "group": group_name,
                    "category": category
                })
                
                # Track counts for logic
                report["muscle_counts"][group_name] += 1
                report["category_counts"][category] += 1
            else:
                pass # Should not happen if name comes from Matcher
                
        conn.close()
        
        # Determine Day Type (Majority Rule)
        if report["category_counts"]:
            # Returns [('PUSH', 5), ('PULL', 1)]
            most_common = report["category_counts"].most_common(1)[0]
            report["day_type"] = most_common[0] # e.g., "PUSH"
            
        return report

# Quick Test
if __name__ == "__main__":
    categorizer = WorkoutCategorizer()
    
    # Simulate a Push Day input
    test_workout = [
        "Barbell Bench Press",
        "Incline Dumbbell Press",
        "Overhead Press",
        "Lateral Raise",
        "Tricep Rope Pushdown"
    ]
    
    result = categorizer.categorize(test_workout)
    
    print(f"[RESULT] Detected Day Type: {result['day_type']}")
    print("-" * 30)
    for ex in result['exercises']:
        print(f"• {ex['name']} ({ex['muscle']} - {ex['category']})")
