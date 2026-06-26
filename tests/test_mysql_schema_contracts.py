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
        self.assertIn("idx_points_records_user_id", schema)


if __name__ == "__main__":
    unittest.main()
