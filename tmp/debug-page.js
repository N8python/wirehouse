const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    console.log('[console]', msg.type(), msg.text());
  });
  page.on('pageerror', (err) => {
    console.log('[pageerror]', err.message);
  });

  await page.goto('http://127.0.0.1:4173/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  const info = await page.evaluate(() => ({
    hasWiremanPerf: !!window.__wiremanPerf,
    hasRenderText: typeof window.render_game_to_text,
    hasAdvanceTime: typeof window.advanceTime,
    startDisabled: document.querySelector('#start-btn')?.disabled,
    loadingText: document.querySelector('#overlay-loading')?.textContent,
    overlayMode: document.querySelector('#overlay')?.dataset?.mode,
  }));
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
