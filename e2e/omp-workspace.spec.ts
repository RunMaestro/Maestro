import { expect, test } from '@playwright/test';
import { cleanup, createSeededEnv, launch, type LaunchedApp } from './fixtures/plugin-harness';

test.describe('OMP generic workspace cold start', () => {
	test('exposes an empty, ready workspace bridge from an isolated user-data directory', async () => {
		test.setTimeout(90_000);
		const seeded = createSeededEnv();
		let launched: LaunchedApp | undefined;
		try {
			launched = await launch(seeded.env);
			const snapshot = await launched.window.evaluate(async () => {
				return window.maestro.pluginWorkspaces.getSnapshot();
			});

			expect(snapshot).toEqual({ connection: 'ready', workspaces: [], selection: null });
			await expect(launched.window.locator('[data-plugin-workspace-activity-items]')).toHaveCount(
				0
			);
			await expect(
				launched.window.getByRole('navigation', { name: 'External sessions' })
			).toHaveCount(0);
		} finally {
			if (launched) await launched.app.close();
			cleanup(seeded);
		}
	});
});
