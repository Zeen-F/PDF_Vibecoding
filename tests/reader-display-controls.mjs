// Exercise the same explicit disclosure a reader uses; never force hidden selects.
export async function openReaderDisplay(page) {
  const button = page.getByRole('button', { name: '显示设置', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
