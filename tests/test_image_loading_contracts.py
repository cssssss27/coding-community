from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class ImageLoadingContracts(unittest.TestCase):
    def test_bootstrap_work_cards_do_not_include_embedded_html(self) -> None:
        with server.db() as conn:
            row = conn.execute("select * from works order by created_at desc limit 1").fetchone()
        work = server.public_work(row, include_html=False)
        self.assertNotIn("html", work)

    def test_bootstrap_endpoint_omits_work_html(self) -> None:
        with TestClient(server.app) as client:
            response = client.get("/api/bootstrap")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertGreater(len(payload["works"]), 0)
        self.assertNotIn("html", payload["works"][0])

    def test_preview_endpoint_serves_runnable_html(self) -> None:
        with TestClient(server.app) as client:
            response = client.get("/api/works/new-wave-flower-stage/preview")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers["content-type"])
        self.assertIn("<!doctype html>", response.text.lower())
        self.assertIn("新潮花影活动页", response.text)

    def test_work_cards_use_progressive_image_attributes(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("loading=\"${imageLoading}\"", app_js)
        self.assertIn('decoding="async"', app_js)
        self.assertIn("fetchpriority=\"${imagePriority}\"", app_js)
        self.assertRegex(app_js, r"works\.map\(\(work,\s*index\)")

    def test_home_work_cards_keep_variable_masonry_ratios(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertIn("workThumbRatio(work)", app_js)
        self.assertIn('style="--thumb-ratio:${workThumbRatio(work)}"', app_js)
        self.assertRegex(css, r"\.work-thumb\s*\{[^}]*aspect-ratio:\s*var\(--thumb-ratio,\s*282\s*/\s*320\)")

    def test_detail_image_has_stable_placeholder(self) -> None:
        work_html = (ROOT / "work.html").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertRegex(work_html, r'<img id="work-image"[^>]+width="282"[^>]+height="320"')
        self.assertRegex(css, r"\.work-media\s*\{[^}]*aspect-ratio:\s*282\s*/\s*320")

    def test_trial_modal_loads_preview_url_in_iframe(self) -> None:
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("workPreviewUrl(work.id)", app_js)
        self.assertIn("trialFrame.src =", app_js)
        self.assertIn('trialFrame.removeAttribute("srcdoc")', app_js)
        self.assertIn("trialModal.classList.add(\"is-loading\")", app_js)
        self.assertIn("trialModal.classList.remove(\"is-loading\")", app_js)
        self.assertNotIn("app.writeFrame(trialFrame, work.html)", app_js)

    def test_trial_modal_can_expand_to_fullscreen_and_return(self) -> None:
        work_html = (ROOT / "work.html").read_text(encoding="utf-8")
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertIn('id="trial-meta"', work_html)
        self.assertIn('id="trial-fullscreen-toggle"', work_html)
        self.assertIn("setTrialFullscreen", app_js)
        self.assertIn('trialModal.classList.toggle("is-fullscreen", isFullscreen)', app_js)
        self.assertIn('trialFullscreenToggle.textContent = isFullscreen ? "缩小" : "全屏"', app_js)
        self.assertRegex(css, r"\.trial-modal\.is-fullscreen\s+\.trial-dialog\s*\{[^}]*width:\s*100vw[^}]*height:\s*100vh")

    def test_home_banner_uses_optimized_asset(self) -> None:
        index_html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("images/banners/home-ai-banner.webp", index_html)
        optimized = ROOT / "images" / "banners" / "home-ai-banner.webp"
        self.assertTrue(optimized.exists())
        self.assertLess(optimized.stat().st_size, 1_200_000)


if __name__ == "__main__":
    unittest.main()
