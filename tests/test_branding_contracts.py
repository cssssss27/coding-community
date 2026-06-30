from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGES = [
    "index.html",
    "community.html",
    "work.html",
    "vibe.html",
    "upload.html",
    "mine.html",
    "management.html",
]
BRAND_NAME = "XArt Coding社区"
BRAND_LOGO = "images/brand/xart-coding-logo.png"


class BrandingContracts(unittest.TestCase):
    def test_entry_pages_use_xart_brand_logo_and_name(self) -> None:
        for page in PAGES:
            html = (ROOT / page).read_text(encoding="utf-8")
            with self.subTest(page=page):
                self.assertIn(f'<img src="{BRAND_LOGO}" alt=""', html)
                self.assertIn(f'<span class="brand-name">{BRAND_NAME}</span>', html)
                self.assertNotIn('<span class="brand-mark">C.</span>', html)

    def test_brand_logo_has_dedicated_image_css(self) -> None:
        css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
        self.assertIn(".brand-mark img", css)
        self.assertIn("object-fit: contain", css)

    def test_default_site_name_is_xart_coding(self) -> None:
        settings = (ROOT / "js" / "data" / "settings.table.js").read_text(encoding="utf-8")
        server_py = (ROOT / "server.py").read_text(encoding="utf-8")
        app_js = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn(f'siteName: "{BRAND_NAME}"', settings)
        self.assertIn(f'DEFAULT_SITE_NAME = "{BRAND_NAME}"', server_py)
        self.assertIn(f'"{BRAND_NAME}"', app_js)


if __name__ == "__main__":
    unittest.main()
