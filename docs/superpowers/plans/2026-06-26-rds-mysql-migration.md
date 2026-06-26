# RDS MySQL Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Coding社区 from SQLite-only production storage to an RDS MySQL 8.0 Serverless-compatible backend while keeping SQLite available for local development and rollback.

**Architecture:** Add a small database adapter that preserves the current `with db() as conn: conn.execute(...)` call shape, then branch schema initialization by database engine. Add one migration script that copies the production SQLite database into MySQL and verifies row counts. Seed the DeepSeek API config from environment variables during startup so deployments can inject the key without storing it in code.

**Tech Stack:** FastAPI, SQLite, PyMySQL, Alibaba Cloud RDS MySQL 8.0 Serverless, pytest/unittest, PowerShell deployment commands.

---

## Scope

This plan implements the first migration phase only:

- Keep frontend routes and API response contracts stable.
- Keep user-uploaded files on local disk during the database cutover.
- Add MySQL support and keep SQLite as the default when `DATABASE_URL` is absent.
- Add deployment-time DeepSeek API key seeding from `DEEPSEEK_API_KEY`.
- Add a SQLite-to-MySQL data migration script and validation commands.

OSS upload/storage changes are intentionally excluded from this phase and should be handled in a second plan after the RDS cutover is stable.

## File Structure

- Create `database.py`: database engine detection, SQLite connection, MySQL connection wrapper, SQL translation helpers, and sanitized health metadata.
- Modify `server.py`: import the adapter, use `db()`, branch schema initialization, add DeepSeek env seeding, and expose a safe database engine field in `/api/health`.
- Modify `requirements.txt`: add `PyMySQL`.
- Create `scripts/migrate_sqlite_to_mysql.py`: copy all current tables from a SQLite file to MySQL using `DATABASE_URL`.
- Create `tests/test_database_adapter.py`: verify SQL translation, engine detection, and MySQL wrapper behavior without requiring a live RDS instance.
- Create `tests/test_deepseek_env_seed.py`: verify `DEEPSEEK_API_KEY` updates `api_configs` during `init_db()`.
- Create `tests/test_migration_script.py`: verify migration script behavior using a temporary SQLite source and a fake target adapter where possible.
- Modify `DEPLOY.md`: document RDS environment variables, migration commands, DeepSeek key seeding, verification, and rollback.

Because `C:\Users\admin\Desktop\Coding社区` is not a git repository, each task includes a verification step instead of a commit step. If git is initialized before execution, replace each verification-only checkpoint with a normal commit.

---

### Task 1: Baseline Verification And Local Snapshot

**Files:**
- Read: `server.py`
- Read: `requirements.txt`
- Read: `tests/*.py`
- Create: `__snapshots__/pre-rds-mysql-migration/`

- [ ] **Step 1: Run current tests before editing**

Run:

```powershell
python -m pytest tests -q
```

Expected: tests either pass, or failures are recorded before changing code. If `pytest` is not installed, run:

```powershell
python -m unittest discover -s tests -p "test_*.py"
```

Expected: current test suite result is known before implementation starts.

- [ ] **Step 2: Create a local file snapshot**

Run:

```powershell
New-Item -ItemType Directory -Force -Path "__snapshots__/pre-rds-mysql-migration" | Out-Null
Copy-Item server.py "__snapshots__/pre-rds-mysql-migration/server.py"
Copy-Item requirements.txt "__snapshots__/pre-rds-mysql-migration/requirements.txt"
Copy-Item DEPLOY.md "__snapshots__/pre-rds-mysql-migration/DEPLOY.md"
Copy-Item data/community.db "__snapshots__/pre-rds-mysql-migration/community.db"
```

Expected: snapshot files exist and no project file has been modified yet.

---

### Task 2: Add Database Adapter

**Files:**
- Create: `database.py`
- Create: `tests/test_database_adapter.py`
- Modify: `requirements.txt`

- [ ] **Step 1: Write adapter tests**

Create `tests/test_database_adapter.py` with tests for engine detection, placeholder translation, upsert translation, and sanitized health info:

