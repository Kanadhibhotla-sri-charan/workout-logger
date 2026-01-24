# How to Deploy Smart Workout Logger to the Web 🌐

This guide will help you host your workout logger on **Render.com** (Free Tier) so you can access it from your phone!

## Prerequisites
1. A **GitHub** account.
2. A **Render.com** account.

---

## Step 1: Upload Code to GitHub ☁️

1. **Create a New Repo** on GitHub (e.g., `workout-logger`).
2. Open a terminal in your project folder (`D:\workout-logger`).
3. Run these commands:
   ```powershell
   git init
   git add .
   git commit -m "Deployment Ready"
   git branch -M main
   # Replace with your actual GitHub URL
   git remote add origin https://github.com/YOUR_USER/workout-logger.git
   git push -u origin main
   ```

---

## Step 2: Create Web Service on Render 🚀

1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **"New +"** -> **"Web Service"**.
3. Connect your GitHub repository.
4. **Configure Settings**:
   *   **Name**: `my-workout-logger` (or whatever you want)
   *   **Runtime**: `Python 3`
   *   **Build Command**: `pip install -r requirements.txt`
   *   **Start Command**: `gunicorn src.web.app:app`
   *   **Instance Type**: `Free`

5. **Environment Variables** (Scroll down to "Advanced"):
   Click "Add Environment Variable" for each:

   | Key | Value |
   |-----|-------|
   | `PYTHON_VERSION` | `3.10.0` |
   | `GEMINI_API_KEY` | `Your_Gemini_Key_Here` |
   | `DATABASE_URL` | *(See Step 3)* |

---

## Step 3: Database Setup 🗄️

Since the Free Tier resets files every day, you need a **PostgreSQL Database** to keep your logs persistent.

1. On Render Dashboard, click **"New +"** -> **"PostgreSQL"**.
2. **Name**: `workout-db`.
3. **Plan**: `Free`.
4. Click **Create Database**.
5. Once created, copy the **"Internal Database URL"** (starts with `postgres://...`).
6. Go back to your Web Service -> **Environment** -> **Add/Edit Variable**.
7. Add `DATABASE_URL` and paste the value.

### ⚠️ IMPORTANT: Initializing the Database
Since this is a fresh database, it will be empty. The app attempts to create tables automatically, but if it fails:

1. Copy the **entire content** of the file `sql/schema.sql` from your project.
2. Go to your Render Database dashboard.
3. Click the **"Connect"** dropdown -> Select **"External Connection"** or use the **"SQL"** tab if available.
4. Paste and run the SQL commands to create the tables (`workout_logs`, `cardio_logs`, `diet_logs`, etc.).

> **Note**: We updated the schema to use `TEXT` for sets/reps/weight to allow flexible AI input (e.g. ranges, lists). This ensures compatibility with PostgreSQL.

---

## Step 4: Finish & Party 🎉

1. Click **"Deploy Web Service"**.
2. Wait ~2-3 minutes.
3. You will get a URL like `https://my-workout-logger.onrender.com`.
4. Open it on your phone and start logging!
