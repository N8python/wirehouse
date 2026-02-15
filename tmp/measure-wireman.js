const { chromium } = require('playwright');

async function waitForStartEnabled(page, timeoutMs = 120000) {
  await page.waitForFunction(() => {
    const btn = document.querySelector('#start-btn');
    return Boolean(btn) && !btn.disabled;
  }, { timeout: timeoutMs });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://127.0.0.1:4173/index.html', { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#start-btn', { timeout: 30000 });
  await waitForStartEnabled(page);
  await page.click('#start-btn');

  await page.waitForFunction(() => {
    return typeof window.render_game_to_text === 'function' &&
      typeof window.advanceTime === 'function' &&
      !!window.__wiremanPerf;
  }, { timeout: 60000 });

  const result = await page.evaluate(() => {
    const frames = 60 * 30;
    const frameStepMs = 1000 / 60;

    const readState = () => {
      if (typeof window.render_game_to_text !== 'function') return null;
      try {
        return JSON.parse(window.render_game_to_text());
      } catch {
        return null;
      }
    };

    const runFrames = () => {
      for (let i = 0; i < frames; i += 1) {
        if (typeof window.advanceTime === 'function') {
          window.advanceTime(frameStepMs);
        }
      }
    };

    const perfApi = window.__wiremanPerf;
    if (!perfApi || typeof perfApi.reset !== 'function' || typeof perfApi.getSnapshot !== 'function') {
      return { error: '__wiremanPerf API missing' };
    }

    const beforeState = readState();

    perfApi.reset();
    runFrames();
    const activeSnapshot = perfApi.getSnapshot();
    const activeState = readState();

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));

    perfApi.reset();
    runFrames();
    const pausedSnapshot = perfApi.getSnapshot();
    const pausedState = readState();

    return {
      beforeFlags: beforeState?.flags || null,
      activeSnapshot,
      pausedSnapshot,
      activeFlags: activeState?.flags || null,
      pausedFlags: pausedState?.flags || null,
      wiremanMode: activeState?.wireman?.huntMode || null,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