```python
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

import database


class DatabaseAdapterTests(unittest.TestCase):
    def test_engine_defaults_to_sqlite_without_database_url(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(database.database_engine(), "sqlite")

    def test_engine_detects_mysql_database_url(self) -> None:
        with patch.dict(os.environ, {"DATABASE_URL": "mysql://user:secret@example.com:3306/coding_community"}):
            self.assertEqual(database.database_engine(), "mysql")

    def test_translate_sqlite_placeholders_to_mysql(self) -> None:
        sql = "select * from users where id = ? and email = ?"
        self.assertEqual(
            database.translate_sql_for_mysql(sql),
            "select * from users where id = %s and email = %s",
        )

    def test_translate_insert_or_ignore_to_mysql(self) -> None:
        sql = "insert or ignore into settings(id, value_json) values(?, ?)"
        self.assertEqual(
            database.translate_sql_for_mysql(sql),
            "insert ignore into settings(id, value_json) values(%s, %s)",
        )

    def test_translate_on_conflict_to_mysql(self) -> None:
        sql = """
        insert into settings(id, value_json) values('site', ?)
        on conflict(id) do update set value_json = excluded.value_json
        """
        translated = database.translate_sql_for_mysql(sql)
        self.assertIn("on duplicate key update", translated.lower())
        self.assertIn("value_json = values(value_json)", translated)

    def test_health_metadata_does_not_expose_mysql_secret(self) -> None:
        with patch.dict(os.environ, {"DATABASE_URL": "mysql://user:secret@example.com:3306/coding_community"}):
            info = database.database_health_info()
        self.assertEqual(info["databaseEngine"], "mysql")
        self.assertNotIn("secret", str(info))
        self.assertNotIn("user", str(info))
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run:

```powershell
python -m pytest tests/test_database_adapter.py -q
```

Expected: FAIL because `database.py` does not exist yet.

- [ ] **Step 3: Add PyMySQL dependency**

Modify `requirements.txt` to contain:

```text
fastapi==0.111.0
uvicorn[standard]==0.30.1
python-multipart==0.0.9
PyMySQL==1.1.1
```

- [ ] **Step 4: Create database adapter**

Create `database.py` with these responsibilities:

```python
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


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
            user=parsed.username or "",
            password=parsed.password or "",
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
        statements = [part.strip() for part in script.split(";") if part.strip()]
        for statement in statements:
            self.execute(statement)

    def __enter__(self) -> "MySQLConnection":
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
```

- [ ] **Step 5: Run adapter tests and verify pass**

Run:

```powershell
python -m pytest tests/test_database_adapter.py -q
```

Expected: PASS.

---

### Task 3: Wire Server To Adapter While Preserving SQLite Behavior

**Files:**
- Modify: `server.py`
- Test: `tests/test_image_loading_contracts.py`
- Test: `tests/test_category_contracts.py`
- Test: `tests/test_vibe_coding_contracts.py`

- [ ] **Step 1: Update imports and database globals**

In `server.py`, replace direct SQLite connection setup with adapter imports:

```python
import sqlite3
```

remains for type compatibility, and add:

```python
from database import DB_PATH, database_engine, database_health_info, db
```

Remove the local `DB_PATH = DATA_DIR / "community.db"` assignment and remove the local `db()` function.

- [ ] **Step 2: Update `/api/health`**

Change `health()` to:

```python
@app.get("/api/health")
def health() -> dict[str, Any]:
  return {"ok": True, "mode": "fastapi", **database_health_info()}
```

- [ ] **Step 3: Preserve SQLite schema initialization**

Keep the existing SQLite `create table if not exists ...` schema in `init_db()` for local use. Add an engine branch:

```python
def init_db() -> None:
  with db() as conn:
    if database_engine() == "mysql":
      conn.executescript(mysql_schema_sql())
    else:
      conn.executescript(sqlite_schema_sql())
    ensure_work_columns(conn)
    seed_default_rows(conn)
    seed_deepseek_from_env(conn)
```

Move the current SQLite script into `sqlite_schema_sql()`, move current post-schema defaults into `seed_default_rows(conn)`, and keep current code behavior unchanged for SQLite.

- [ ] **Step 4: Run existing SQLite contract tests**

Run:

```powershell
python -m pytest tests/test_image_loading_contracts.py tests/test_category_contracts.py tests/test_vibe_coding_contracts.py -q
```

Expected: PASS with no `DATABASE_URL` set.

---

### Task 4: Add MySQL Schema Initialization

**Files:**
- Modify: `server.py`
- Create: `tests/test_mysql_schema_contracts.py`

- [ ] **Step 1: Write schema contract tests**

Create `tests/test_mysql_schema_contracts.py` to validate schema text without requiring live RDS:

```python
from __future__ import annotations

