import { expect, test } from '@playwright/test';

test('the placeholder page renders and switches between English and Spanish', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  await page.goto('/');

  // React rendered the app into #root.
  await expect(page.getByRole('heading', { level: 1, name: 'MelonOffice' })).toBeVisible();
  await expect(page.getByText('Your intelligent office')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.getByRole('button', { name: 'Español' }).click();

  await expect(page.getByText('Tu oficina inteligente')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('button', { name: 'Español' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  expect(problems).toEqual([]);
});

test('the health endpoint answers', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok' });
});
