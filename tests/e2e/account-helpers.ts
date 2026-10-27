import { expect, type Page } from '@playwright/test';
import type { Database } from '@ao/database';
import { verifyFixtureAccount } from '../../apps/api/test/email.js';
export async function verifyFixtureInBrowser(page: Page, db: Database, address: string) {
  await expect(
    page.getByRole('heading', { name: 'Verify your email.', exact: true }),
  ).toBeVisible();
  await verifyFixtureAccount(db, address);
  await page.getByRole('button', { name: 'I’ve verified my email', exact: true }).click();
  await expect(page.locator('.workspace-title')).toBeVisible();
}
