from __future__ import annotations

import os
import unittest
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


def read_deepseek_row() -> dict[str, Any] | None:
    with server.db() as conn:
        row = conn.execute("select * from api_configs where id = 'deepseek-default'").fetchone()
        return dict(row) if row else None


def restore_deepseek_row(row: dict[str, Any] | None) -> None:
    with server.db() as conn:
        if row is None:
            conn.execute("delete from api_configs where id = 'deepseek-default'")
            return
        conn.execute(
            """
            update api_configs
            set provider = ?, base_url = ?, model = ?, api_key = ?, enabled = ?, config_json = ?, updated_at = ?
            where id = 'deepseek-default'
            """,
            (
                row["provider"],
                row["base_url"],
                row["model"],
                row["api_key"],
                row["enabled"],
                row["config_json"],
                row["updated_at"],
            ),
        )


class DeepSeekEnvSeedTests(unittest.TestCase):
    def test_init_db_seeds_deepseek_key_from_environment(self) -> None:
        original = read_deepseek_row()
        try:
            with patch.dict(
                os.environ,
                {
                    "DEEPSEEK_API_KEY": "env-contract-key",
                    "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
                    "DEEPSEEK_MODEL": "deepseek-chat",
                },
            ):
                server.init_db()
            row = read_deepseek_row()
            self.assertIsNotNone(row)
            assert row is not None
            self.assertTrue(row["api_key"] == "env-contract-key", "DEEPSEEK_API_KEY was not seeded")
            self.assertEqual(row["enabled"], 1)
            self.assertEqual(row["base_url"], "https://api.deepseek.com")
            self.assertEqual(row["model"], "deepseek-chat")
        finally:
            restore_deepseek_row(original)

    def test_bootstrap_still_hides_seeded_deepseek_key(self) -> None:
        original = read_deepseek_row()
        try:
            with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "hidden-env-contract-key"}):
                server.init_db()
            with TestClient(server.app) as client:
                response = client.get("/api/bootstrap")
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("hidden-env-contract-key", response.text)
        finally:
            restore_deepseek_row(original)


if __name__ == "__main__":
    unittest.main()