import unittest

import server


class MySQLSchemaContracts(unittest.TestCase):
    def test_mysql_schema_contains_current_tables(self) -> None:
        schema = server.mysql_schema_sql().lower()
        for table in [
            "users",
            "sessions",
            "admin_sessions",
            "user_profiles",
            "works",
            "points_records",
            "settings",
            "api_configs",
        ]:
            self.assertIn(f"create table if not exists {table}", schema)

    def test_mysql_schema_uses_utf8mb4_and_innodb(self) -> None:
        schema = server.mysql_schema_sql().lower()
        self.assertIn("charset=utf8mb4", schema)
        self.assertIn("engine=innodb", schema)

    def test_mysql_schema_has_expected_indexes(self) -> None:
        schema = server.mysql_schema_sql().lower()
        self.assertIn("idx_works_status", schema)
        self.assertIn("idx_works_author_id", schema)
        self.assertIn("idx_sessions_user_id", schema)
```

- [ ] **Step 2: Run schema tests and verify failure**

Run:

```powershell
python -m pytest tests/test_mysql_schema_contracts.py -q
```

Expected: FAIL because `mysql_schema_sql()` does not exist yet.

- [ ] **Step 3: Add MySQL schema function**

Add `mysql_schema_sql()` in `server.py` with MySQL-equivalent tables. Use `varchar` primary keys, `text` JSON string fields, `int` counters, `tinyint` booleans, and `utf8mb4`:

```python
def mysql_schema_sql() -> str:
  return """
  create table if not exists users (
    id varchar(80) primary key,
    phone varchar(80) unique,
    email varchar(255) unique,
    username varchar(120) unique,
    name varchar(255) not null,
    avatar text,
    password_hash text,
    role varchar(40) default 'creator',
    profile_json text,
    points int default 100,
    points_earned int default 0,
    activity_score int default 30,
    subscription_plan varchar(80) default 'Free',
    subscription_status varchar(80) default 'free',
    login_provider varchar(80),
    created_at varchar(40),
    last_login_at varchar(40),
    last_active_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists sessions (
    token varchar(255) primary key,
    user_id varchar(80) not null,
    created_at varchar(40),
    last_seen_at varchar(40),
    index idx_sessions_user_id(user_id)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists admin_sessions (
    token varchar(255) primary key,
    created_at varchar(40),
    last_seen_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists user_profiles (
    user_id varchar(80) primary key,
    avatar text,
    signature text,
    field text,
    account_type text,
    title text,
    organization text,
    location text,
    website text,
    bio text,
    language varchar(40) default 'zh-CN',
    timezone varchar(80) default 'Asia/Shanghai',
    visibility varchar(40) default 'public',
    newsletter tinyint default 1,
    terms_accepted tinyint default 1,
    updated_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists works (
    id varchar(120) primary key,
    title varchar(255) not null,
    category varchar(120),
    author varchar(255),
    author_id varchar(80),
    points int default 0,
    featured tinyint default 0,
    status varchar(40) default 'published',
    image_url text,
    html_path text,
    html_content mediumtext,
    description text,
    categories_json text,
    tags_json text,
    highlights_json text,
    use_cases_json text,
    creator_note text,
    version varchar(120),
    source_type varchar(80) default 'user-upload',
    origin_work_id varchar(120),
    origin_work_title varchar(255),
    created_at varchar(40),
    updated_at varchar(40),
    sales_count int default 0,
    revenue_points int default 0,
    index idx_works_status(status),
    index idx_works_created_at(created_at),
    index idx_works_author_id(author_id)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists points_records (
    id varchar(120) primary key,
    user_id varchar(80),
    amount int,
    kind varchar(40),
    note text,
    created_at varchar(40),
    index idx_points_records_user_id(user_id)
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists settings (
    id varchar(120) primary key,
    value_json text not null
  ) engine=InnoDB default charset=utf8mb4;

  create table if not exists api_configs (
    id varchar(120) primary key,
    provider varchar(120),
    base_url text,
    model varchar(120),
    api_key text,
    enabled tinyint default 0,
    config_json text,
    updated_at varchar(40)
  ) engine=InnoDB default charset=utf8mb4;
  """
