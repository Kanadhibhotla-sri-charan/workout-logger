import sys
import os
import json

# Add root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../')))

from src.services.ai_parser import AIParser
from src.services.exercise_matcher import ExerciseMatcher

input_text = """
Barbell rowing - 3 sets: 35kgs,45kgs,45kgs
Assisted pull ups with body weight (with stretching band)
Machine seated row with neutral grip - 3sets: 35kgs,40kgs,45kgs
Reverse pec deck flies 15kgs,20kgs,25kgs
Incline dumbbell curls - 3 sets: 5kgs,5kgs,7.5kbargs
Preacher curls - 2sets: 10kgs curl bar, 10kg curl 
"""

def test():
    print("--- 1. Testing AI Parser ---")
    parser = AIParser()
    try:
        parsed = parser.parse(input_text)
        print(json.dumps(parsed, indent=2))
    except Exception as e:
        print(f"Parser Error: {e}")
        return

    print("\n--- 2. Testing Matcher ---")
    matcher = ExerciseMatcher()
    
    for item in parsed:
        name = item.get('name')
        print(f"Matching '{name}'...")
        match = matcher.match(name)
        if match:
            print(f"  -> FOUND: {match['name']} (ID: {match.get('id')})")
        else:
            print(f"  -> NOT FOUND")

if __name__ == "__main__":
    test()
