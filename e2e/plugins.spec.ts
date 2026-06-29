/**
 * Plugin-system E2E — exercises the ENTIRE plugin interface end-to-end against
 * a real isolated Maestro (demo mode) with a seeded full-surface self-test
 * plugin and its real utilityProcess sandbox:
 *
 *  1. discovery + default-deny (every brokered capability DENY while ungranted)
 *  2. full broker matrix (approved caps function; INERT for host-unwired verbs;
 *     withheld stays DENY) via the real host-owned consent window
 *  3. real event delivery (subscribe -> host emit -> sandbox handler)
 *  4. contribution aggregation (all tier-0 buckets) + ui:contribute/ui:panel
 *     gating + revoke re-denies
 *  5. the untrusted transcripts+egress consent CONFLICT, and that a signed
 *     (trusted) plugin lifts it
 *
 * Results are read from the captured main-process output (the sandbox's
 * console.log is forwarded by the host logger), matched on a per-run id marker.
 *
 * Run: bunx playwright test e2e/plugins.spec.ts
 *   (build dist first: bun run build:main && bun run build:renderer)
 */
import { test, expect } from '@playwright/test';
import {
	PLUGIN_ID,
	PROBED_CAPS,
	createSeededEnv,
	seedAll,
	launch,
	cleanup,
	approveConsent,
	parseSelfTestSummary,
	sawDeliveredEvent,
	triggerSessionUpdated,
	type SeededEnv,
	type LaunchedApp,
} from './fixtures/plugin-harness';

const complete = (s: Record<string, string>): boolean =>
	PROBED_CAPS.every((c) => typeof s[c] === 'string');

