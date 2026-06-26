from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "community.db"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "").strip()


def database_engine() -> str:
    value = database_url().lower()
    if value.startswith(("mysql://", "mysql+pymysql://")):
        return "mysql"
    return "sqlite"


def translate_sql_for_mysql(sql: str) -> str:
    translated = re.sub(r"\binsert\s+or\s+ignore\s+into\b", "insert ignore into", sql, flags=re.IGNORECASE)
    translated = re.sub(r"\binsert\s+or\s+replace\s+into\b", "replace into", translated, flags=re.IGNORECASE)
    translated = re.sub(
        r"\bon\s+conflict\s*\([^)]+\)\s+do\s+update\s+set\b",
        "on duplicate key update",
        translated,
        flags=re.IGNORECASE,
    )
    translated = re.sub(r"excluded\.([A-Za-z_][A-Za-z0-9_]*)", r"values(\1)", translated)
    return translated.replace("?", "%s")


class MySQLCursorResult:
    def __init__(self, cursor: Any):
        self.cursor = cursor

    def fetchone(self) -> dict[str, Any] | None:
        return self.cursor.fetchone()

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self.cursor.fetchall())


class MySQLConnection:
    def __init__(self, url: str):
        import pymysql

        parsed = urlparse(url.replace("mysql+pymysql://", "mysql://", 1))
        self.connection = pymysql.connect(
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 3306,
            user=unquote(parsed.username or ""),
            password=unquote(parsed.password or ""),
            database=(parsed.path or "/").lstrip("/"),
            charset="utf8mb4",
            autocommit=False,
            cursorclass=pymysql.cursors.DictCursor,
        )

    def execute(self, sql: str, params: Any = ()) -> MySQLCursorResult:
        cursor = self.connection.cursor()
        cursor.execute(translate_sql_for_mysql(sql), params or ())
        return MySQLCursorResult(cursor)

    def executescript(self, script: str) -> None:
        for statement in [part.strip() for part in script.split(";") if part.strip()]:
            self.execute(statement)

    def __enter__(self) -> MySQLConnection:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc_type:
            self.connection.rollback()
        else:
            self.connection.commit()
        self.connection.close()


def db() -> sqlite3.Connection | MySQLConnection:
    DATA_DIR.mkdir(exist_ok=True)
    if database_engine() == "mysql":
        return MySQLConnection(database_url())
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def database_health_info() -> dict[str, str]:
    if database_engine() == "mysql":
        return {"databaseEngine": "mysql", "database": "rds-mysql"}
    return {"databaseEngine": "sqlite", "database": str(DB_PATH)}
