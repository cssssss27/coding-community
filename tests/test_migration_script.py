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
                "work_engagements",
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


if __name__ == "__main__":
    unittest.main()
