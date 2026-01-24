"""
Main Entry Point for Smart Workout Logger.
"""
import sys
import os
sys.path.append(os.getcwd())
import argparse
import datetime
import json
from src.services.exercise_matcher import ExerciseMatcher
from src.services.categorizer import WorkoutCategorizer
from src.models.database import get_connection

def main():
    parser = argparse.ArgumentParser(description="Smart Workout Logger")
    parser.add_argument("command", choices=["log", "history", "report"], help="Command to run")
    parser.add_argument("--date", help="Date of workout (YYYY-MM-DD)", default=str(datetime.date.today()))
    
    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(1)
        
    args = parser.parse_args()
    
    if args.command == "log":
        do_log_workout(args.date)
    elif args.command == "history":
        do_show_history()
    elif args.command == "report":
        do_show_report()

def do_show_report():
    conn = get_connection()
    cursor = conn.cursor()
    
    sql = """
    SELECT 
        l.workout_date,
        l.day_type,
        e.name,
        we.sets,
        we.reps,
        we.weight
    FROM workout_logs l
    JOIN workout_exercises we ON l.id = we.workout_log_id
    JOIN exercises e ON we.exercise_id = e.id
    ORDER BY l.workout_date DESC, l.id DESC
    LIMIT 50
    """
    
    cursor.execute(sql)
    rows = cursor.fetchall()
    
    print("\n[REPORT] Detailed Workout Log")
    print("=" * 100)
    # Header format
    # Date (12) | Type (6) | Exercise (30) | Sets (5) | Reps (6) | Weight (25)
    header = f"{'Date':<12} | {'Type':<6} | {'Exercise':<30} | {'Sets':<5} | {'Reps':<6} | {'Weight'}"
    print(header)
    print("-" * 100)
    
    for r in rows:
        date, dtype, name, sets, reps, weight = r
        # Handle None values safely
        sets_str = str(sets) if sets else "-"
        reps_str = str(reps) if reps else "-"
        weight_str = str(weight) if weight else "-"
        
        line = f"{date:<12} | {dtype:<6} | {name:<30} | {sets_str:<5} | {reps_str:<6} | {weight_str}"
        print(line)
        
    conn.close()

def do_log_workout(date_str):
    print(f"\n[LOG] LOG WORKOUT FOR: {date_str}")
    print("Enter exercises separated by commas (e.g., 'bench, squat 3x10 100kg')")
    user_input = input("> ")
    
    if not user_input.strip():
        print("Empty input. Exiting.")
        return

    # 1. AI Parsing (Full Text)
    from src.services.exercise_matcher import ExerciseMatcher
    from src.services.ai_parser import AIParser
    
    matcher = ExerciseMatcher()
    ai_parser = AIParser()
    matched_exercises = []
    
    print("\n[ANALYZING] Processing with AI...")
    
    # Send the WHOLE string to Gemini
    parsed_list = ai_parser.parse(user_input)
    
    # Fallback if AI fails: Try old comma splitting
    if not parsed_list:
        parsed_list = [{"name": e.strip()} for e in user_input.split(",")]

    # 2. Match Logic
    for item in parsed_list:
        clean_name = item.get('name') or "Unknown"
        
        # Database Matching
        match_result = matcher.match(clean_name) 
        
        if match_result:
            # Merge AI details with DB Match
            final_obj = match_result
            if item.get('sets'): final_obj['sets'] = item['sets']
            if item.get('reps'): final_obj['reps'] = item['reps']
            if item.get('weight'): final_obj['weight'] = item['weight']
            
            matched_exercises.append(final_obj)
        else:
            print(f"  [WARN] Could not identify exercise: '{clean_name}'")
            
    if not matched_exercises:
        print("No valid exercises found. Nothing to save.")
        return

    # 3. Categorize
    # Extract names for categorizer
    ex_names = [m['name'] for m in matched_exercises]
    
    categorizer = WorkoutCategorizer()
    report = categorizer.categorize(ex_names)
    
    # 4. Display Report (Matched with details)
    print(f"\n[SUMMARY] {report['day_type']} DAY")
    print("-" * 40)
    
    # Merge categorizer info with matcher info (sets/reps)
    final_exercises_to_save = []
    
    for i, ex_info in enumerate(report['exercises']):
        match_info = matched_exercises[i]
        full_info = {**ex_info, **match_info}
        final_exercises_to_save.append(full_info)
        
        detail_str = ""
        if full_info.get('sets'):
            detail_str = f"({full_info.get('sets')}x{full_info.get('reps','?')} {full_info.get('weight') or ''})"
            
        print(f" • {full_info['name']:<25} {detail_str:<15} [{full_info['muscle']}]")
        
    # 5. Get AI Analysis
    print("\n[AI ANALYZING] Generating insights...")
    try:
        from src.services.ai_analyzer import AIAnalyzer
        analyzer = AIAnalyzer()
        analysis = analyzer.analyze(report)
        print("\n[AI COACH] AI COACH SAYS:")
        print("-" * 40)
        print(analysis)
        print("-" * 40)
    except Exception as e:
        print(f"[WARN] AI Analysis failed: {e}")

    # 6. Save to DB
    confirm = input("\n[SAVE] Save this workout? (y/n): ")
    if confirm.lower() == 'y':
        from src.services.workout_service import save_workout
        save_workout(date_str, report['day_type'], user_input, matched_exercises)
        print("[OK] Saved successfully!")
    else:
        print("[CANCEL] Discarded.")

# save_workout function removed (moved to services)

def do_show_history():
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id, workout_date, day_type, exercises_raw FROM workout_logs ORDER BY workout_date DESC LIMIT 5")
    rows = cursor.fetchall()
    
    print("\n[HISTORY] RECENT HISTORY")
    print("-" * 50)
    for row in rows:
        wid, date, dtype, raw = row
        print(f"[{date}] {dtype} DAY")
        print(f"  {raw[:50]}...")
        print("")
        
    conn.close()

if __name__ == "__main__":
    main()
