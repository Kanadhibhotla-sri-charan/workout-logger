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

@app.route('/', methods=['GET', 'POST'])
def index():
    report = None
    display_exercises = None
    ai_analysis = None
    exercises_json = None
    
    if request.method == 'POST':
        raw_input = request.form.get('raw_input')
        date = request.form.get('date')
        
        # 1. AI Parse
        parsed_list = ai_parser.parse(raw_input)
        if not parsed_list:
             parsed_list = [{"name": e.strip()} for e in raw_input.split(",")]
             
        # 2. Match
        matched_exercises = []
        for item in parsed_list:
            if item.get('type') == 'cardio':
                # Direct pass-through for Cardio (no DB match needed)
                matched_exercises.append(item)
                continue
                
            clean_name = item.get('name') or "Unknown"
            match_result = matcher.match(clean_name)
            
            if match_result:
                final_obj = match_result
                final_obj['type'] = 'lift' # Ensure type is set
                if item.get('sets'): final_obj['sets'] = item['sets']
                if item.get('reps'): final_obj['reps'] = item['reps']
                if item.get('weight'): final_obj['weight'] = item['weight']
                matched_exercises.append(final_obj)
        
        # 3. Categorize
        ex_names = [m['name'] for m in matched_exercises]
        if ex_names:
            report = categorizer.categorize(ex_names)
            
            # 4. Prepare Display
            display_exercises = []
            for i, ex_info in enumerate(report['exercises']):
                match_info = matched_exercises[i]
                full_info = {**ex_info, **match_info}
                display_exercises.append(full_info)
                
            # 5. AI Analysis
            try:
                analyzer = AIAnalyzer()
                ai_analysis = analyzer.analyze(report)
            except:
                ai_analysis = "AI unavailable."
                
            exercises_json = json.dumps(matched_exercises)
            
            return render_template('index.html', 
                                   raw_input=raw_input,
                                   date=date,
                                   report=report, 
                                   display_exercises=display_exercises,
                                   ai_analysis=ai_analysis,
                                   exercises_json=exercises_json,
                                   today=date) # Keep same date
    
    return render_template('index.html', today=str(datetime.date.today()))

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
        l.workout_date,
        l.day_type,
        e.name as item_name,
        we.sets as col1,
        we.reps as col2,
        we.weight as col3,
        'lift' as type,
        NULL as duration,
        NULL as distance,
        NULL as speed
    FROM workout_logs l
    JOIN workout_exercises we ON l.id = we.workout_log_id
    JOIN exercises e ON we.exercise_id = e.id
    
    UNION ALL
    
    SELECT
        l.workout_date,
        l.day_type,
        cl.activity_name as item_name,
        NULL as col1,
        NULL as col2,
        NULL as col3,
        'cardio' as type,
        cl.duration,
        cl.distance,
        cl.speed
    FROM workout_logs l
    JOIN cardio_logs cl ON l.id = cl.workout_log_id

    ORDER BY workout_date DESC, item_name ASC
    LIMIT 100
    """
    cursor.execute(sql)
    rows = cursor.fetchall()
    conn.close()
    
    return render_template('report.html', rows=rows)

# --- DIET ROUTES ---

@app.route('/diet', methods=['GET', 'POST'])
def diet():
    today = str(datetime.date.today())
    history = get_diet_history()
    
    if request.method == 'POST':
        raw_input = request.form.get('raw_input')
        date = request.form.get('date')
        
        # 1. AI Parse
        preview_items = ai_diet.parse_diet(raw_input)
        
        # Calculate Totals
        total_cals = sum(i.get('calories',0) for i in preview_items)
        total_p = sum(i.get('protein',0) for i in preview_items)
        total_c = sum(i.get('carbs',0) for i in preview_items)
        total_f = sum(i.get('fats',0) for i in preview_items)
        
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
                               date=date, # Pass date for confirm
                               history=history)

    return render_template('diet.html', today=today, history=history)

@app.route('/confirm_diet', methods=['POST'])
def confirm_diet():
    date = request.form.get('date')
    items_json = request.form.get('items_json')
    items = json.loads(items_json)
    
    save_diet_logs(date, items)
    
    return redirect(url_for('diet'))

@app.route('/init-db')
def init_db_route():
    try:
        from src.models.database import init_database
        init_database()
        return "<h1>Database Initialized Successfully! 🚀</h1><p>You can now go back to <a href='/'>Home</a> and start logging.</p>"
    except Exception as e:
        return f"<h1>Initialization Failed</h1><p>{e}</p>"

if __name__ == '__main__':
    app.run(debug=True, port=5000)
