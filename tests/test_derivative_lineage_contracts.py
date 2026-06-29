from __future__ import annotations

import shutil
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


TEST_USER_ID = "u-derivative-contract"


def auth_headers() -> dict[str, str]:
    server.init_db()
    with server.db() as conn:
        conn.execute(
            """
            insert or ignore into users(id, phone, name, avatar, password_hash, role, profile_json, created_at, last_login_at, last_active_at)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                TEST_USER_ID,
                "19900000002",
                "DerivativeTester",
                "images/avatars/avatar-flow.png",
                server.hash_password("derivative-test"),
                "creator",
                "{}",
                server.now_text(),
                server.now_text(),
                server.now_text(),
            ),
        )
        token = server.create_session(conn, TEST_USER_ID)
    return {"Authorization": f"Bearer {token}"}


def remove_work(work_id: str) -> None:
    with server.db() as conn:
        row = conn.execute("select html_path from works where id = ?", (work_id,)).fetchone()
        conn.execute("delete from works where id = ?", (work_id,))
    if row and row["html_path"]:
        path = ROOT / row["html_path"]
        if path.exists():
            work_folder = path.parent
            if work_folder.exists() and str(work_folder).startswith(str((ROOT / "uploads" / "users").resolve())):
                shutil.rmtree(work_folder)


class DerivativeLineageContracts(unittest.TestCase):
    def test_vibe_save_requires_user_supplied_title(self) -> None:
        headers = auth_headers()
        with TestClient(server.app) as client:
            session_response = client.post(
                "/api/vibe/sessions",
                json={"workId": "new-wave-flower-stage"},
                headers=headers,
            )
            self.assertEqual(session_response.status_code, 200)
            session_id = session_response.json()["session"]["id"]
            save_response = client.post(
                f"/api/vibe/sessions/{session_id}/save",
                json={"title": "   "},
                headers=headers,
            )

        if save_response.status_code == 200:
            remove_work(save_response.json()["work"]["id"])
        self.assertEqual(save_response.status_code, 400)
        self.assertIn("请输入新作品名称", save_response.text)

    def test_derivative_lineage_records_original_parent_and_generation(self) -> None:
        headers = auth_headers()
        created_ids: list[str] = []
        with TestClient(server.app) as client:
            first_session = client.post(
                "/api/vibe/sessions",
                json={"workId": "new-wave-flower-stage"},
                headers=headers,
            ).json()["session"]
            source_title = first_session["work"]["title"]
            first_save = client.post(
                f"/api/vibe/sessions/{first_session['id']}/save",
                data={
                    "title": "第一代衍生契约作品",
                    "categories": ["创意组件", "AI 实验"],
                    "author": "DerivativeTester",
                    "paidTrial": "true",
                    "description": "第一代衍生作品必须填写完整提交信息。",
                    "tags": "衍生,契约",
                    "highlights": "完整发布信息\n保留源码溯源",
                    "useCases": "衍生测试",
                    "creatorNote": "自动化测试",
                    "version": "contract",
                },
                files={"cover": ("cover.png", b"fake-cover", "image/png")},
                headers=headers,
            )
            self.assertEqual(first_save.status_code, 200)
            first_work = first_save.json()["work"]
            created_ids.append(first_work["id"])

            second_session = client.post(
                "/api/vibe/sessions",
                json={"workId": first_work["id"]},
                headers=headers,
            ).json()["session"]
            second_save = client.post(
                f"/api/vibe/sessions/{second_session['id']}/save",
                data={
                    "title": "第二代衍生契约作品",
                    "categories": ["创意组件"],
                    "author": "DerivativeTester",
                    "paidTrial": "false",
                    "description": "第二代衍生作品同样需要完整提交信息。",
                    "tags": "二代,衍生",
                },
                files={"cover": ("cover.png", b"fake-cover", "image/png")},
                headers=headers,
            )
            self.assertEqual(second_save.status_code, 200)
            second_work = second_save.json()["work"]
            created_ids.append(second_work["id"])

        try:
            self.assertEqual(first_work["title"], "第一代衍生契约作品")
            self.assertEqual(first_work["author"], "DerivativeTester")
            self.assertTrue(first_work["paidTrial"])
            self.assertEqual(first_work["description"], "第一代衍生作品必须填写完整提交信息。")
            self.assertEqual(first_work["tags"], ["衍生", "契约"])
            self.assertIn("uploads/users/", first_work["image"])
            self.assertNotIn("同款改版", first_work["title"])
            self.assertEqual(first_work["derivativeGeneration"], 1)
            self.assertEqual(first_work["originalWorkId"], "new-wave-flower-stage")
            self.assertEqual(first_work["originalWorkTitle"], source_title)
            self.assertEqual(first_work["parentWorkId"], "new-wave-flower-stage")
            self.assertEqual(first_work["parentWorkTitle"], source_title)
            self.assertIn("第1代衍生", first_work["lineageLabel"])

            self.assertEqual(second_work["derivativeGeneration"], 2)
            self.assertEqual(second_work["originalWorkId"], "new-wave-flower-stage")
            self.assertEqual(second_work["originalWorkTitle"], source_title)
            self.assertEqual(second_work["parentWorkId"], first_work["id"])
            self.assertEqual(second_work["parentWorkTitle"], first_work["title"])
            self.assertIn("第2代衍生", second_work["lineageLabel"])
        finally:
            for work_id in reversed(created_ids):
                remove_work(work_id)

    def test_frontend_surfaces_lineage_and_name_dialog_contracts(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        upload_html = (ROOT / "upload.html").read_text(encoding="utf-8")
        self.assertIn("function derivativeLabel(work)", app_js)
        self.assertIn("初代作品", app_js)
        self.assertNotIn("最原版作品", app_js)
        self.assertIn("父代作品", app_js)
        self.assertIn("function lineageSourceCard", app_js)
        self.assertIn("source-work-thumb", app_js)
        self.assertIn("source-work-card-link", app_js)
        self.assertIn("source-work-title", app_js)
        self.assertIn("function askVariantSubmission", app_js)
        self.assertNotIn("function askVariantTitle", app_js)
        self.assertIn("variant-save-form", app_js)
        self.assertIn("作品名称", app_js)
        self.assertIn("作者显示名", app_js)
        self.assertIn("是否有偿做同款", app_js)
        self.assertNotIn("出售点数价格", app_js)
        self.assertIn("paidTrial", app_js)
        self.assertIn("一句话简介", app_js)
        self.assertIn("作品封面图", app_js)
        self.assertIn("required-star", app_js)
        self.assertIn("data-required-label", app_js)
        self.assertIn("isPaidWork", app_js)
        self.assertIn("会员作品", app_js)
        self.assertIn("做同款功能需会员权限", app_js)
        for label in ["作品名称", "作者显示名", "一句话简介", "标签", "作品封面图", "HTML 程序文件"]:
            self.assertIn(f"{label}<b class=\"required-star\"", upload_html)
        self.assertIn("是否有偿做同款", upload_html)
        self.assertNotIn("出售点数价格", upload_html)
        self.assertNotIn("saveVibeSession(activeSession.id, `${activeSession.work.title} 的同款改版`)", app_js)


if __name__ == "__main__":
    unittest.main()