```

- [ ] **Step 4: Run schema contract tests**

Run:

```powershell
python -m pytest tests/test_mysql_schema_contracts.py -q
```

Expected: PASS.

---

### Task 5: Seed DeepSeek Key From Deployment Environment

**Files:**
- Modify: `server.py`
- Create: `tests/test_deepseek_env_seed.py`

- [ ] **Step 1: Write DeepSeek env seed tests**

Create `tests/test_deepseek_env_seed.py`:

```python
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

import server


class DeepSeekEnvSeedTests(unittest.TestCase):
    def test_init_db_seeds_deepseek_key_from_environment(self) -> None:
        with patch.dict(
            os.environ,
            {
                "DEEPSEEK_API_KEY": "env-contract-key",
                "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
                "DEEPSEEK_MODEL": "deepseek-chat",
            },
        ):
            server.init_db()
        with server.db() as conn:
            row = conn.execute("select * from api_configs where id = 'deepseek-default'").fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["api_key"], "env-contract-key")
        self.assertEqual(row["enabled"], 1)

    def test_bootstrap_still_hides_seeded_deepseek_key(self) -> None:
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "hidden-env-contract-key"}):
            server.init_db()
        from fastapi.testclient import TestClient

        with TestClient(server.app) as client:
            response = client.get("/api/bootstrap")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("hidden-env-contract-key", response.text)
```

- [ ] **Step 2: Run DeepSeek tests and verify failure**

Run:

```powershell
python -m pytest tests/test_deepseek_env_seed.py -q
```

Expected: FAIL because startup does not yet write `DEEPSEEK_API_KEY` into `api_configs`.

- [ ] **Step 3: Add seeding function**

Add this function to `server.py` and call it from `init_db()` after default `api_configs` insertion:

```python
def seed_deepseek_from_env(conn: Any) -> None:
  api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
  if not api_key:
    return
  base_url = os.environ.get("DEEPSEEK_BASE_URL", "").strip() or "https://api.deepseek.com"
  model = os.environ.get("DEEPSEEK_MODEL", "").strip() or "deepseek-chat"
  conn.execute(
    """
    insert into api_configs(id, provider, base_url, model, api_key, enabled, config_json, updated_at)
    values('deepseek-default', 'DeepSeek', ?, ?, ?, 1, '{}', ?)
    on conflict(id) do update set
      provider = excluded.provider,
      base_url = excluded.base_url,
      model = excluded.model,
      api_key = excluded.api_key,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
    """,
    (base_url, model, api_key, now_text()),
  )
```

The adapter translates the upsert to MySQL when `DATABASE_URL` points at RDS.

- [ ] **Step 4: Run DeepSeek tests**

Run:

```powershell
python -m pytest tests/test_deepseek_env_seed.py tests/test_vibe_coding_contracts.py::VibeCodingContracts::test_bootstrap_does_not_expose_deepseek_api_key -q
```

Expected: PASS.

---

### Task 6: Add SQLite To MySQL Migration Script

**Files:**
- Create: `scripts/migrate_sqlite_to_mysql.py`
- Create: `tests/test_migration_script.py`

- [ ] **Step 1: Write migration script tests**

Create `tests/test_migration_script.py`:

```python
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts import migrate_sqlite_to_mysql


class MigrationScriptTests(unittest.TestCase):
    def test_ordered_tables_match_current_schema(self) -> None:
        self.assertEqual(
            migrate_sqlite_to_mysql.TABLES,
            [
                "users",
                "user_profiles",
                "works",
                "sessions",
                "admin_sessions",
                "settings",
                "api_configs",
                "points_records",
            ],
        )

    def test_read_sqlite_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "community.db"
            conn = sqlite3.connect(path)
            conn.execute("create table users(id text primary key, name text not null)")
            conn.execute("insert into users(id, name) values('u-1', 'User One')")
            conn.commit()
            conn.close()
            counts = migrate_sqlite_to_mysql.read_sqlite_counts(path, ["users"])
        self.assertEqual(counts, {"users": 1})
