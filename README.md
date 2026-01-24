# 🏋️ Smart Workout Logger & Analyzer

A smart CLI tool to log your workouts, automatically organize them by muscle group (Push/Pull/Legs), and get AI-powered fitness advice.

## 🚀 How to Run

### 1. Open Terminal
Open a terminal in the project folder: `D:\workout-logger`

### 2. Activate Virtual Environment
```powershell
.\venv\Scripts\Activate
```

### 3. Log a Workout
Run the logger:
```powershell
python src\main.py log
```

When prompted, type your exercises separated by commas.
**Example:**
```text
> bench, inc db, flys, lateral raise, skull crushers
```

**What happens:**
1. System identifies exercises (e.g. "inc db" -> **Incline Dumbbell Press**)
2. Detects workout type (e.g., **PUSH DAY**)
3. **AI Coach** analyzes your session and suggests improvements
4. Saves to database

### 4. View Reports (New! 📊)
See a detailed table of all your exercises, sets, and weights:
```powershell
.\run.bat report
```

### 5. View History
See your past raw logs:
```powershell
.\run.bat history
```

## 🛠️ Setup (One-time)
If you moved the folder or need to reinstall:
```powershell
# Create venv
python -m venv venv

# Install dependencies
.\venv\Scripts\pip install -r requirements.txt

# Initialize Database
python src\models\database.py

# Load Exercises
python src\services\data_loader.py
```

## 🧠 Features
- **Fuzzy Matching**: Understands `lat raise`, `bb row`, `squats`
- **Auto-Categorization**: Knows if it's Push, Pull, or Legs day
- **AI Analysis**: Uses Gemini 2.5 Flash to critique volume and selection
- **Muscle Tracking**: Tracks primary and secondary muscles hit
