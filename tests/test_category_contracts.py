from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class CategoryContracts(unittest.TestCase):
    def test_default_category_slots_are_exactly_twelve(self) -> None:
        categories = server.default_work_categories()
        self.assertEqual(len(categories), 12)
        self.assertEqual(len(set(categories)), 12)
        self.assertTrue(all(name.strip() for name in categories))

    def test_work_categories_are_normalized_to_one_to_three_known_slots(self) -> None:
        allowed = server.default_work_categories()
        normalized = server.normalize_work_categories(["AI 实验", "不存在", "生活工具", "艺术展览"], allowed)
        self.assertEqual(normalized, ["AI 实验", "生活工具", "艺术展览"])
        self.assertEqual(server.normalize_work_categories([], allowed), [allowed[0]])

    def test_public_work_exposes_category_array_in_allowed_slots(self) -> None:
        allowed = set(server.default_work_categories())
        with server.db() as conn:
            row = conn.execute("select * from works order by created_at desc limit 1").fetchone()
        work = server.public_work(row, include_html=False)
        self.assertIn("categories", work)
        self.assertGreaterEqual(len(work["categories"]), 1)
        self.assertLessEqual(len(work["categories"]), 3)
        self.assertTrue(set(work["categories"]).issubset(allowed))
        self.assertEqual(work["category"], work["categories"][0])

    def test_bootstrap_exposes_twelve_categories_for_frontend(self) -> None:
        with TestClient(server.app) as client:
            response = client.get("/api/bootstrap")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("categories", payload)
        self.assertEqual(len(payload["categories"]), 12)

    def test_frontend_uses_fixed_categories_for_community_upload_and_management(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        upload_html = (ROOT / "upload.html").read_text(encoding="utf-8")
        self.assertIn("function appCategories()", app_js)
        self.assertIn("workInCategory(work, category)", app_js)
        self.assertIn("renderCategorySelects", app_js)
        self.assertIn("management-category-grid", app_js)
        self.assertIn('id="upload-categories"', upload_html)
        self.assertNotIn('name="category" list="upload-categories"', upload_html)

    def test_upload_page_uses_title_row_and_category_button_picker(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        upload_html = (ROOT / "upload.html").read_text(encoding="utf-8")
        self.assertIn('class="field-group upload-title-field full"', upload_html)
        self.assertIn('class="field-group upload-category-field full"', upload_html)
        self.assertIn('class="upload-category-picker"', upload_html)
        self.assertIn("renderUploadCategoryButtons", app_js)
        self.assertIn("data-upload-category", app_js)
        self.assertIn("最多选择 3 个作品分类", app_js)
        self.assertNotIn("category-select-stack", upload_html)


if __name__ == "__main__":
    unittest.main()
