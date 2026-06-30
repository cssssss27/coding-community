from __future__ import annotations

import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def auth_headers() -> dict[str, str]:
    server.init_db()
    with server.db() as conn:
        conn.execute(
            """
            insert or ignore into users(id, phone, name, avatar, password_hash, role, profile_json, created_at, last_login_at, last_active_at)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "u-vibe-contract",
                "19900000001",
                "VibeTester",
                "images/avatars/avatar-deer.png",
                server.hash_password("vibe-test"),
                "creator",
                "{}",
                server.now_text(),
                server.now_text(),
                server.now_text(),
            ),
        )
        token = server.create_session(conn, "u-vibe-contract")
    return {"Authorization": f"Bearer {token}"}


def admin_headers() -> dict[str, str]:
    server.init_db()
    with TestClient(server.app) as client:
        response = client.post("/api/admin/login", json={"username": "admin", "password": "admin1212"})
    assert response.status_code == 200
    return {"X-Admin-Token": response.json()["token"]}


class VibeCodingContracts(unittest.TestCase):
    def test_bootstrap_does_not_expose_deepseek_api_key(self) -> None:
        server.init_db()
        with server.db() as conn:
            original = conn.execute(
                """
                select provider, base_url, model, api_key, enabled, config_json, updated_at
                from api_configs
                where id = 'deepseek-default'
                """
            ).fetchone()
        with server.db() as conn:
            conn.execute(
                """
                update api_configs
                set api_key = ?, enabled = 1, updated_at = ?
                where id = 'deepseek-default'
                """,
                ("secret-contract-key", server.now_text()),
            )
        try:
            with TestClient(server.app) as client:
                response = client.get("/api/bootstrap")
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("secret-contract-key", response.text)
            self.assertEqual(response.json()["apiConfigs"][0]["apiKey"], "")
        finally:
            if original:
                with server.db() as conn:
                    conn.execute(
                        """
                        update api_configs
                        set provider = ?, base_url = ?, model = ?, api_key = ?, enabled = ?, config_json = ?, updated_at = ?
                        where id = 'deepseek-default'
                        """,
                        (
                            original["provider"],
                            original["base_url"],
                            original["model"],
                            original["api_key"],
                            original["enabled"],
                            original["config_json"],
                            original["updated_at"],
                        ),
                    )

    def test_vibe_page_uses_chat_and_preview_without_source_editor(self) -> None:
        vibe_html = (ROOT / "vibe.html").read_text(encoding="utf-8")
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="vibe-chat"', vibe_html)
        self.assertIn('id="vibe-preview"', vibe_html)
        self.assertIn('id="vibe-prompt"', vibe_html)
        self.assertNotIn('id="html-editor"', vibe_html)
        self.assertNotIn("code-editor", vibe_html)
        self.assertNotIn("editor.value = work.html", app_js)
        self.assertNotIn("app.writeFrame(preview, editor.value)", app_js)
        self.assertIn("createVibeSession", app_js)
        self.assertIn("sendVibeMessage", app_js)
        self.assertIn("vibePreviewUrl", app_js)

    def test_vibe_dialog_uses_generic_model_label_and_progress(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertIn('message.role === "user" ? "你" : "模型"', app_js)
        self.assertIn("modelThinkingSteps", app_js)
        self.assertIn("正在读取作品结构", app_js)
        self.assertIn("正在理解修改指令", app_js)
        self.assertIn("正在生成新版程序", app_js)
        self.assertNotIn("正在生成新版 HTML", app_js)
        self.assertIn("正在准备预览", app_js)
        self.assertIn("createModelProgressMessage", app_js)
        self.assertIn(".vibe-progress", css)
        self.assertNotIn("<span>AI</span>", app_js)

    def test_frontend_network_errors_are_actionable(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("formatApiConnectionError", app_js)
        self.assertIn("无法连接 API 服务", app_js)
        self.assertIn("/api/health", app_js)
        self.assertIn("http://127.0.0.1:8010/", app_js)
        self.assertIn("isLocalPage", app_js)
        self.assertIn("fromApiResponse", app_js)

    def test_admin_api_config_empty_key_preserves_existing_secret(self) -> None:
        server.init_db()
        with server.db() as conn:
            original = conn.execute(
                """
                select provider, base_url, model, api_key, enabled, config_json, updated_at
                from api_configs
                where id = 'deepseek-default'
                """
            ).fetchone()
            conn.execute(
                """
                update api_configs
                set api_key = ?, enabled = 1, updated_at = ?
                where id = 'deepseek-default'
                """,
                ("secret-contract-key", server.now_text()),
            )
        try:
            with TestClient(server.app) as client:
                response = client.put(
                    "/api/admin/api-configs/deepseek-default",
                    json={
                        "provider": "DeepSeek",
                        "baseUrl": "https://api.deepseek.com",
                        "model": "deepseek-v4-pro",
                        "apiKey": "",
                        "enabled": True,
                        "temperature": 0.35,
                    },
                    headers=admin_headers(),
                )
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("secret-contract-key", response.text)
            self.assertTrue(response.json()["apiConfig"]["apiKeyConfigured"])
            with server.db() as conn:
                key = conn.execute("select api_key from api_configs where id = 'deepseek-default'").fetchone()["api_key"]
            self.assertEqual(key, "secret-contract-key")
        finally:
            if original:
                with server.db() as conn:
                    conn.execute(
                        """
                        update api_configs
                        set provider = ?, base_url = ?, model = ?, api_key = ?, enabled = ?, config_json = ?, updated_at = ?
                        where id = 'deepseek-default'
                        """,
                        (
                            original["provider"],
                            original["base_url"],
                            original["model"],
                            original["api_key"],
                            original["enabled"],
                            original["config_json"],
                            original["updated_at"],
                        ),
                    )

    def test_admin_api_config_check_hides_secret_and_reports_readiness(self) -> None:
        server.init_db()
        with server.db() as conn:
            original = conn.execute(
                """
                select provider, base_url, model, api_key, enabled, config_json, updated_at
                from api_configs
                where id = 'deepseek-default'
                """
            ).fetchone()
            conn.execute(
                """
                update api_configs
                set api_key = ?, enabled = 1, updated_at = ?
                where id = 'deepseek-default'
                """,
                ("secret-contract-key", server.now_text()),
            )
        try:
            with TestClient(server.app) as client:
                response = client.post(
                    "/api/admin/api-configs/deepseek-default/check",
                    json={"live": False},
                    headers=admin_headers(),
                )
            self.assertEqual(response.status_code, 200)
            payload = response.json()["check"]
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["keyConfigured"])
            self.assertEqual(payload["keyLength"], len("secret-contract-key"))
            self.assertNotIn("secret-contract-key", response.text)
            self.assertNotIn("apiKey", payload)
        finally:
            if original:
                with server.db() as conn:
                    conn.execute(
                        """
                        update api_configs
                        set provider = ?, base_url = ?, model = ?, api_key = ?, enabled = ?, config_json = ?, updated_at = ?
                        where id = 'deepseek-default'
                        """,
                        (
                            original["provider"],
                            original["base_url"],
                            original["model"],
                            original["api_key"],
                            original["enabled"],
                            original["config_json"],
                            original["updated_at"],
                        ),
                    )

    def test_vibe_prompt_enter_submits_and_shift_enter_keeps_newline(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('prompt.addEventListener("keydown"', app_js)
        self.assertIn('event.key !== "Enter"', app_js)
        self.assertIn("event.shiftKey", app_js)
        self.assertIn("event.isComposing", app_js)
        self.assertIn("event.preventDefault()", app_js)
        self.assertIn("form.requestSubmit()", app_js)

    def test_vibe_derivative_ui_surfaces_origin_and_children(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertIn("function derivedWorks(work)", app_js)
        self.assertIn("originWorkId", app_js)
        self.assertIn("代码溯源", app_js)
        self.assertNotIn("原始代码来源", app_js)
        self.assertIn("source-work-card-link", app_js)
        self.assertIn("source-work-thumb", app_js)
        self.assertIn(".source-work-card-link", css)
        self.assertIn(".source-work-thumb", css)
        self.assertIn(".work-source-links {\n  display: grid;\n  grid-template-columns: 1fr;", css)
        self.assertIn("background: #f4f7fb;", css)
        self.assertIn("border: 1px solid #d8e0ea;", css)
        self.assertIn("衍生作品", app_js)
        self.assertIn("derived.length ? derived.map(compactWorkCard)", app_js)
        self.assertIn("#save-variant", css)
        self.assertIn(".work-derivative-section", css)

    def test_vibe_model_errors_use_generic_user_language(self) -> None:
        error = urllib.error.HTTPError(
            "https://api.deepseek.com/chat/completions",
            401,
            "Unauthorized",
            {},
            None,
        )
        with patch("server.urllib.request.urlopen", side_effect=error):
            with self.assertRaises(server.HTTPException) as context:
                server.call_deepseek_vibe(
                    "<!doctype html><html><body>Demo</body></html>",
                    "改一下标题",
                    [],
                    {
                        "baseUrl": "https://api.deepseek.com",
                        "model": "deepseek-v4-pro",
                        "apiKey": "bad-key",
                        "temperature": 0.35,
                    },
                )
        self.assertNotIn("DeepSeek", context.exception.detail)
        self.assertIn("模型", context.exception.detail)

    def test_vibe_session_response_hides_html_source(self) -> None:
        with TestClient(server.app) as client:
            response = client.post(
                "/api/vibe/sessions",
                json={"workId": "new-wave-flower-stage"},
                headers=auth_headers(),
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("session", payload)
        self.assertIn("previewUrl", payload["session"])
        self.assertNotIn("html", payload["session"])
        self.assertNotIn("sourceHtml", payload["session"])
        self.assertNotIn("<!doctype html>", response.text.lower())

    def test_vibe_session_can_load_user_uploaded_html_paths(self) -> None:
        work_id = "work-vibe-uploaded-contract"
        html_dir = ROOT / "uploads" / "users" / "vibe-contract" / "source"
        html_path = html_dir / "index.html"
        html_dir.mkdir(parents=True, exist_ok=True)
        html_path.write_text("<!doctype html><html><body><h1>User Upload</h1></body></html>", encoding="utf-8")
        relative_html_path = str(html_path.relative_to(ROOT)).replace("\\", "/")
        try:
            with server.db() as conn:
                conn.execute("delete from works where id = ?", (work_id,))
                conn.execute(
                    """
                    insert into works(
                      id, title, category, author, author_id, points, featured, status, image_url, html_path,
                      html_content, description, categories_json, tags_json, highlights_json, use_cases_json,
                      creator_note, version, source_type, created_at, updated_at, sales_count, revenue_points
                    )
                    values(?, 'Uploaded Contract', '创意组件', 'VibeTester', 'u-vibe-contract', 0, 0, 'published',
                      'images/works/tiny-crm.png', ?, '', '', '["创意组件"]', '[]', '[]', '[]', '', '', 'user-upload',
                      ?, ?, 0, 0)
                    """,
                    (work_id, relative_html_path, server.now_text(), server.now_text()),
                )
            with TestClient(server.app) as client:
                response = client.post(
                    "/api/vibe/sessions",
                    json={"workId": work_id},
                    headers=auth_headers(),
                )
            self.assertEqual(response.status_code, 200)
            self.assertIn("previewUrl", response.json()["session"])
            self.assertNotIn("User Upload</h1>", response.text)
        finally:
            with server.db() as conn:
                conn.execute("delete from works where id = ?", (work_id,))
            if html_path.exists():
                html_path.unlink()

    def test_vibe_message_updates_preview_without_returning_html(self) -> None:
        changed_html = "<!doctype html><html><body><h1>Changed Preview</h1></body></html>"
        with TestClient(server.app) as client:
            session_response = client.post(
                "/api/vibe/sessions",
                json={"workId": "new-wave-flower-stage"},
                headers=auth_headers(),
            )
            session_id = session_response.json()["session"]["id"]
            with patch("server.call_deepseek_vibe", return_value=(changed_html, "已更新预览。")):
                response = client.post(
                    f"/api/vibe/sessions/{session_id}/messages",
                    json={"prompt": "把标题改成 Changed Preview"},
                    headers=auth_headers(),
                )
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["message"]["role"], "assistant")
            self.assertIn("previewUrl", payload["session"])
            self.assertNotIn("Changed Preview</h1>", response.text)
            preview_response = client.get(payload["session"]["previewUrl"])
        self.assertEqual(preview_response.status_code, 200)
        self.assertIn("Changed Preview", preview_response.text)

    def test_vibe_save_variant_uses_session_html_on_server(self) -> None:
        changed_html = "<!doctype html><html><body><h1>Saved Variant</h1></body></html>"
        headers = auth_headers()
        with TestClient(server.app) as client:
            session_response = client.post(
                "/api/vibe/sessions",
                json={"workId": "new-wave-flower-stage"},
                headers=headers,
            )
            session_payload = session_response.json()["session"]
            session_id = session_payload["id"]
            source_title = session_payload["work"]["title"]
            with patch("server.call_deepseek_vibe", return_value=(changed_html, "已更新预览。")):
                client.post(
                    f"/api/vibe/sessions/{session_id}/messages",
                    json={"prompt": "保存前改一下"},
                    headers=headers,
                )
            save_response = client.post(
                f"/api/vibe/sessions/{session_id}/save",
                data={
                    "title": "Saved Vibe Contract",
                    "categories": ["创意组件"],
                    "author": "VibeTester",
                    "paidTrial": "true",
                    "description": "保存后的衍生作品需要完整发布信息。",
                    "tags": "保存,衍生",
                    "highlights": "使用会话 HTML",
                    "useCases": "契约测试",
                    "creatorNote": "自动化保存",
                    "version": "contract",
                },
                files={"cover": ("cover.png", b"fake-cover", "image/png")},
                headers=headers,
            )
            self.assertEqual(save_response.status_code, 200)
            work = save_response.json()["work"]
            self.assertEqual(work["title"], "Saved Vibe Contract")
            self.assertEqual(work["author"], "VibeTester")
            self.assertTrue(work["paidTrial"])
            self.assertEqual(work["description"], "保存后的衍生作品需要完整发布信息。")
            self.assertEqual(work["tags"], ["保存", "衍生"])
            self.assertIn("uploads/users/", work["image"])
            self.assertEqual(work["sourceType"], "vibe-remix")
            self.assertEqual(work["originWorkId"], "new-wave-flower-stage")
            self.assertEqual(work["originWorkTitle"], source_title)
            self.assertEqual(work["authorId"], "u-vibe-contract")
            self.assertNotIn("html", work)
            preview_response = client.get(f"/api/works/{work['id']}/preview")
        self.assertEqual(preview_response.status_code, 200)
        self.assertIn("Saved Variant", preview_response.text)
        with server.db() as conn:
            row = conn.execute("select html_path, origin_work_id, source_type from works where id = ?", (work["id"],)).fetchone()
            self.assertEqual(row["origin_work_id"], "new-wave-flower-stage")
            self.assertEqual(row["source_type"], "vibe-remix")
            conn.execute("delete from works where id = ?", (work["id"],))
        if row and row["html_path"]:
            path = ROOT / row["html_path"]
            if path.exists():
                path.unlink()


if __name__ == "__main__":
    unittest.main()
