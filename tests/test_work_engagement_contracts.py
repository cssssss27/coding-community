from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


TEST_WORK_ID = "new-wave-flower-stage"
TEST_USER_ID = "u-engagement-contract"


def auth_headers(user_id: str = TEST_USER_ID, phone: str = "19900000003") -> dict[str, str]:
    server.init_db()
    with server.db() as conn:
        conn.execute(
            """
            insert or ignore into users(id, phone, name, avatar, password_hash, role, profile_json, created_at, last_login_at, last_active_at)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                phone,
                f"EngagementTester-{user_id[-4:]}",
                "images/avatars/avatar-lab.png",
                server.hash_password("engagement-test"),
                "creator",
                "{}",
                server.now_text(),
                server.now_text(),
                server.now_text(),
            ),
        )
        conn.execute("delete from work_engagements where user_id = ?", (user_id,))
        token = server.create_session(conn, user_id)
    return {"Authorization": f"Bearer {token}"}


class WorkEngagementContracts(unittest.TestCase):
    def tearDown(self) -> None:
        server.init_db()
        with server.db() as conn:
            conn.execute(
                "delete from work_engagements where user_id in (?, ?) or user_id like 'u-heat-%'",
                (TEST_USER_ID, "u-engagement-other"),
            )
            conn.execute(
                "update works set view_count = 0, trial_count = 0, vibe_count = 0 where id = ?",
                (TEST_WORK_ID,),
            )

    def test_like_and_favorite_are_persisted_per_user_and_counted(self) -> None:
        headers = auth_headers()
        with TestClient(server.app) as client:
            like_response = client.post(
                f"/api/works/{TEST_WORK_ID}/engagements",
                json={"kind": "like", "active": True},
                headers=headers,
            )
            self.assertEqual(like_response.status_code, 200)
            liked_work = like_response.json()["work"]
            self.assertTrue(like_response.json()["engagement"]["liked"])
            self.assertGreaterEqual(liked_work["likeCount"], 1)

            favorite_response = client.post(
                f"/api/works/{TEST_WORK_ID}/engagements",
                json={"kind": "favorite", "active": True},
                headers=headers,
            )
            self.assertEqual(favorite_response.status_code, 200)
            favorite_work = favorite_response.json()["work"]
            self.assertTrue(favorite_response.json()["engagement"]["favorited"])
            self.assertGreaterEqual(favorite_work["favoriteCount"], 1)

            repeated_like = client.post(
                f"/api/works/{TEST_WORK_ID}/engagements",
                json={"kind": "like", "active": True},
                headers=headers,
            )
            self.assertEqual(repeated_like.status_code, 200)
            self.assertEqual(repeated_like.json()["work"]["likeCount"], liked_work["likeCount"])

            bootstrap = client.get("/api/bootstrap", headers=headers)
            self.assertEqual(bootstrap.status_code, 200)
            payload = bootstrap.json()
            self.assertIn({"workId": TEST_WORK_ID, "kind": "like"}, payload["workEngagements"])
            self.assertIn({"workId": TEST_WORK_ID, "kind": "favorite"}, payload["workEngagements"])
            boot_work = next(work for work in payload["works"] if work["id"] == TEST_WORK_ID)
            self.assertGreaterEqual(boot_work["likeCount"], 1)
            self.assertGreaterEqual(boot_work["favoriteCount"], 1)

            other_headers = auth_headers("u-engagement-other", "19900000004")
            other_bootstrap = client.get("/api/bootstrap", headers=other_headers)
            self.assertEqual(other_bootstrap.status_code, 200)
            self.assertNotIn({"workId": TEST_WORK_ID, "kind": "like"}, other_bootstrap.json()["workEngagements"])

    def test_unlike_removes_only_that_users_engagement(self) -> None:
        headers = auth_headers()
        with TestClient(server.app) as client:
            client.post(
                f"/api/works/{TEST_WORK_ID}/engagements",
                json={"kind": "like", "active": True},
                headers=headers,
            )
            unlike_response = client.post(
                f"/api/works/{TEST_WORK_ID}/engagements",
                json={"kind": "like", "active": False},
                headers=headers,
            )
            self.assertEqual(unlike_response.status_code, 200)
            self.assertFalse(unlike_response.json()["engagement"]["liked"])
            bootstrap = client.get("/api/bootstrap", headers=headers).json()
            self.assertNotIn({"workId": TEST_WORK_ID, "kind": "like"}, bootstrap["workEngagements"])

    def test_frontend_renders_work_engagement_controls(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        mine_html = (ROOT / "mine.html").read_text(encoding="utf-8")
        self.assertIn("toggleWorkEngagement", app_js)
        self.assertIn("data-work-engagement", app_js)
        self.assertIn("workEngagementActions(work, \"card\")", app_js)
        self.assertNotIn("workEngagementActions(work, \"detail\")", app_js)
        self.assertIn("♡", app_js)
        self.assertIn("☆", app_js)
        self.assertIn("我的作品互动", app_js)
        self.assertIn('data-mine-tab="likes"', mine_html)
        self.assertIn("点赞收藏", mine_html)
        self.assertIn('if (tab === "likes")', app_js)
        self.assertIn("我点赞的作品", app_js)
        self.assertIn("我收藏的作品", app_js)
        works_branch = app_js.split('if (tab === "works") {', 1)[1].split('if (tab === "likes") {', 1)[0]
        self.assertNotIn("我点赞的作品", works_branch)
        self.assertNotIn("我收藏的作品", works_branch)
        self.assertIn("开放作品", app_js)
        self.assertIn("试用程序与做同款免费开放", app_js)
        self.assertIn("会员作品", app_js)
        self.assertIn("免费试用程序，会员开放做同款", app_js)
        self.assertIn(".work-engagement-actions", css)
        self.assertIn(".work-engagement-actions.is-card", css)
        self.assertIn("position: absolute;", css)
        self.assertIn(".work-access-title", css)
        self.assertIn(".work-access-copy", css)

    def test_heat_uses_weighted_views_likes_favorites_trials_and_vibes(self) -> None:
        server.init_db()
        with server.db() as conn:
            conn.execute(
                "update works set view_count = 100, trial_count = 40, vibe_count = 50 where id = ?",
                (TEST_WORK_ID,),
            )
            conn.execute("delete from work_engagements where work_id = ?", (TEST_WORK_ID,))
            for index in range(10):
                conn.execute(
                    "insert into work_engagements(user_id, work_id, kind, created_at) values(?, ?, 'like', ?)",
                    (f"u-heat-like-{index}", TEST_WORK_ID, server.now_text()),
                )
            for index in range(20):
                conn.execute(
                    "insert into work_engagements(user_id, work_id, kind, created_at) values(?, ?, 'favorite', ?)",
                    (f"u-heat-favorite-{index}", TEST_WORK_ID, server.now_text()),
                )
            row = server.work_row(conn, TEST_WORK_ID)
            work = server.public_work(row, include_html=False)

        self.assertEqual(work["viewCount"], 100)
        self.assertEqual(work["trialCount"], 40)
        self.assertEqual(work["vibeCount"], 50)
        self.assertEqual(work["likeCount"], 10)
        self.assertEqual(work["favoriteCount"], 20)
        self.assertEqual(work["heat"], 37)

    def test_work_events_increment_view_trial_and_vibe_counts(self) -> None:
        headers = auth_headers()
        with TestClient(server.app) as client:
            view = client.post(f"/api/works/{TEST_WORK_ID}/events", json={"kind": "view"}, headers=headers)
            trial = client.post(f"/api/works/{TEST_WORK_ID}/events", json={"kind": "trial"}, headers=headers)
            vibe = client.post(f"/api/works/{TEST_WORK_ID}/events", json={"kind": "vibe"}, headers=headers)

        self.assertEqual(view.status_code, 200)
        self.assertEqual(trial.status_code, 200)
        self.assertEqual(vibe.status_code, 200)
        work = vibe.json()["work"]
        self.assertGreaterEqual(work["viewCount"], 1)
        self.assertGreaterEqual(work["trialCount"], 1)
        self.assertGreaterEqual(work["vibeCount"], 1)


if __name__ == "__main__":
    unittest.main()
