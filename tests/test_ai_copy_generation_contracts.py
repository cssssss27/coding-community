from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def user_headers() -> dict[str, str]:
    server.init_db()
    with server.db() as conn:
        conn.execute(
            """
            insert or ignore into users(id, phone, name, avatar, password_hash, role, profile_json, created_at, last_login_at, last_active_at)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "u-ai-copy-contract",
                "19900000221",
                "CopyTester",
                "images/avatars/avatar-deer.png",
                server.hash_password("copy-test"),
                "creator",
                "{}",
                server.now_text(),
                server.now_text(),
                server.now_text(),
            ),
        )
        token = server.create_session(conn, "u-ai-copy-contract")
    return {"Authorization": f"Bearer {token}"}


def admin_headers() -> dict[str, str]:
    server.init_db()
    with TestClient(server.app) as client:
        response = client.post("/api/admin/login", json={"username": "admin", "password": "admin1212"})
    assert response.status_code == 200
    return {"X-Admin-Token": response.json()["token"]}


class AiCopyGenerationContracts(unittest.TestCase):
    def test_default_upload_copy_prompts_are_seeded(self) -> None:
        server.init_db()
        with server.db() as conn:
            rows = server.settings_rows(conn)
        prompts = next(row for row in rows if row["id"] == "uploadCopyPrompts")
        self.assertIn("highlights", prompts)
        self.assertIn("useCases", prompts)
        self.assertIn("creatorNote", prompts)
        self.assertIn("{description}", prompts["highlights"])
        self.assertIn("{tags}", prompts["useCases"])
        self.assertIn("{description}", prompts["creatorNote"])

    def test_admin_can_update_upload_copy_prompts_without_touching_api_key(self) -> None:
        server.init_db()
        payload = {
            "highlights": "根据 {description} 和 {tags} 写三条功能亮点。",
            "useCases": "根据 {description} 和 {tags} 写三条适用场景。",
            "creatorNote": "根据 {description} 和 {tags} 写一段作者说明。",
        }
        with TestClient(server.app) as client:
            response = client.put("/api/admin/upload-copy-prompts", json=payload, headers=admin_headers())
        self.assertEqual(response.status_code, 200, response.text)
        prompts = response.json()["prompts"]
        self.assertEqual(prompts["highlights"], payload["highlights"])
        self.assertNotIn("apiKey", response.text)

    def test_upload_copy_generation_uses_server_model_and_returns_text_only(self) -> None:
        server.init_db()
        with server.db() as conn:
            conn.execute(
                """
                update api_configs
                set api_key = ?, enabled = 1, model = ?, base_url = ?, updated_at = ?
                where id = 'deepseek-default'
                """,
                ("secret-copy-key", "deepseek-v4-pro", "https://api.deepseek.com", server.now_text()),
            )
        model_payload = {
            "choices": [
                {
                    "message": {
                        "content": "可快速生成展陈导览\n适配移动端触控操作\n支持后续做同款改版"
                    }
                }
            ]
        }

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self):
                return json.dumps(model_payload).encode("utf-8")

        with patch("server.urllib.request.urlopen", return_value=FakeResponse()) as urlopen:
            with TestClient(server.app) as client:
                response = client.post(
                    "/api/ai/upload-copy",
                    json={
                        "target": "highlights",
                        "title": "文旅互动导览",
                        "description": "帮助展馆观众快速理解展项并参与互动。",
                        "tags": "文旅, 导览, 互动",
                    },
                    headers=user_headers(),
                )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["target"], "highlights")
        self.assertIn("移动端触控", response.json()["text"])
        self.assertNotIn("secret-copy-key", response.text)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.headers["Authorization"], "Bearer secret-copy-key")

    def test_upload_page_and_management_surface_ai_copy_controls(self) -> None:
        upload_html = (ROOT / "upload.html").read_text(encoding="utf-8")
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertIn('data-ai-copy-target="highlights"', upload_html)
        self.assertIn('data-ai-copy-target="useCases"', upload_html)
        self.assertIn('data-ai-copy-target="creatorNote"', upload_html)
        self.assertIn("ai-generate-button", upload_html)
        self.assertEqual(upload_html.count('class="ai-generate-button"'), 3)
        self.assertEqual(upload_html.count("<span aria-hidden=\"true\">✦</span><span>AI生成</span>"), 3)
        self.assertIn("min-width: 64px", css)
        self.assertIn("min-height: 24px", css)
        self.assertIn("border-radius: 6px", css)
        self.assertIn("grid-template-columns: auto auto", css)
        self.assertNotIn("border-radius: 50%;\n  background: #f4f7fb;", css)
        self.assertIn("generateUploadCopy", app_js)
        self.assertIn("updateUploadCopyPrompts", app_js)
        self.assertIn("upload-copy-prompts-form", app_js)
        self.assertIn("功能亮点提示词", app_js)


if __name__ == "__main__":
    unittest.main()
