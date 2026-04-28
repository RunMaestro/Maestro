/**
 * Web interface smoke test
 *
 * Boots the standalone web/mobile bundle in a mobile-viewport Chromium and
 * verifies the React app mounts. This is the foundation other web e2e specs
 * build on — keep it minimal so it stays green even when the desktop-side
 * WebSocket backend is unavailable.
 */
import { test, expect } from '@playwright/test';

test.describe('web smoke', () => {
	test('document loads with expected title', async ({ page }) => {
		await page.goto('/');
		await expect(page).toHaveTitle(/Maestro Web/i);
	});

	test('react root mounts', async ({ page }) => {
		await page.goto('/');
		const root = page.locator('#root');
		await expect(root).toBeAttached();
		// React renders into #root; wait for at least one child element.
		await expect(root.locator('> *').first()).toBeAttached({ timeout: 10_000 });
	});
});
