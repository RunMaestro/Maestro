import { expect, test } from '@playwright/test';
import { launchNativeOmpRegularSessionHarness } from './fixtures/omp-native-regular-session-harness';

test.describe('first-party OMP regular session', () => {
	test('starts through the injected verified native gate while plugins are disabled', async ({
		browserName: _browserName,
	}, testInfo) => {
		void _browserName;
		test.setTimeout(120_000);
		const harness = await launchNativeOmpRegularSessionHarness();
		try {
			const { launched } = harness;
			await expect(launched.window.getByRole('button', { name: 'New Agent' })).toBeVisible({
				timeout: 45_000,
			});
			await launched.window.getByRole('button', { name: 'New Agent' }).click();
			await expect(launched.window.getByRole('dialog')).toBeVisible();
			await launched.window.getByText('Manual Setup', { exact: true }).click();
			await launched.window.getByText('Oh My Pi', { exact: true }).click();
			await launched.window.locator('input').first().fill('Native OMP fixture');
			await launched.window.locator('input[placeholder="Select directory..."]').fill(process.cwd());
			await launched.window.getByRole('button', { name: 'Create Agent' }).click();
			await expect(
				launched.window.getByText('Native OMP fixture', { exact: true }).first()
			).toBeVisible({ timeout: 30_000 });
			await expect(launched.window.getByRole('dialog')).toHaveCount(0);
			const composer = launched.window.locator('textarea').last();
			await expect(composer).toBeVisible();
			await composer.fill('show ordinary native transcript');
			await composer.press('Enter');
			await expect(launched.window.getByText(/fixture response for/).first()).toBeVisible({
				timeout: 30_000,
			});
			await expect(launched.window.getByText('Approve fixture tool?')).toBeVisible();
			await expect(launched.window.locator('webview')).toHaveCount(0);
			expect(launched.output()).not.toMatch(/legacy.*fallback|fallback.*legacy/i);
			await launched.window.screenshot({
				path: testInfo.outputPath('omp-native-regular-session.png'),
			});
		} finally {
			await harness.close();
		}
	});
});