```

- [ ] **Step 2: Run migration tests and verify failure**

Run:

```powershell
python -m pytest tests/test_migration_script.py -q
```

Expected: FAIL because the script does not exist yet.

- [ ] **Step 3: Create migration script**

Create `scripts/migrate_sqlite_to_mysql.py` with:

```python
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from database import db, database_engine  # noqa: E402


TABLES = [
    "users",
    "user_profiles",
    "works",
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
            for table in tables
        }
    finally:
        conn.close()


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
    parser = argparse.ArgumentParser(description="Migrate Coding社区 SQLite data into MySQL.")
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
```

- [ ] **Step 4: Run migration script tests**

Run:

```powershell
python -m pytest tests/test_migration_script.py -q
```

Expected: PASS.

---

### Task 7: Update Deployment Documentation

**Files:**
- Modify: `DEPLOY.md`

- [ ] **Step 1: Add RDS environment variable section**

Add this deployment section to `DEPLOY.md`:

```markdown
## RDS MySQL Serverless

Production can use Alibaba Cloud RDS MySQL 8.0 Serverless by setting `DATABASE_URL`.

Example systemd environment values:

```ini
Environment="DATABASE_URL=mysql://coding_app:REPLACE_WITH_RDS_PASSWORD@REPLACE_WITH_RDS_INTERNAL_HOST:3306/coding_community"
Environment="DEEPSEEK_API_KEY=REPLACE_WITH_DEEPSEEK_KEY"
Environment="DEEPSEEK_BASE_URL=https://api.deepseek.com"
Environment="DEEPSEEK_MODEL=deepseek-chat"
```

Do not commit real passwords or API keys. Enter real values directly on the server or through a protected environment file.
```

- [ ] **Step 2: Add migration commands**

Add this command sequence:

```markdown
## SQLite To MySQL Migration

Back up the production SQLite database first:

```bash
sudo systemctl stop coding-community
sudo mkdir -p /opt/coding-community-backups/$(date +%Y%m%d%H%M%S)
sudo cp /opt/coding-community/data/community.db /opt/coding-community-backups/$(date +%Y%m%d%H%M%S)/community.db
```

Run the migration after `DATABASE_URL` points to RDS:

```bash
cd /opt/coding-community
source .venv/bin/activate
python scripts/migrate_sqlite_to_mysql.py --sqlite /opt/coding-community/data/community.db
sudo systemctl start coding-community
curl -s http://127.0.0.1:8000/api/health
```
```

- [ ] **Step 3: Add rollback commands**

Add this rollback section:

```markdown
## RDS Rollback

To roll back to SQLite, remove `DATABASE_URL` from the systemd service environment, then restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart coding-community
curl -s http://127.0.0.1:8000/api/health
```

The health response should show `databaseEngine` as `sqlite`.
```

- [ ] **Step 4: Verify documentation contains no real secrets**

Run:

```powershell
rg -n "sk-|AKIA|LTAI|secret-contract-key|env-contract-key|hidden-env-contract-key|REPLACE_WITH_RDS_PASSWORD" DEPLOY.md docs
```

Expected: only placeholder strings such as `REPLACE_WITH_RDS_PASSWORD` appear; no real secret appears.

---

### Task 8: Full Local Verification

**Files:**
- Read: all changed files

- [ ] **Step 1: Run all tests**

Run:

```powershell
python -m pytest tests -q
```

Expected: PASS.

- [ ] **Step 2: Run health endpoint locally**

Run:

```powershell
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```powershell
Invoke-WebRequest http://127.0.0.1:8000/api/health | Select-Object -ExpandProperty Content
```

Expected JSON includes:

```json
{"ok": true, "mode": "fastapi", "databaseEngine": "sqlite"}
```

- [ ] **Step 3: Verify DeepSeek env seed locally without exposing key**

Run with a disposable value:

```powershell
$env:DEEPSEEK_API_KEY="local-disposable-contract-key"
python - <<'PY'
import server
server.init_db()
with server.db() as conn:
    row = conn.execute("select enabled, length(api_key) as key_len from api_configs where id = 'deepseek-default'").fetchone()
    print(dict(row))
