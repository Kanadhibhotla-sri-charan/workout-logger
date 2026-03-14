"""
AI Diet Service using Claude API (Anthropic).
Estimates nutrition (calories/macros) from natural language text.
"""
import os
import json
import anthropic

API_KEY = os.getenv("ANTHROPIC_API_KEY")

SYSTEM_PROMPT = """You are a precise nutrition analyst specialising in Indian food.

Container reference: The user uses a "Magnus" container that holds exactly 450ml.
- "1 cup" / "1 container" = 450ml
- "1/2 cup" = 225ml, "1/4 cup" = ~112ml, "1/3 cup" = 150ml

Indian food calorie benchmarks (use these as anchors):
- Cooked rice: ~130 kcal per 100g (1/4 cup cooked ≈ 50g ≈ 65 kcal)
- Chapati (medium, ~30g): ~100 kcal each
- Dal (cooked, per 100ml): ~60 kcal
- Rasam (per 100ml): ~20 kcal
- Curd/yoghurt (per 100ml): ~60 kcal
- Raw banana curry (per 100g): ~70-80 kcal
- Egg curry (2 eggs + gravy): ~220-260 kcal
- Peanut butter oats (dry, per 30g): ~120-130 kcal
- Whey protein scoop (user says 130kcal/24g protein): use exactly those values
- Coconut water (250ml): ~50 kcal
- Banana (medium): ~90 kcal
- Dates (each): ~23 kcal
- Sprouts masala (cooked, per 100g): ~100-120 kcal
- Jaggery coffee (50ml, ~1 tsp jaggery + milk): ~40-50 kcal
- Full-fat milk (per 100ml): ~65 kcal

When the user describes mixed rice dishes like "1/3 cup rasam rice after mixing" —
that means the cooked rice + the accompaniment are mixed together and fill 1/3 of a
450ml container (~150ml total), so estimate accordingly.

Always err on the side of being slightly higher rather than lower for dense foods.
"""


class AIDietParser:
    def __init__(self):
        if not API_KEY:
            self.client = None
        else:
            self.client = anthropic.Anthropic(api_key=API_KEY)

    def parse_diet(self, full_text):
        """
        Input:  "Bf - 2 eggs. Lunch - Rice and dal."
        Output: List of dicts:
                [{"meal_type": "Breakfast", "food_raw": "2 eggs",
                  "calories": 140, "protein": 12, "carbs": 1, "fats": 10}, ...]
        """
        if not self.client:
            return []

        prompt = f"""Analyze this food log and return a JSON list of meal entries.

Food log: "{full_text}"

Rules:
1. Split into separate entries per meal (Breakfast / Lunch / Dinner / Snack /
   Pre-Workout / Post-Workout). Detect from keywords like "Bf", "Eve", "PW", etc.
   Default to "Snack" if unknown.
2. For each entry estimate calories, protein (g), carbs (g), fats (g).
3. If the user states exact nutrition (e.g. "130kcal 24g protein whey"), use those
   exact numbers — do not recalculate.
4. Return ONLY a JSON array, no markdown fences, no extra text.

Format:
[
  {{
    "meal_type": "Breakfast",
    "food_raw": "description as entered",
    "calories": 467,
    "protein": 36.1,
    "carbs": 50.4,
    "fats": 13.6
  }}
]"""

        try:
            response = self.client.messages.create(
                model="claude-opus-4-6",
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}]
            )
            text = response.content[0].text.strip()
            # Strip markdown fences if model adds them anyway
            text = text.replace("```json", "").replace("```", "").strip()
            data = json.loads(text)
            if isinstance(data, dict):
                data = [data]
            return data
        except Exception as e:
            print(f"[WARN] AI Diet Parse failed: {e}")
            return []
