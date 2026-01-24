"""
AI Analysis Service using Google Gemini API.
Analyzes workout patterns and suggests improvements.
"""
import os
import google.generativeai as genai
from collections import Counter

# Set API Key (Prioritize Env Var for Production)
API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyDaNrZJQIcnQr5H2xOprhn6NwpNNtr33fM")

class AIAnalyzer:
    def __init__(self):
        try:
            genai.configure(api_key=API_KEY)
            # Use 'gemini-2.5-flash' model (as found in list)
            self.model = genai.GenerativeModel('gemini-2.5-flash')
            self.available = True
        except Exception as e:
            print(f"[WARN] AI Init failed: {e}")
            self.available = False

    def analyze(self, workout_report):
        """
        Input: Report dictionary from Categorizer
        Output: AI Analysis string
        """
        if not self.available:
            return "AI Analysis unavailable (API connection failed)."

        # 1. Construct Prompt
        exercises_text = "\n".join([
            f"- {ex['name']} (Target: {ex['muscle']})" 
            for ex in workout_report['exercises']
        ])
        
        prompt = f"""
        Act as an elite strength and conditioning coach.
        Analyze this {workout_report['day_type']} workout session:

        EXERCISES PERFORMED:
        {exercises_text}

        MUSCLE GROUP VOLUME:
        {dict(workout_report['muscle_counts'])}

        Provide a brief, bulleted critique (max 3-4 points):
        1. Identify any MAJOR missing muscle groups for this specific day type (e.g., if Push day, did they miss rear delts or a specific tricep head?).
        2. Identify any redundancy (too many exercises for same muscle).
        3. One actionable tip to improve this specific session.
        
        Keep it concise and encouraging. No formatting, just specific advice.
        """

        try:
            # 2. Get Response
            response = self.model.generate_content(prompt)
            return response.text.strip()
        except Exception as e:
            return f"Error analyzing workout: {e}"

# Test Logic
if __name__ == "__main__":
    # Test with a partial Push day (Missing Rear Delts & Triceps)
    test_report = {
        "day_type": "PUSH",
        "muscle_counts": {"Chest": 3, "Shoulders": 1},
        "exercises": [
            {"name": "Barbell Bench Press", "muscle": "Mid Pecs"},
            {"name": "Incline Dumbbell Press", "muscle": "Upper Pecs"},
            {"name": "Cable Fly", "muscle": "Inner Pecs"},
            {"name": "Overhead Press", "muscle": "Front Delts"}
        ]
    }
    
    analyzer = AIAnalyzer()
    print("[ANALYZING] Asking Gemini...")
    print("-" * 40)
    print(analyzer.analyze(test_report))
