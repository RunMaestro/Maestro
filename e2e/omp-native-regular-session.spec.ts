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
			const result = await launched.window.evaluate(
				async (config) => window.maestro.process.spawn(config),
				{
					sessionId: 'omp-native-e2e-regular-session',
					toolType: 'omp',
					cwd: process.cwd(),
					command: 'omp',
					args: [],
					prompt: 'native OMP fixture journey',
				}
			);
			expect(result).toMatchObject({ success: true, pid: expect.any(Number) });
			expect(launched.output()).not.toMatch(/legacy.*fallback|fallback.*legacy/i);
			await expect(launched.window.locator('webview')).toHaveCount(0);
			await launched.window.screenshot({
				path: testInfo.outputPath('omp-native-regular-session.png'),
			});
		} finally {
			await harness.close();
		}
	});
});
