import { expect } from '@playwright/test';

// Programmatic file input/drop bypasses the visible button's import guards.
// Mount first: the button may be enabled before startup restoration begins.
export async function waitForImportReady(page) {
  const button=page.getByRole('button',{name:'导入 PDF',exact:true,includeHidden:true});
  await expect(button).toHaveCount(1);
  await expect(page.getByText('正在打开书桌…',{exact:true})).toHaveCount(0);
  await expect(page.locator('.opening-mask')).toHaveCount(0);
  await expect(page.locator('.app-shell[inert]')).toHaveCount(0);
  await expect(page.locator('[aria-modal="true"]:visible')).toHaveCount(0);
  await expect(button).toBeEnabled();
}
