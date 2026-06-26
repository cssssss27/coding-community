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

    def test_translate_insert_or_replace_to_mysql(self) -> None:
        sql = "insert or replace into user_profiles(user_id, avatar) values(?, ?)"
        self.assertEqual(
            database.translate_sql_for_mysql(sql),
            "replace into user_profiles(user_id, avatar) values(%s, %s)",
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


if __name__ == "__main__":
    unittest.main()
