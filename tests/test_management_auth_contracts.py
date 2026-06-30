from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


DESIRED_ADMIN_AUTH = {"username": "admin", "password": "admin1212"}
OLD_DEFAULT_AUTHS = (
    {"username": "admin", "password": "admin"},
    {"username": "admin", "password": "123456"},
)


def admin_auth_setting() -> dict[str, str] | None:
    with server.db() as conn:
        row = conn.execute("select value_json from settings where id = 'adminAuth'").fetchone()
    return server.json_loads(row["value_json"], {}) if row else None


def set_admin_auth(value: dict[str, str] | None) -> None:
    with server.db() as conn:
        if value is None:
            conn.execute("delete from settings where id = 'adminAuth'")
        else:
            conn.execute(
                """
                insert into settings(id, value_json) values('adminAuth', ?)
                on conflict(id) do update set value_json = excluded.value_json
                """,
                (server.json_dumps(value),),
            )


def restore_admin_auth(original: dict[str, str] | None) -> None:
    if original is None or original in OLD_DEFAULT_AUTHS:
        set_admin_auth(DESIRED_ADMIN_AUTH)
    else:
        set_admin_auth(original)


class ManagementAuthContracts(unittest.TestCase):
    def test_management_login_page_does_not_print_default_credentials(self) -> None:
        management_html = (ROOT / "management.html").read_text(encoding="utf-8")
        self.assertNotIn("默认用户名", management_html)
        self.assertNotIn("默认密码", management_html)
        self.assertNotIn("密码 123456", management_html)
        self.assertNotIn("admin1212", management_html)

    def test_old_default_admin_auth_migrates_to_new_password(self) -> None:
        server.init_db()
        original = admin_auth_setting()
        try:
            set_admin_auth({"username": "admin", "password": "123456"})
            server.init_db()
            self.assertEqual(admin_auth_setting(), DESIRED_ADMIN_AUTH)
        finally:
            restore_admin_auth(original)

    def test_admin_login_accepts_new_default_and_rejects_old_default(self) -> None:
        server.init_db()
        original = admin_auth_setting()
        try:
            set_admin_auth(DESIRED_ADMIN_AUTH)
            with TestClient(server.app) as client:
                ok_response = client.post("/api/admin/login", json=DESIRED_ADMIN_AUTH)
                old_response = client.post("/api/admin/login", json={"username": "admin", "password": "123456"})
            self.assertEqual(ok_response.status_code, 200)
            self.assertEqual(old_response.status_code, 401)
        finally:
            restore_admin_auth(original)

    def test_management_works_uses_responsive_record_layout(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertIn("management-work-list", app_js)
        self.assertIn("management-work-record", app_js)
        self.assertIn("management-work-actions", app_js)
        self.assertIn("data-work-row", app_js)
        self.assertIn("data-save-work", app_js)
        self.assertIn("data-delete-work", app_js)
        self.assertNotIn("table class=\"table management-table\"", app_js)
        self.assertIn(".management-work-record", css)
        self.assertIn(".management-work-actions", css)


if __name__ == "__main__":
    unittest.main()
