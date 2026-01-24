"""
Service for handling diet logs.
"""
from src.models.database import get_connection

def save_diet_logs(date, log_items):
    """
    Saves a list of diet entries to the database.
    items: List of dicts {meal_type, food_raw, calories, protein, carbs, fats}
    """
    conn = get_connection()
    cursor = conn.cursor()
    
    for item in log_items:
        cursor.execute("""
            INSERT INTO diet_logs (log_date, meal_type, food_raw, calories, protein, carbs, fats)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            date,
            item.get('meal_type', 'Snack'),
            item.get('food_raw', ''),
            item.get('calories', 0),
            item.get('protein', 0),
            item.get('carbs', 0),
            item.get('fats', 0)
        ))
        
    conn.commit()
    conn.close()

def get_diet_history():
    """Returns diet logs ordered by date desc."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM diet_logs ORDER BY log_date DESC, id DESC LIMIT 50")
    rows = cursor.fetchall()
    conn.close()
    return rows
