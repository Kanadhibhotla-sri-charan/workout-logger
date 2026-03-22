from flask import Flask, render_template, request, redirect, url_for
import datetime
import json
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../')))

from src.services.exercise_matcher import ExerciseMatcher
from src.services.categorizer import WorkoutCategorizer
from src.services.ai_analyzer import AIAnalyzer
from src.services.workout_service import save_workout
from src.models.database import get_connection

app = Flask(__name__)

# Auto-initialize DB on startup
try:
    from src.models.database import init_database
    init_database()
except Exception as _e:
    print(f"[WARN] DB init at startup failed: {_e}")

# Initialize Services
matcher = ExerciseMatcher()
categorizer = WorkoutCategorizer()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_last_workout():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, workout_date, day_type, exercises_raw
        FROM workout_logs
        ORDER BY workout_date DESC, id DESC LIMIT 1
    """)
    row = cursor.fetchone()
    conn.close()
    return row

def get_all_exercise_names():
    """Returns all exercise names from DB for autocomplete."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM exercises ORDER BY name")
        rows = cursor.fetchall()
        conn.close()
        return [r[0] for r in rows]
    except Exception:
        return []


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route('/', methods=['GET'])
def index():
    last_workout = get_last_workout()
    exercise_names = get_all_exercise_names()
    return render_template('index.html',
                           today=str(datetime.date.today()),
                           last_workout=last_workout,
                           exercise_names=exercise_names)


@app.route('/log_workout', methods=['POST'])
def log_workout():
    date = request.form.get('date', str(datetime.date.today()))
    day_type = request.form.get('day_type', 'PUSH')
    exercises_json = request.form.get('exercises_json', '[]')

    try:
        exercises = json.loads(exercises_json)
    except Exception:
        return redirect(url_for('index'))

    if not exercises:
        return redirect(url_for('index'))

    # Build raw text summary
    raw_parts = []
    for ex in exercises:
        if ex.get('type') == 'cardio':
            parts = [ex.get('name', '')]
            if ex.get('duration'): parts.append(ex['duration'])
            if ex.get('distance'): parts.append(ex['distance'])
            raw_parts.append(' '.join(parts))
        else:
            sets_data = ex.get('sets', [])
            sets_str = ', '.join(f"{s['reps']}x{s['weight']}kg" for s in sets_data)
            raw_parts.append(f"{ex['name']}: {sets_str}")
    raw_input = ' | '.join(raw_parts)

    # Build save list
    save_list = []
    for ex in exercises:
        if ex.get('type') == 'cardio':
            save_list.append({
                'type': 'cardio',
                'name': ex.get('name', 'Cardio'),
                'duration': ex.get('duration'),
                'distance': ex.get('distance'),
            })
        else:
            sets_data = ex.get('sets', [])
            if not sets_data:
                continue
            result = matcher.match(ex['name'])
            name = result['name'] if result else ex['name']
            reps_str   = ','.join(str(s.get('reps', '')) for s in sets_data)
            weight_str = ','.join(str(s.get('weight', '')) for s in sets_data)
            save_list.append({
                'type': 'lift',
                'name': name,
                'sets': str(len(sets_data)),
                'reps': reps_str,
                'weight': weight_str,
            })

    if save_list:
        save_workout(date, day_type, raw_input, save_list)

    return redirect(url_for('report'))


@app.route('/report')
def report():
    conn = get_connection()
    cursor = conn.cursor()

    sql = """
    SELECT
        l.workout_date, l.day_type,
        e.name as item_name,
        we.sets, we.reps, we.weight,
        'lift' as type,
        NULL as duration, NULL as distance, NULL as speed
    FROM workout_logs l
    JOIN workout_exercises we ON l.id = we.workout_log_id
    JOIN exercises e ON we.exercise_id = e.id

    UNION ALL

    SELECT
        l.workout_date, l.day_type,
        cl.activity_name as item_name,
        NULL, NULL, NULL,
        'cardio' as type,
        cl.duration, cl.distance, cl.speed
    FROM workout_logs l
    JOIN cardio_logs cl ON l.id = cl.workout_log_id

    ORDER BY workout_date DESC, item_name ASC
    LIMIT 100
    """
    cursor.execute(sql)
    rows = cursor.fetchall()
    conn.close()

    return render_template('report.html', rows=rows)


@app.route('/dashboard')
def dashboard():
    today = str(datetime.date.today())
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        SELECT id, workout_date, day_type, exercises_raw
        FROM workout_logs
        WHERE workout_date = ?
        ORDER BY id DESC LIMIT 1
    """, (today,))
    today_workout = cursor.fetchone()

    today_exercises = []
    if today_workout:
        cursor.execute("""
            SELECT e.name, we.sets, we.reps, we.weight
            FROM workout_exercises we
            JOIN exercises e ON we.exercise_id = e.id
            WHERE we.workout_log_id = ?
        """, (today_workout[0],))
        today_exercises = cursor.fetchall()

    cursor.execute("""
        SELECT id, workout_date, day_type, exercises_raw
        FROM workout_logs
        ORDER BY workout_date DESC, id DESC
        LIMIT 5
    """)
    recent_workouts = cursor.fetchall()
    conn.close()

    return render_template('dashboard.html',
                           today=today,
                           today_workout=today_workout,
                           today_exercises=today_exercises,
                           recent_workouts=recent_workouts)


# ─── Utility ──────────────────────────────────────────────────────────────────

@app.route('/init-db')
def init_db_route():
    try:
        from src.models.database import init_database
        logs = init_database()
        return f"<h1>Database Initialization Report</h1><pre>{logs}</pre><p><a href='/'>Go Home</a></p>"
    except Exception as e:
        return f"<h1>Initialization Failed</h1><p>{e}</p>"


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
