import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// The caller owns a synthetic library. Use a separate browser profile so layout
// preferences cannot affect the other reading workflows.
export async function shanlanWorkflow({ browser, base }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [], themeWrites = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'PATCH' && request.url().endsWith('/api/library/theme')) themeWrites.push(request.url());
  });
  try {
    await page.goto(base);
    await expect(page.getByRole('button', { name: '主题：森林', exact: true })).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-preview', 'shanlan');
    const savedTheme = (await (await fetch(`${base}/api/library`)).json()).theme;
    await page.goto(`${base}/?visual=shanlan`);
    await expect(page.locator('html')).toHaveAttribute('data-preview', 'shanlan');
    const trigger = page.getByRole('button', { name: '快速定位文献', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '快速定位文献', exact: true });
    const search = dialog.getByRole('combobox', { name: '按标题查找文献', exact: true });
    await expect(search).toBeFocused();
    const options = dialog.getByRole('option');
    await expect.poll(() => options.count()).toBeGreaterThan(1);
    const firstTitle = await options.nth(0).locator('strong').innerText();
    const secondTitle = await options.nth(1).locator('strong').innerText();
    await search.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await search.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await search.fill('NO_SUCH_SYNTHETIC_TITLE_8844');
    await expect(options).toHaveCount(0);
    await search.press('Enter');
    await expect(dialog).toBeVisible();
    await search.fill(secondTitle);
    await expect(options.first()).toContainText(secondTitle);
    await search.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: secondTitle, exact: true })).toBeVisible();
    await trigger.click();
    await search.fill(firstTitle);
    await search.press('Tab');
    await expect(dialog.getByRole('button', { name: '关闭快速定位', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    const separator = page.getByRole('separator', { name: '调整文献栏宽度', exact: true });
    const originalWidth = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus();
    await separator.press('ArrowRight');
    await expect(separator).toHaveAttribute('aria-valuenow', String(originalWidth + 16));
    await separator.press('Home');
    await expect(separator).toHaveAttribute('aria-valuenow', '200');
    const bounds = await separator.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 50);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 75, bounds.y + 50, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(240);
    await separator.dblclick();
    await expect(separator).toHaveAttribute('aria-valuenow', String(originalWidth));
    await page.getByRole('button', { name: '展开书架', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '文献文件夹', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '收起书架', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '文献文件夹', exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: '展开书架', exact: true }).click();

    await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
    await page.getByRole('button', { name: '月下场景', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-shelf-density', 'comfortable');
    await expect(page.locator('html')).toHaveAttribute('data-shelf-scene', 'moon');
    assert.deepEqual(themeWrites, []);
    assert.equal((await (await fetch(`${base}/api/library`)).json()).theme, savedTheme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-shelf-density', 'compact');
    await expect(page.locator('html')).toHaveAttribute('data-shelf-scene', 'dawn');
    await page.setViewportSize({ width: 1000, height: 640 });
    await expect(trigger).toBeInViewport();
    await expect(page.getByRole('button', { name: '月下场景', exact: true })).toBeInViewport();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await trigger.click();
    await expect(dialog).toBeInViewport();
    await expect(search).toBeFocused();
    assert.deepEqual(errors, []);
    console.log('PASS Shanlan opt-in, title navigation, modal focus, keyboard/pointer resize, compact layout and nonpersistent appearance');
  } finally {
    await context.close();
  }
}
