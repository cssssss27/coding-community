from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from database import database_engine, db  # noqa: E402


TABLES = [
    "users",
    "user_profiles",
    "works",
    "work_engagements",
    "sessions",
    "admin_sessions",
    "settings",
    "api_configs",
    "points_records",
]


def read_sqlite_counts(path: Path, tables: list[str]) -> dict[str, int]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return {
            table: int(conn.execute(f"select count(*) as n from {table}").fetchone()["n"])
            if sqlite_table_exists(conn, table)
            else 0
            for table in tables
        }
    finally:
        conn.close()


def sqlite_table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "select name from sqlite_master where type = 'table' and name = ?",
        (table,),
    ).fetchone() is not None


def sqlite_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row["name"] for row in conn.execute(f"pragma table_info({table})").fetchall()]


def mysql_table_count(conn: Any, table: str) -> int:
    return int(conn.execute(f"select count(*) as n from {table}").fetchone()["n"])


def migrate(sqlite_path: Path, replace: bool = False) -> dict[str, dict[str, int]]:
    if database_engine() != "mysql":
        raise RuntimeError("DATABASE_URL must point to MySQL before running migration")
    if not sqlite_path.exists():
        raise FileNotFoundError(sqlite_path)

    server.init_db()
    source = sqlite3.connect(sqlite_path)
    source.row_factory = sqlite3.Row
    report: dict[str, dict[str, int]] = {}
    try:
        with db() as target:
            for table in TABLES:
                before = mysql_table_count(target, table)
                if before and not replace:
                    raise RuntimeError(f"target table {table} is not empty; rerun with --replace to overwrite")
            if replace:
                for table in reversed(TABLES):
                    target.execute(f"delete from {table}")
            for table in TABLES:
                if not sqlite_table_exists(source, table):
                    report[table] = {"source": 0, "target": mysql_table_count(target, table)}
                    continue
                columns = sqlite_columns(source, table)
                placeholders = ", ".join(["?"] * len(columns))
                names = ", ".join(columns)
                rows = source.execute(f"select {names} from {table}").fetchall()
                for row in rows:
                    target.execute(
                        f"insert into {table}({names}) values({placeholders})",
                        tuple(row[column] for column in columns),
                    )
                report[table] = {"source": len(rows), "target": mysql_table_count(target, table)}
    finally:
        source.close()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate Coding community SQLite data into MySQL.")
    parser.add_argument("--sqlite", required=True, help="Path to source community.db")
    parser.add_argument("--replace", action="store_true", help="Delete target table rows before import")
    args = parser.parse_args()
    report = migrate(Path(args.sqlite), replace=args.replace)
    for table, counts in report.items():
        print(f"{table}: source={counts['source']} target={counts['target']}")
        if counts["source"] != counts["target"]:
            raise RuntimeError(f"row count mismatch for {table}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
