from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

import database
import server


class ServerDatabaseContracts(unittest.TestCase):
    def test_server_uses_database_adapter_connection_entrypoint(self) -> None:
        self.assertIs(server.db, database.db)
        self.assertEqual(server.DB_PATH, database.DB_PATH)

    def test_health_exposes_database_engine(self) -> None:
        with TestClient(server.app) as client:
            response = client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["databaseEngine"], "sqlite")
        self.assertIn("database", payload)


if __name__ == "__main__":
    unittest.main()
