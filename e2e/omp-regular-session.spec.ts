import { expect, test } from '@playwright/test';
import { cleanup, createSeededEnv, launch, type LaunchedApp } from './fixtures/plugin-harness';

/**
 * Regression guard for the native-session cutover: opening the application
 * never mounts the removed OMP workspace/webview or a session-detail overlay.
 * Native protocol behavior is driven deterministically in the OMP runtime unit
 * fixture; this proves the Electron shell keeps the normal session canvas.
 */
test.describe('OMP regular session shell', () => {
	test('starts in the ordinary Maestro session surface without an OMP overlay', async () => {
		test.setTimeout(90_000);
		const seeded = createSeededEnv();
		let launched: LaunchedApp | undefined;
		try {
			launched = await launch(seeded.env);
			await expect(launched.window.getByRole('button', { name: 'New Agent' })).toBeVisible();
			await expect(launched.window.locator('webview')).toHaveCount(0);
			await expect(launched.window.getByRole('dialog', { name: 'Session details' })).toHaveCount(0);
		} finally {
			if (launched) await launched.app.close();
			cleanup(seeded);
		}
	});
});