test.describe('plugin system e2e', () => {
	test.describe.configure({ timeout: 240_000 });

	async function waitListed(launched: LaunchedApp): Promise<void> {
		await expect
			.poll(
				async () => {
					const snap = await launched.window.evaluate(() => window.maestro.plugins.list());
					return (snap?.plugins ?? []).some((p) => p.id === PLUGIN_ID);
				},
				{ timeout: 30_000, message: 'seeded plugin never appeared in plugins.list()' }
			)
			.toBe(true);
	}

	/** (Re)invoke the plugin's self-test command until its SUMMARY satisfies the
	 *  predicate, then return that SUMMARY. Re-invoking covers sandbox-start and
	 *  live grant-change timing. */
	async function selfTestUntil(
		launched: LaunchedApp,
		runId: string,
		predicate: (s: Record<string, string>) => boolean
	): Promise<Record<string, string>> {
		let summary: Record<string, string> | null = null;
		await expect
			.poll(
				async () => {
					await launched.window.evaluate(
						(id) => window.maestro.plugins.invokeCommand(`${id}/selftest`).catch(() => undefined),
						PLUGIN_ID
					);
					summary = parseSelfTestSummary(launched.output(), runId);
					return summary && predicate(summary) ? 'ready' : null;
				},
				{
					timeout: 90_000,
					intervals: [1000, 2000, 3000, 5000],
					message: 'self-test SUMMARY never satisfied the predicate',
				}
			)
			.toBe('ready');
		if (!summary) throw new Error('no self-test summary captured');
		return summary;
	}

	async function teardown(launched: LaunchedApp, seeded: SeededEnv): Promise<void> {
		if (test.info().errors.length > 0) {
			console.log('--- captured Maestro output ---\n' + launched.output());
		}
		await launched.app.close();
		cleanup(seeded);
	}

	test('discovers a seeded plugin and default-denies every capability', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			const snap = await launched.window.evaluate(() => window.maestro.plugins.list());
			expect((snap?.plugins ?? []).find((p) => p.id === PLUGIN_ID)?.enabled).toBe(true);

			const summary = await selfTestUntil(launched, seeded.runId, complete);
			for (const cap of PROBED_CAPS) {
				expect(summary[cap], `${cap} should be DENY while ungranted`).toBe('DENY');
			}
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('full broker matrix: approved caps function, withheld stays denied', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			// Untrusted: withhold transcripts:read so the granted egress caps
			// (net:fetch / process:spawn) do not trip the mutual-exclusion rule.
			await approveConsent(launched, { withhold: ['transcripts:read'] });
			const s = await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');

			const shouldPass = [
				'fs:write',
				'fs:read',
				'agents:read',
				'notifications:toast',
				'settings:write',
				'settings:read',
				'sessions:read',
				'storage:write',
				'storage:read',
				'events:subscribe',
			];
			for (const cap of shouldPass) expect(s[cap], `${cap} should PASS once granted`).toBe('PASS');

			// Granted but host-side intentionally unwired (Phase-3 / deferred
			// command-registry keystone) -> broker allows, call is inert.
			for (const cap of ['agents:dispatch', 'ui:command', 'process:spawn']) {
				expect(s[cap], `${cap} should be INERT`).toBe('INERT');
			}

			// Network-dependent: broker allowed it (never DENY); PASS online / ERROR offline.
			expect(['PASS', 'ERROR'], 'net:fetch should be broker-allowed').toContain(s['net:fetch']);

			// Deliberately withheld at consent.
			expect(s['transcripts:read'], 'transcripts:read was withheld').toBe('DENY');
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('subscribed host events are delivered into the sandbox', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			// Grant events:subscribe (withhold transcripts to avoid the untrusted conflict).
			await approveConsent(launched, { withhold: ['transcripts:read'] });

			// Activation's subscribe was denied (pre-consent); re-subscribe now.
			await expect
				.poll(
					async () => {
						await launched.window.evaluate(
							(id) =>
								window.maestro.plugins.invokeCommand(`${id}/resubscribe`).catch(() => undefined),
							PLUGIN_ID
						);
						return launched.output().includes(`[e2e-selftest:${seeded.runId}] RESUBSCRIBED`);
					},
					{ timeout: 30_000, intervals: [1000, 2000, 3000], message: 'plugin never re-subscribed' }
				)
				.toBe(true);

			// Fire a real host session.updated (history-dir watcher) and assert the
			// plugin's handler actually received it.
			await expect
				.poll(
					() => {
						triggerSessionUpdated(seeded.demoDir, seeded.runId);
						return sawDeliveredEvent(launched.output(), seeded.runId, 'session.updated');
					},
					{
						timeout: 45_000,
						intervals: [1000, 2000, 3000],
						message: 'session.updated was never delivered to the plugin sandbox',
					}
				)
				.toBe(true);
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('contributions aggregate; uiItems/panels gate on grants; revoke re-denies', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);

			const readContrib = async (): Promise<Record<string, Array<{ pluginId?: string }>>> =>
				(await launched.window.evaluate(() =>
					window.maestro.plugins.contributions()
				)) as unknown as Record<string, Array<{ pluginId?: string }>>;
			const hasOurs = (c: Record<string, Array<{ pluginId?: string }>>, bucket: string): boolean =>
				(c[bucket] ?? []).some((i) => i.pluginId === PLUGIN_ID);

			// Tier-0 (ungated) buckets aggregate for an enabled plugin even ungranted.
			const before = await readContrib();
			for (const bucket of [
				'themes',
				'prompts',
				'settings',
				'commandMacros',
				'cueTriggers',
				'commands',
				'agents',
				'tools',
				'keybindings',
			]) {
				expect(hasOurs(before, bucket), `${bucket} should aggregate`).toBe(true);
			}
			// ui:contribute / ui:panel gate these -> absent while ungranted.
			expect(hasOurs(before, 'uiItems'), 'uiItems gated off pre-grant').toBe(false);
			expect(hasOurs(before, 'panels'), 'panels gated off pre-grant').toBe(false);

			// Grant ui:contribute + ui:panel (and the rest, minus transcripts).
			await approveConsent(launched, { withhold: ['transcripts:read'] });
			await expect
				.poll(
					async () => {
						const c = await readContrib();
						return hasOurs(c, 'uiItems') && hasOurs(c, 'panels');
					},
					{ timeout: 30_000, message: 'uiItems/panels never surfaced after granting' }
				)
				.toBe(true);

			// Revoke -> gated contributions disappear and the broker re-denies.
			await launched.window.evaluate((id) => window.maestro.plugins.revokeGrants(id), PLUGIN_ID);
			await expect
				.poll(async () => hasOurs(await readContrib(), 'uiItems'), {
					timeout: 30_000,
					message: 'uiItems never cleared after revoke',
				})
				.toBe(false);
			const s = await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'DENY');
			expect(s['fs:write'], 'broker re-denies after revoke').toBe('DENY');
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('untrusted transcripts+egress is consent-conflicted; a signed plugin is not', async () => {
		// Untrusted: approving transcripts:read together with egress (net:fetch /
		// process:spawn) is a mutual-exclusion conflict; the minter rejects the
		// WHOLE mint, so nothing is granted.
		const untrusted = createSeededEnv();
		await seedAll(untrusted, { enabled: true });
		const a = await launch(untrusted.env);
		try {
			await waitListed(a);
			await approveConsent(a, {}); // withhold nothing -> transcripts + egress conflict
			const s = await selfTestUntil(a, untrusted.runId, complete);
			expect(s['fs:write'], 'conflict rejects the entire mint -> nothing granted').toBe('DENY');
			expect(s['transcripts:read']).toBe('DENY');
		} finally {
			await teardown(a, untrusted);
		}

		// Trusted (signed): the same all-caps approval is conflict-free; the
		// content-read capability functions (empty for an unknown session).
		const trusted = createSeededEnv();
		await seedAll(trusted, { enabled: true, trusted: true });
		const b = await launch(trusted.env);
		try {
			await waitListed(b);
			await approveConsent(b, {}); // trusted lifts the transcripts+egress conflict
			const s = await selfTestUntil(b, trusted.runId, (x) => x['fs:write'] === 'PASS');
			expect(s['fs:write'], 'trusted mint succeeded').toBe('PASS');
			expect(s['transcripts:read'], 'transcripts:read functions when trusted').toBe('PASS');
		} finally {
			await teardown(b, trusted);
		}
	});
});
