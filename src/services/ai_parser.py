"""
AI Parser Service.
Uses Gemini to extract structured data (Exercise, Sets, Reps, Weight) from natural language input.
"""
import google.generativeai as genai
import json

import os

# API Key (reused from analyzer)
API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyDaNrZJQIcnQr5H2xOprhn6NwpNNtr33fM")

class AIParser:
    def __init__(self):
        try:
            genai.configure(api_key=API_KEY)
            self.model = genai.GenerativeModel('gemini-2.5-flash')
            self.available = True
        except:
            self.available = False

    def parse(self, full_text):
        """
        Input: "bench 3 sets 100, 110, 120 | squats 5x5"
        Output: LIST of Dictionaries [{name, sets, reps, weight}, ...]
        """
        if not self.available:
            return []

        prompt = f"""
        Extract a list of activities from this workout log: "{full_text}"
        
        Return ONLY a JSON LIST of objects. 
        Determine if each item is a LIFT (weights) or CARDIO.

        For LIFT (Weights/Bodyweight):
        - type: "lift"
        - name: Exercise name (e.g., "Bench Press")
        - sets: (int/null)
        - reps: (string/null)
        - weight: (string/null)

        For CARDIO (Running, Cycling, Treadmill, Crossfit, etc.):
        - type: "cardio"
        - name: Activity name (e.g., "Treadmill Run", "Cycling")
        - duration: Duration string (e.g., "30 mins")
        - distance: Distance string (e.g., "5km")
        - speed: Speed string (e.g., "10km/h") or null

        Example Input: "Bench 3x10 100kg, then ran 5km on treadmill in 25 mins"
        Example Output: [
            {{"type": "lift", "name": "Bench", "sets": 3, "reps": "10", "weight": "100kg"}},
            {{"type": "cardio", "name": "Treadmill Run", "duration": "25 mins", "distance": "5km", "speed": null}}
        ]
        """
        
        try:
            response = self.model.generate_content(prompt)
            # Clean response (remove markdown code blocks if any)
            text = response.text.replace("```json", "").replace("```", "").strip()
            # Ensure it is a list
            data = json.loads(text)
            if isinstance(data, dict): data = [data]
            return data
        except Exception as e:
            print(f"[WARN] AI Parse failed: {e}")
            return []

if __name__ == "__main__":
    parser = AIParser()
    print(parser.parse("bench press 3 sets of 10 with 100, 110, 120kg"))
