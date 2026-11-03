"""DOM regression tests: python -m unittest discover -s tests -p 'test_extension.py' -v"""
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

PAGE = '''<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>
<table><thead><tr><th>Фото</th><th>Название товара</th><th>Отзывы ↓</th>
<th>Рейтинг</th><th>Контент-рейтинг</th><th>Цена карточки</th><th></th></tr></thead>
<tbody>
<tr><td></td><td>Товар А</td><td>196</td><td>4,5</td><td>90</td><td>17 000 ₽</td><td><button>Добавить в корзину</button></td></tr>
<tr><td></td><td>Товар Б</td><td>264</td><td>4,5</td><td>90</td><td>27 000 ₽</td><td><button>Добавить в корзину</button></td></tr>
<tr><td></td><td>Товар В</td><td>100</td><td>4,5</td><td>90</td><td>15 000 ₽</td><td><button>Добавить в корзину</button></td></tr>
<tr><td></td><td>Товар Г</td><td>0</td><td>4,5</td><td>90</td><td>10 000 ₽</td><td><button>Добавить в корзину</button></td></tr>
<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</tbody></table></body></html>'''


class PricePerReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True, executable_path='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None, args=['--no-sandbox'])
        cls.code = (ROOT / 'content.js').read_text(encoding='utf-8').replace(
            r'const STORE_PATH = /^\/app\/items\/store\/?$/;',
            r'const STORE_PATH = /^.*$/;',
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_content(PAGE)
        self.page.add_style_tag(path=str(ROOT / 'style.css'))
        self.page.add_script_tag(content=self.code)
        self.page.wait_for_function("document.querySelectorAll('td[data-ozrp-cell]').length === 4")

    def tearDown(self):
        self.page.close()

    def winner(self):
        return self.page.locator('.ozrp-winner').inner_text()

    def test_initial_winner_and_loading_placeholder(self):
        self.assertEqual(self.page.locator('th[data-ozrp-header]').count(), 1)
        self.assertEqual(self.page.locator('td[data-ozrp-cell]').count(), 4)
        self.assertIn('86,73 ₽', self.winner())
        self.assertEqual(self.page.locator('td.ozrp-cheap').count(), 1)
        self.assertIn('—', self.page.locator('td[data-ozrp-cell]').nth(3).inner_text())

    def test_cart_switch_and_restore(self):
        self.page.locator('tbody tr').first.locator('button').evaluate("e => e.textContent = 'Убрать из корзины'")
        self.page.wait_for_function("document.querySelector('.ozrp-winner .ozrp-amount')?.textContent.includes('102,27')", timeout=4000)
        self.assertIn('102,27', self.winner())
        self.page.locator('tbody tr').first.locator('button').evaluate("e => e.textContent = 'Добавить в корзину'")
        self.page.wait_for_function("document.querySelector('.ozrp-winner .ozrp-amount')?.textContent.includes('86,73')")
        self.assertIn('86,73', self.winner())

    def test_live_price_updates_and_rerender(self):
        self.page.locator('tbody tr').first.locator('td').nth(6).evaluate("e => e.textContent = '1 000 ₽'")
        self.page.wait_for_function("document.querySelector('.ozrp-winner .ozrp-amount')?.textContent.includes('5,10')", timeout=4000)
        # Simulate Ozon replacing native table rows and the header, not the
        # extension alone removing its own cells.
        self.page.evaluate("""() => {
          const table = document.querySelector('table');
          for (const row of [table.tHead.rows[0], ...table.tBodies[0].rows]) {
            const replacement = row.cloneNode(true);
            replacement.querySelectorAll('[data-ozrp-cell], [data-ozrp-header]')
              .forEach(node => node.remove());
            row.replaceWith(replacement);
          }
        }""")
        self.page.wait_for_function("document.querySelectorAll('td[data-ozrp-cell]').length === 4")
        self.assertEqual(self.page.locator('th[data-ozrp-header]').count(), 1)
        self.assertIn('5,10', self.winner())

    def test_heading_without_hyphen(self):
        self.page.locator('thead th').nth(4).evaluate("e => e.textContent = 'Контент рейтинг'")
        self.page.wait_for_timeout(150)
        self.assertEqual(self.page.locator('th[data-ozrp-header]').count(), 1)


if __name__ == '__main__':
    unittest.main()
