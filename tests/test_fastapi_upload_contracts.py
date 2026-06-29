from __future__ import annotations

import shutil
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


CONTRACT_PHONE = "19900000997"
CONTRACT_EMAIL = "fastapi-upload-contract@local.test"
CONTRACT_PASSWORD = "fastapi-upload-contract"
CONTRACT_TITLE = "FastAPI本地保存契约作品"


def cleanup_contract_data() -> None:
    with server.db() as conn:
        users = conn.execute(
            "select id, username from users where phone = ? or email = ?",
            (CONTRACT_PHONE, CONTRACT_EMAIL),
        ).fetchall()
        user_ids = [row["id"] for row in users]
        for user_id in user_ids:
            work_rows = conn.execute("select id, html_path, image_url from works where author_id = ?", (user_id,)).fetchall()
            for work in work_rows:
                conn.execute("delete from work_engagements where work_id = ?", (work["id"],))
                conn.execute("delete from works where id = ?", (work["id"],))
            conn.execute("delete from sessions where user_id = ?", (user_id,))
            conn.execute("delete from user_profiles where user_id = ?", (user_id,))
            conn.execute("delete from points_records where user_id = ?", (user_id,))
            conn.execute("delete from users where id = ?", (user_id,))
    upload_user_dir = server.USER_UPLOAD_DIR / CONTRACT_PHONE
    if upload_user_dir.exists():
        shutil.rmtree(upload_user_dir)


class FastApiUploadContracts(unittest.TestCase):
    def test_upload_page_retries_local_fastapi_before_failing(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('localBase: window.CC_LOCAL_API_BASE || "http://127.0.0.1:8010"', app_js)
        self.assertIn("candidateBases()", app_js)
        self.assertIn("async ensureBackendReady()", app_js)
        self.assertIn("await app.ensureBackendReady()", app_js)
        self.assertIn("无法写入本机 data/community.db 和 uploads", app_js)
        self.assertNotIn("上传失败：当前页面未连接 FastAPI 后台，作品没有保存。请使用本地 FastAPI 地址打开上传页。", app_js)

    def test_start_script_uses_local_fastapi_port_without_hardcoded_user_path(self) -> None:
        script = (ROOT / "Start_Coding社区_服务器.bat").read_text(encoding="utf-8")
        self.assertNotIn("C:\\Users\\my computer", script)
        self.assertIn("CODING_COMMUNITY_PORT", script)
        self.assertIn("CODING_COMMUNITY_PORT=8010", script)
        self.assertIn("--port %CODING_COMMUNITY_PORT%", script)

    def test_deploy_docs_use_8010_as_the_local_fastapi_port(self) -> None:
        deploy = (ROOT / "DEPLOY.md").read_text(encoding="utf-8")
        self.assertIn("--port 8010", deploy)
        self.assertIn("http://127.0.0.1:8010/", deploy)
        self.assertNotIn("--port 8000", deploy)
        self.assertNotIn("127.0.0.1:8000", deploy)

    def test_logged_in_fastapi_upload_persists_work_and_html_file(self) -> None:
        server.init_db()
        cleanup_contract_data()
        try:
            with TestClient(server.app) as client:
                register = client.post(
                    "/api/auth/register",
                    json={
                        "phone": CONTRACT_PHONE,
                        "email": CONTRACT_EMAIL,
                        "name": "FastAPI上传测试用户",
                        "password": CONTRACT_PASSWORD,
                        "avatar": "",
                        "signature": "本地上传保存契约测试",
                        "field": "创意组件",
                    },
                )
                self.assertEqual(register.status_code, 200, register.text)
                token = register.json()["token"]

                response = client.post(
                    "/api/works",
                    headers={"Authorization": f"Bearer {token}"},
                    data={
                        "title": CONTRACT_TITLE,
                        "categories": ["创意组件", "AI 实验"],
                        "author": "FastAPI上传测试用户",
                        "paidTrial": "true",
                        "status": "reviewing",
                        "description": "确认本地 FastAPI 上传会写入数据库和 uploads 目录。",
                        "tags": "FastAPI,本地保存,契约测试",
                        "highlights": "提交后写入 works 表\nHTML 文件落到 uploads/users",
                        "useCases": "本地测试\n云端部署前验收",
                        "creatorNote": "自动化测试生成，测试结束后清理。",
                        "version": "contract",
                    },
                    files={
                        "cover": (
                            "cover.png",
                            b"fake-cover",
                            "image/png",
                        ),
                        "file": (
                            "index.html",
                            b"<!doctype html><html><body><h1>FastAPI upload contract</h1></body></html>",
                            "text/html",
                        )
                    },
                )

            self.assertEqual(response.status_code, 200, response.text)
            work = response.json()["work"]
            self.assertEqual(work["title"], CONTRACT_TITLE)
            self.assertEqual(work["status"], "reviewing")
            self.assertTrue(work["paidTrial"])
            self.assertEqual(work["sourceType"], "user-upload")
            self.assertIn("FastAPI upload contract", work["html"])

            with server.db() as conn:
                row = conn.execute("select * from works where id = ?", (work["id"],)).fetchone()
            self.assertIsNotNone(row)
            html_path = ROOT / row["html_path"]
            self.assertTrue(html_path.exists(), row["html_path"])
            self.assertIn("FastAPI upload contract", html_path.read_text(encoding="utf-8"))
        finally:
            cleanup_contract_data()


if __name__ == "__main__":
    unittest.main()
