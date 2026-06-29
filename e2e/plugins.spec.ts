/**
 * Plugin-system E2E.
 *
 * Boots an isolated Maestro (demo mode) with a seeded tier-1 self-test plugin
 * and validates the real runtime end-to-end: discovery + manifest parse +
 * sandbox spawn (utilityProcess) + the default-deny broker model. The plugin
 * probes a representative capability set and logs PASS/DENY per cap; we read
 * those results from the captured main-process output (see plugin-harness).
 *
 * Run: bunx playwright test e2e/plugins.spec.ts   (needs dist/ built first:
 *   bun run build:main && bun run build:renderer)
 */
import { test, expect } from '@playwright/test';
import {
	PLUGIN_ID,
	PROBED_CAPS,
	createSeededEnv,
	seedAll,
	launch,
	cleanup,
	parseSelfTestSummary,
	type SeededEnv,
} from './fixtures/plugin-harness';

test.describe('plugin system e2e', () => {
	test.describe.configure({ timeout: 180_000 });

	test('discovers a seeded plugin and default-denies an ungranted self-test', async () => {
		const seeded: SeededEnv = createSeededEnv();
		await seedAll(seeded, { enabled: true });
		const { app, window, output } = await launch(seeded.env);

		try {
			// Discovery + manifest parse + renderer wiring: the seeded plugin is
			// listed and reports enabled (grants are session-only, so ungranted).
			await expect
				.poll(
					async () => {
						const snap = await window.evaluate(() => window.maestro.plugins.list());
						return (snap?.plugins ?? []).some((p) => p.id === PLUGIN_ID);
					},
					{ timeout: 30_000, message: 'seeded plugin never appeared in plugins.list()' }
				)
				.toBe(true);

			const snap = await window.evaluate(() => window.maestro.plugins.list());
			const entry = (snap?.plugins ?? []).find((p) => p.id === PLUGIN_ID);
			expect(entry?.enabled).toBe(true);

			// attachOutput() only starts capturing after launch() resolves, so the
			// activation self-test can be missed. Explicitly (re)invoke the command
			// and poll for THIS run's SUMMARY in the captured output. Every brokered
			// call MUST be denied while ungranted (default-deny security model).
			await expect
				.poll(
					async () => {
						await window.evaluate(
							(id) => window.maestro.plugins.invokeCommand(`${id}/selftest`).catch(() => undefined),
							PLUGIN_ID
						);
						return parseSelfTestSummary(output(), seeded.runId);
					},
					{
						timeout: 90_000,
						intervals: [1000, 2000, 3000, 5000],
						message: 'self-test SUMMARY never reached the host log',
					}
				)
				.not.toBeNull();

			const summary = parseSelfTestSummary(output(), seeded.runId);
			expect(summary).not.toBeNull();
			for (const cap of PROBED_CAPS) {
				expect(summary?.[cap], `${cap} should be DENY while ungranted`).toBe('DENY');
			}
		} finally {
			// Surface captured output on failure for triage during local runs.
			if (test.info().errors.length > 0) {
				console.log('--- captured Maestro output ---\n' + output());
			}
			await app.close();
			cleanup(seeded);
		}
	});

	test('selective consent grants only the approved capabilities', async () => {
		// Approved -> broker allows (PASS). Withheld: net:fetch needs real network
		// and ui:command's target palette command is unregistered, so both are left
		// unchecked and must stay DENY -> proves consent is per-capability.
		const GRANTED = [
			'fs:write',
			'fs:read',
			'settings:write',
			'settings:read',
			'storage:write',
			'storage:read',
			'notifications:toast',
			'events:subscribe',
		];
		const WITHHELD = ['net:fetch', 'ui:command'];

		const seeded: SeededEnv = createSeededEnv();
		await seedAll(seeded, { enabled: true });
		const { app, window, output } = await launch(seeded.env);

		try {
			await expect
				.poll(
					async () => {
						const snap = await window.evaluate(() => window.maestro.plugins.list());
						return (snap?.plugins ?? []).some((p) => p.id === PLUGIN_ID);
					},
					{ timeout: 30_000, message: 'seeded plugin never appeared in plugins.list()' }
				)
				.toBe(true);

			// Open the host-owned consent window (its sender frame is what the
			// minter validates), then approve a subset there.
			const consentPromise = app.waitForEvent('window', { timeout: 30_000 });
			await window.evaluate((id) => window.maestro.plugins.requestConsent(id), PLUGIN_ID);
			const consent = await consentPromise;
			await consent.waitForLoadState('domcontentloaded');
			await consent.locator('button.btn-approve').waitFor({ state: 'visible', timeout: 15_000 });

			for (const cap of WITHHELD) {
				await consent.locator(`.cap-check[data-cap="${cap}"]`).uncheck();
			}
			await consent.locator('button.btn-approve').click();

			// Grants are re-checked live per call. Re-invoke the self-test until the
			// approved caps flip to PASS, then assert the full selective outcome.
			await expect
				.poll(
					async () => {
						await window.evaluate(
							(id) => window.maestro.plugins.invokeCommand(`${id}/selftest`).catch(() => undefined),
							PLUGIN_ID
						);
						return parseSelfTestSummary(output(), seeded.runId)?.['fs:write'] ?? null;
					},
					{
						timeout: 60_000,
						intervals: [1000, 2000, 3000, 5000],
						message: 'granted fs:write never flipped to PASS after consent',
					}
				)
				.toBe('PASS');

			const summary = parseSelfTestSummary(output(), seeded.runId);
			expect(summary).not.toBeNull();
			for (const cap of GRANTED) {
				expect(summary?.[cap], `${cap} should PASS once granted`).toBe('PASS');
			}
			for (const cap of WITHHELD) {
				expect(summary?.[cap], `${cap} should stay DENY (not approved)`).toBe('DENY');
			}
		} finally {
			if (test.info().errors.length > 0) {
				console.log('--- captured Maestro output ---\n' + output());
			}
			await app.close();
			cleanup(seeded);
		}
	});
});
