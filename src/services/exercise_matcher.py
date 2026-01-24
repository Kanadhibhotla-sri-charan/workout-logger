"""
Exercise matching service using fuzzy string matching.
Handles abbreviations, typos, and exact matches.
"""
import json
import sqlite3
from pathlib import Path
from rapidfuzz import process, fuzz

DB_PATH = Path(__file__).parent.parent.parent / "workout_logger.db"

class ExerciseMatcher:
    def __init__(self):
        self.exercises = []  # List of exercise names
        self.aliases = {}    # string alias -> real name
        self.load_exercises()
        
    def load_exercises(self):
        """Load all exercises and aliases from DB into memory for fast matching."""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Get all exercises with their aliases
        cursor.execute("SELECT name, aliases FROM exercises")
        rows = cursor.fetchall()
        
        self.exercises = []
        self.aliases = {}
        
        for name, aliases_json in rows:
            self.exercises.append(name)
            
            # Map aliases to the real name
            if aliases_json:
                try:
                    alias_list = json.loads(aliases_json)
                    for alias in alias_list:
                        self.aliases[alias.lower()] = name
                except:
                    pass
                    
        conn.close()

    def match(self, user_input, threshold=60):
        """
        Find best matching exercise.
        Returns: {name: "Name", score: 90} or None
        """
        clean_input = user_input.strip().lower()
        
        # 1. Check exact alias match (fastest)
        final_name = None
        final_score = 0
        
        if clean_input in self.aliases:
            final_name = self.aliases[clean_input]
            final_score = 100
        else:
            # Fuzzy match against real names AND aliases
            all_choices = list(self.aliases.keys()) + [e.lower() for e in self.exercises]
            
            # Use token_set_ratio to handle "row with grip" vs "row"
            result = process.extractOne(clean_input, all_choices, scorer=fuzz.token_set_ratio)
            
            if result:
                match_text, score, _ = result
                
                if score >= threshold:
                    final_name = self.aliases.get(match_text, match_text)
                    
                    if match_text not in self.aliases:
                        for original in self.exercises:
                            if original.lower() == match_text:
                                final_name = original
                                break
                    final_score = score
                    
        if final_name:
            # Return dict format as expected by new main.py
            return {
                "name": final_name,
                "score": final_score
            }
                
        return None
