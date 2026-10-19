import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

// Original local fixture only. No translation/provider configuration or calls.
export async function readerUiRefinementWorkflow({ context, base, onPreview }) {
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const form = new FormData();
  form.append('file', new Blob([await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url))]), 'reading-demo.pdf');
  const response = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
  assert.ok(response.ok); const { document } = await response.json();
  try {
    await page.goto(`${base}/?document=${document.id}&page=1`);
    await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
    const display = page.getByRole('button', { name: '显示设置', exact: true });
    const group = page.getByRole('group', { name: '阅读显示设置', exact: true });
    await expect(display).toHaveAttribute('aria-expanded', 'false');
    await expect(group).toBeHidden();
    await expect(page.getByRole('combobox', { name: '阅读缩放', exact: true })).toBeVisible();
    await display.focus(); await page.keyboard.press('Enter');
    await expect(group).toBeVisible();
    await group.getByRole('combobox', { name: '页面布局', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(group).toBeHidden(); await expect(display).toBeFocused();
    await display.click(); await page.locator('.page-footer').click(); await expect(group).toBeHidden();

    const notes = page.getByRole('textbox', { name: '笔记', exact: true });
    if (!await notes.isVisible()) await page.getByRole('button', { name: '展开笔记面板', exact: true }).click();
    const initial = await notes.inputValue();
    const originalPreference = await page.evaluate(() => localStorage.getItem('paperdesk-library-collapsed'));
    await notes.fill(`${initial}\n\nSynthetic focus-mode draft`);
    await page.getByRole('button', { name: '专注阅读', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出专注', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#library-panel')).toHaveClass(/collapsed/);
    await expect(page.locator('#notes-panel')).toHaveClass(/collapsed/);
    assert.equal(await page.evaluate(() => localStorage.getItem('paperdesk-library-collapsed')), originalPreference);
    await onPreview?.(page, 'focus-reading');
    await page.getByRole('button', { name: '退出专注', exact: true }).click();
    await expect(notes).toHaveValue(`${initial}\n\nSynthetic focus-mode draft`);
    await notes.fill(initial); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.setViewportSize({ width: 600, height: 800 });
    await page.getByRole('button', { name: '专注阅读', exact: true }).click();
    await display.click(); await expect(group).toBeVisible();
    const box = await group.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 601);
    await onPreview?.(page, 'display-settings-narrow');
    await group.getByRole('button', { name: '关闭显示设置', exact: true }).click();
    await expect(display).toBeFocused();
    assert.deepEqual(errors, []);
    console.log('PASS: display disclosure keyboard/dismissal, focus reading preference/draft preservation, narrow display controls');
  } finally { await page.close(); }
}
