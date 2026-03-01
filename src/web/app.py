from flask import Flask, render_template, request, redirect, url_for
import datetime
import json
import sys
import os

# Add root folder to sys.path so we can import services
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../')))

from src.services.exercise_matcher import ExerciseMatcher
from src.services.ai_parser import AIParser
from src.services.categorizer import WorkoutCategorizer
from src.services.ai_analyzer import AIAnalyzer
from src.services.ai_diet import AIDietParser
from src.services.diet_service import save_diet_logs, get_diet_history
from src.services.workout_service import save_workout
from src.models.database import get_connection

app = Flask(__name__)

# Initialize Services
matcher = ExerciseMatcher()
ai_parser = AIParser()
categorizer = WorkoutCategorizer()
ai_diet = AIDietParser()


# ─── Helpers ─────────────────────────────────────────────────────────────────

def get_today_macros(date):
    """Returns sum of macros already logged for a given date."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT COALESCE(SUM(calories),0), COALESCE(SUM(protein),0),
               COALESCE(SUM(carbs),0), COALESCE(SUM(fats),0)
        FROM diet_logs WHERE log_date = ?
    """, (date,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return {'calories': int(row[0]), 'protein': int(row[1]),
                'carbs': int(row[2]), 'fats': int(row[3])}
    return {'calories': 0, 'protein': 0, 'carbs': 0, 'fats': 0}


def get_last_workout():
    """Returns the most recent workout log row."""
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


def _parse_and_match(raw_input):
    """Shared helper: AI-parse + fuzzy-match a raw workout string."""
    parsed_list = ai_parser.parse(raw_input)
    if not parsed_list:
        parsed_list = [{"name": e.strip()} for e in raw_input.split(",")]

    matched = []
    for item in parsed_list:
        if item.get('type') == 'cardio':
            matched.append(item)
            continue
        clean_name = item.get('name') or "Unknown"
        result = matcher.match(clean_name)
        if result:
            result['type'] = 'lift'
            if item.get('sets'):   result['sets']   = item['sets']
            if item.get('reps'):   result['reps']   = item['reps']
            if item.get('weight'): result['weight'] = item['weight']
            matched.append(result)
    return matched


# ─── Workout Routes ───────────────────────────────────────────────────────────

@app.route('/', methods=['GET', 'POST'])
def index():
    report = None
    display_exercises = None
    ai_analysis = None
    exercises_json = None
    last_workout = get_last_workout()

    if request.method == 'POST':
        raw_input = request.form.get('raw_input', '').strip()
        date = request.form.get('date')

        matched_exercises = _parse_and_match(raw_input)

        ex_names = [m['name'] for m in matched_exercises if m.get('type') != 'cardio']
        if ex_names:
            report = categorizer.categorize(ex_names)

            display_exercises = []
            for i, ex_info in enumerate(report['exercises']):
                match_info = matched_exercises[i]
                display_exercises.append({**ex_info, **match_info})

            try:
                analyzer = AIAnalyzer()
                ai_analysis = analyzer.analyze(report)
            except Exception:
                ai_analysis = "AI analysis unavailable."

            exercises_json = json.dumps(matched_exercises)

            return render_template('index.html',
                                   raw_input=raw_input,
                                   date=date,
                                   report=report,
                                   display_exercises=display_exercises,
                                   ai_analysis=ai_analysis,
                                   exercises_json=exercises_json,
                                   today=date,
                                   last_workout=last_workout)

    return render_template('index.html',
                           today=str(datetime.date.today()),
                           last_workout=last_workout)


@app.route('/quick_log', methods=['POST'])
def quick_log():
    """⚡ Direct save — skips the analysis/confirm step. Maximum speed."""
    raw_input = request.form.get('raw_input', '').strip()
    date = request.form.get('date', str(datetime.date.today()))

    if not raw_input:
        return redirect(url_for('index'))

    matched_exercises = _parse_and_match(raw_input)

    ex_names = [m['name'] for m in matched_exercises if m.get('type') != 'cardio']
    day_type = 'MIXED'
    if ex_names:
        try:
            report = categorizer.categorize(ex_names)
            day_type = report.get('day_type', 'MIXED')
        except Exception:
            pass

    if matched_exercises:
        save_workout(date, day_type, raw_input, matched_exercises)

    return redirect(url_for('report'))


@app.route('/confirm', methods=['POST'])
def confirm():
    date = request.form.get('date')
    day_type = request.form.get('day_type')
    raw_input = request.form.get('raw_input')
    exercises_json = request.form.get('exercises_json')

    exercises = json.loads(exercises_json)
    save_workout(date, day_type, raw_input, exercises)

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


# ─── Diet Routes ──────────────────────────────────────────────────────────────

@app.route('/diet', methods=['GET', 'POST'])
def diet():
    today = str(datetime.date.today())
    history = get_diet_history()
    today_macros = get_today_macros(today)

    if request.method == 'POST':
        raw_input = request.form.get('raw_input', '')
        date = request.form.get('date', today)

        preview_items = ai_diet.parse_diet(raw_input)

        total_cals = sum(i.get('calories', 0) for i in preview_items)
        total_p    = sum(i.get('protein',  0) for i in preview_items)
        total_c    = sum(i.get('carbs',    0) for i in preview_items)
        total_f    = sum(i.get('fats',     0) for i in preview_items)

        items_json = json.dumps(preview_items)

        return render_template('diet.html',
                               today=date,
                               raw_input=raw_input,
                               preview_items=preview_items,
                               items_json=items_json,
                               total_cals=total_cals,
                               total_p=total_p,
                               total_c=total_c,
                               total_f=total_f,
                               date=date,
                               history=history,
                               today_macros=today_macros)

    return render_template('diet.html', today=today, history=history, today_macros=today_macros)


@app.route('/confirm_diet', methods=['POST'])
def confirm_diet():
    date = request.form.get('date')
    items_json = request.form.get('items_json')
    items = json.loads(items_json)
    save_diet_logs(date, items)
    return redirect(url_for('diet'))


# ─── Dashboard Route ──────────────────────────────────────────────────────────

@app.route('/dashboard')
def dashboard():
    today = str(datetime.date.today())
    conn = get_connection()
    cursor = conn.cursor()

    # Today's workout session
    cursor.execute("""
        SELECT id, workout_date, day_type, exercises_raw
        FROM workout_logs
        WHERE workout_date = ?
        ORDER BY id DESC LIMIT 1
    """, (today,))
    today_workout = cursor.fetchone()

    # Exercises within today's workout
    today_exercises = []
    if today_workout:
        cursor.execute("""
            SELECT e.name, we.sets, we.reps, we.weight
            FROM workout_exercises we
            JOIN exercises e ON we.exercise_id = e.id
            WHERE we.workout_log_id = ?
        """, (today_workout[0],))
        today_exercises = cursor.fetchall()

    # Five most recent past workouts (for quick-repeat)
    cursor.execute("""
        SELECT id, workout_date, day_type, exercises_raw
        FROM workout_logs
        ORDER BY workout_date DESC, id DESC
        LIMIT 5
    """)
    recent_workouts = cursor.fetchall()

    conn.close()

    today_macros = get_today_macros(today)

    return render_template('dashboard.html',
                           today=today,
                           today_workout=today_workout,
                           today_exercises=today_exercises,
                           today_macros=today_macros,
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