PY
Remove-Item Env:\DEEPSEEK_API_KEY
```

Expected: `enabled` is `1` and `key_len` is greater than `0`; the actual key is not printed.

---

### Task 9: Production Cutover Runbook

**Files:**
- Read: `DEPLOY.md`
- Read: `scripts/migrate_sqlite_to_mysql.py`

- [ ] **Step 1: Create RDS MySQL Serverless in Aliyun console**

Use the in-app browser or Aliyun console:

```text
Region: China (Hong Kong) / cn-hongkong
Engine: MySQL 8.0
Instance type: Serverless / pay-as-you-go
Database name: coding_community
Application account: coding_app
Network: same VPC or reachable from ECS
Whitelist/security group: allow only the ECS instance
```

Expected: RDS instance endpoint, database, and application account exist.

- [ ] **Step 2: Configure production environment**

On ECS, configure the service environment with real values entered on the server:

```bash
sudo systemctl edit coding-community
```

Use:

```ini
[Service]
Environment="DATABASE_URL=mysql://coding_app:REAL_PASSWORD@RDS_INTERNAL_HOST:3306/coding_community"
Environment="DEEPSEEK_API_KEY=REAL_DEEPSEEK_KEY"
Environment="DEEPSEEK_BASE_URL=https://api.deepseek.com"
Environment="DEEPSEEK_MODEL=deepseek-chat"
```

Expected: real values exist only in systemd protected configuration, not in repository files or chat.

- [ ] **Step 3: Back up production SQLite and uploads**

Run on ECS:

```bash
STAMP=$(date +%Y%m%d%H%M%S)
sudo mkdir -p /opt/coding-community-backups/$STAMP
sudo cp /opt/coding-community/data/community.db /opt/coding-community-backups/$STAMP/community.db
sudo tar -C /opt/coding-community -czf /opt/coding-community-backups/$STAMP/uploads.tar.gz uploads
sudo cp /opt/coding-community/server.py /opt/coding-community-backups/$STAMP/server.py
```

Expected: backup directory contains `community.db`, `uploads.tar.gz`, and `server.py`.

- [ ] **Step 4: Deploy code and install dependency**

Run on ECS:

```bash
cd /opt/coding-community
source .venv/bin/activate
pip install -r requirements.txt
```

Expected: `PyMySQL` installs successfully.

- [ ] **Step 5: Migrate SQLite rows into RDS**

Run on ECS:

```bash
cd /opt/coding-community
source .venv/bin/activate
python scripts/migrate_sqlite_to_mysql.py --sqlite /opt/coding-community/data/community.db
```

Expected output includes matching counts for:

```text
users: source=<n> target=<n>
works: source=<n> target=<n>
sessions: source=<n> target=<n>
settings: source=<n> target=<n>
api_configs: source=<n> target=<n>
```

- [ ] **Step 6: Restart service and verify health**

Run on ECS:

```bash
sudo systemctl daemon-reload
sudo systemctl restart coding-community
sudo systemctl status coding-community --no-pager
curl -s http://127.0.0.1:8000/api/health
```

Expected: service is active and health JSON includes `"databaseEngine":"mysql"`.

- [ ] **Step 7: Verify public routes**

Run:

```bash
curl -I http://www.yunhedongli.cloud/
curl -I http://www.yunhedongli.cloud/community.html
curl -I "http://www.yunhedongli.cloud/work.html?id=new-wave-flower-stage"
curl -s http://www.yunhedongli.cloud/api/bootstrap | head -c 500
curl -s http://www.yunhedongli.cloud/api/admin/overview
```

Expected: page requests return HTTP 200 and API requests return JSON.

---

## Self-Review

- Spec coverage: the plan covers MySQL adapter, MySQL schema, migration script, DeepSeek key env seeding, deployment docs, verification, and rollback. OSS migration is explicitly scoped out for a separate phase.
- Placeholder scan: the plan uses `REPLACE_WITH_*` and `REAL_*` only in documentation examples where real secrets must not be written. No implementation step depends on unknown function names.
- Type consistency: `database_engine()`, `database_health_info()`, `translate_sql_for_mysql()`, `db()`, `mysql_schema_sql()`, `seed_deepseek_from_env()`, and `scripts/migrate_sqlite_to_mysql.py::TABLES` are consistently named across tasks.
