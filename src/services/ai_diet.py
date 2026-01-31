"""
AI Diet Service using Google Gemini API.
Estimates nutrition (calories/macros) from natural language text.
"""
import os
import json
import google.generativeai as genai

# API Key (reused)
API_KEY = os.getenv("GEMINI_API_KEY")

class AIDietParser:
    def __init__(self):
        try:
            if not API_KEY:
                self.available = False
                return

            genai.configure(api_key=API_KEY)
            self.model = genai.GenerativeModel('gemini-2.5-flash')
            self.available = True
        except:
            self.available = False

    def parse_diet(self, full_text):
        """
        Input: "Bf - 2 eggs. Lunch - Rice."
        Output: List of dicts: [
            {
                "meal_type": "Breakfast", 
                "food_raw": "2 eggs", 
                "calories": 140, "protein": 12, "carbs": 1, "fats": 10
            }, ...
        ]
        """
        if not self.available:
            return []

        prompt = f"""
        [IMPORTANT CONTEXT]
        The user measures food using a specific "Magnus" container which is **450ml**.
        - If the user says "cup", "container", "box", or "this one", they mean this **450ml** volume.
        - Example: "Half cup of Upma" = 225ml of Upma.
        - Example: "1 container of Rice" = 450ml of Rice.
        - Please estimate calories/macros based on this specific volume.

        Analyze this food log: "{full_text}"

        1. Split into separate meal entries if multiple are listed.
        2. Detect meal type (Breakfast/Lunch/Dinner/Snack) from keywords like "Bf", "Eve", etc. Default to "Snack" if unknown.
        3. Estimate calories and macros (Protein/Carbs/Fats) for each item.
        
        Return ONLY a JSON LIST of objects. Format:
        [
            {{
                "meal_type": "Breakfast",
                "food_raw": "2 eggs and toast",
                "calories": 250,
                "protein": 14,
                "carbs": 30,
                "fats": 10
            }}
        ]
        """
        
        try:
            response = self.model.generate_content(prompt)
            text = response.text.replace("```json", "").replace("```", "").strip()
            data = json.loads(text)
            if isinstance(data, dict): data = [data]
            return data
        except Exception as e:
            print(f"[WARN] AI Diet Parse failed: {e}")
            return []
