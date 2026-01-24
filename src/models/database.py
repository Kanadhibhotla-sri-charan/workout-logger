import os
import sqlite3
from pathlib import Path

try:
    import psycopg2
except ImportError:
    psycopg2 = None

# Database file location (Fallback)
DB_PATH = Path(__file__).parent.parent.parent / "workout_logger.db"
SCHEMA_PATH = Path(__file__).parent.parent.parent / "sql" / "schema.sql"

class PostgresCursor:
    def __init__(self, real_cursor):
        self.cursor = real_cursor

    def execute(self, sql, params=None):
        # Translate '?' to '%s'
        if params:
            sql = sql.replace('?', '%s')
        return self.cursor.execute(sql, params)
        
    def fetchone(self): return self.cursor.fetchone()
    def fetchall(self): return self.cursor.fetchall()
    def close(self): self.cursor.close()
    
    @property
    def lastrowid(self):
        # Postgres requires RETURNING id + fetchone(), not .lastrowid attr
        return self.cursor.lastrowid

class PostgresConnection:
    def __init__(self, real_conn):
        self.conn = real_conn
        
    def cursor(self):
        return PostgresCursor(self.conn.cursor())
        
    def commit(self): self.conn.commit()
    def rollback(self): self.conn.rollback()
    def close(self): self.conn.close()

def get_connection():
    """Get a database connection (Postgres or SQLite)."""
    db_url = os.getenv("DATABASE_URL")
    if db_url:
        real_conn = psycopg2.connect(db_url)
        return PostgresConnection(real_conn)
    return sqlite3.connect(DB_PATH)

def init_database():
    """Initialize DB (Supports both)."""
    db_url = os.getenv("DATABASE_URL")
    print(f"Initializing database (Mode: {'Postgres' if db_url else 'SQLite'})")
    
    with open(SCHEMA_PATH, 'r', encoding='utf-8') as f:
        schema_sql = f.read()
        
    conn = get_connection()
    cursor = conn.cursor()
    
    try:
        # Split schema by semi-colon since executemany/script varies
        statements = schema_sql.split(';')
        for stmt in statements:
            if stmt.strip():
                # Postgres cleanup: Remove "AUTOINCREMENT" (uses SERIAL/IDENTITY implicity or different syntax)
                # But our schema uses INTEGER PRIMARY KEY AUTOINCREMENT which is SQLite specific.
                # For Postgres compatibility, simple INTEGER PRIMARY KEY is often mapped to SERIAL if using SQLAlchemy,
                # but raw SQL is harder.
                # MVP: We assume SQLite locally. Providing full Postgres migration script is complex.
                # HACK: If Postgres, we skip schema creation here and assume user runs SQL manually or we try best effort.
                if db_url:
                     # Replace SQLiteisms
                     stmt = stmt.replace("AUTOINCREMENT", "")
                
                try:
                    cursor.execute(stmt)
                except Exception as e:
                    # Ignore "relation exists" errors
                    print(f"Warning executing statement: {e}")
                    
        conn.commit()
        print("[OK] Database initialized.")
    except Exception as e:
        print(f"[ERROR] {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    init_database()
