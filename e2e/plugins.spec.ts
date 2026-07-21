/**
 * Plugin-system E2E - exercises the ENTIRE plugin interface end-to-end against
 * a real isolated Maestro (demo mode) with a seeded full-surface self-test
 * plugin and its real utilityProcess sandbox, under the FC1..FC8 contracts:
 *
 *  - FC1 Option-B trust gate: only a TRUSTED (signed by a trusted key) plugin
 *    ever runs code; a stranger-signed plugin stays declarative-only. Every
 *    enabled code plugin also needs a consented ledger mint - verifyRecord
 *    force-disables any enabled code plugin without one, so every test mints
 *    first (a zero-grant mint is a valid consent gesture).
 *  - FC2 act verbs: agents:dispatch / process:spawn ride a SEPARATE high-risk
 *    consent channel (default unchecked); grants are allowlist-scoped to the
 *    named agent/binary - off-scope targets DENY while the cap is granted.
 *  - FC3 scheduler: a cue dispatch trigger without the separate UNATTENDED
 *    consent is surfaced (notify) instead of auto-dispatched.
 *  - FC4 events: metadata-only payloads; capability-gated topics
 *    (history.entryAdded -> history:read, agent.completed -> agents:read)
 *    silence instantly when the gate cap is withheld.
 *  - FC5 background services: supervised crash-restart; deliberate disable
 *    stops cleanly (never treated as a crash).
 *  - FC6 panel render host: per-plugin webview guest; CSP kills in-guest
 *    fetch, window.open returns null, navigation is denied host-side; the
 *    postMessage bridge is the one sanctioned channel out.
 *  - Grant ledger: sealed grants persist across relaunch; revoke tombstones
 *    survive forged enable-state; a lost freshness anchor drops grants until
 *    a full re-consent re-mints.
 *
 * Results are read from the captured main-process output (the sandbox's
 * console.log is forwarded by the host logger), matched on a per-run id marker.
 *
 * Run: bunx playwright test e2e/plugins.spec.ts
 *   (build dist first: bun run build:main && bun run build:renderer &&
 *    bun run build:preload - preload carries consent.html + panel preloads)
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import {
	PLUGIN_ID,
	SEEDED_SESSION_ID,
	SPAWN_BINARY,
	ACT_CAPS,
	PROBED_CAPS,
	REQUESTED_CAPS,
	createSeededEnv,
	seedAll,
	seedPluginEnabledState,
	launch,
	relaunch,
	cleanup,
	approveConsent,
	parseSelfTestSummary,
	sawDeliveredEvent,
	deliveredEventPayload,
	triggerSessionUpdated,
	ledgerPath,
	readAnchor,
	deleteAnchor,
	type SeededEnv,
	type LaunchedApp,
} from './fixtures/plugin-harness';

/** Withheld from EVERY full-grant consent in this suite so a self-test run can
 * never open a real browser tab on the host (hermeticity > one PASS row). */
const WITHHOLD_SAFE = ['shell:openExternal'] as const;

/** The plain-channel caps (everything the manifest requests minus the act
 * verbs, which render in the separate high-risk section, default unchecked). */
const PLAIN_CAPS = REQUESTED_CAPS.filter((c) => !(ACT_CAPS as readonly string[]).includes(c));

/** Occurrences of a literal marker in the captured output. Used across the
 * FC5 assertions to prove "no NEW crash/summary appeared" - call-site count
 * comparisons must share one counting behavior. */
const countMarker = (output: string, marker: string): number => output.split(marker).length - 1;

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

	/** Fire-and-forget a plugin command from the renderer (errors swallowed -
	 * assertions are made on captured output, not the RPC ack). */
	async function invokePluginCommand(launched: LaunchedApp, local: string): Promise<void> {
		await launched.window.evaluate(
			({ id, cmd }) => window.maestro.plugins.invokeCommand(`${id}/${cmd}`).catch(() => undefined),
			{ id: PLUGIN_ID, cmd: local }
		);
	}

	async function teardown(launched: LaunchedApp, seeded: SeededEnv): Promise<void> {
		// A thrown assertion is not yet in test.info().errors inside `finally`
		// (and status is unset until the test fn returns), so a conditional
		// attach can never fire on the very failure it exists for. Write the
		// captured main-process output to the test's output dir UNCONDITIONALLY -
		// Playwright cleans outputDir per run, and a failure always carries the
		// sandbox log at e2e-results/<test>/maestro-output.txt.
		const info = test.info();
		const outPath = info.outputPath('maestro-output.txt');
		fs.writeFileSync(outPath, launched.output(), 'utf8');
		await info.attach('maestro-output', { path: outPath, contentType: 'text/plain' });
		await launched.app.close();
		cleanup(seeded);
	}

	test('trust gate: trusted plugin runs; a zero-grant mint default-denies every capability', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);

			// Boot invariant: the seeded enabled:true did NOT survive the refresh -
			// verifyRecord force-disables an enabled code plugin without a ledger
			// mint, however the on-disk enable-state was produced.
			const before = await launched.window.evaluate(() => window.maestro.plugins.list());
			expect(
				(before?.plugins ?? []).find((p) => p.id === PLUGIN_ID)?.enabled,
				'un-minted enabled state is force-disabled at refresh'
			).toBe(false);

			// Zero-grant mint: uncheck every plain cap; the act verbs are already
			// unchecked by default in the separate high-risk section. Consent (even
			// with nothing granted) IS the enable gesture.
			await approveConsent(launched, { withhold: PLAIN_CAPS });
			expect(launched.output()).toContain(`[Plugins] consent minted for "${PLUGIN_ID}": (none)`);
			await expect
				.poll(async () => {
					const snap = await launched.window.evaluate(() => window.maestro.plugins.list());
					return (snap?.plugins ?? []).find((p) => p.id === PLUGIN_ID)?.enabled;
				})
				.toBe(true);

			// The trusted sandbox runs - and every brokered probe is DENY.
			const summary = await selfTestUntil(launched, seeded.runId, (s) =>
				PROBED_CAPS.every((c) => typeof s[c] === 'string')
			);
			for (const cap of PROBED_CAPS) {
				expect(summary[cap], `${cap} should be DENY while ungranted`).toBe('DENY');
			}
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('full broker matrix: granted caps function; act verbs PASS in-scope, DENY off-scope', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			// Trusted lifts the transcripts+egress conflict; grant everything except
			// shell:openExternal (hermeticity), including BOTH act verbs via the
			// separate high-risk channel.
			await approveConsent(launched, { withhold: WITHHOLD_SAFE, highRisk: ACT_CAPS });
			const s = await selfTestUntil(
				launched,
				seeded.runId,
				(x) => PROBED_CAPS.every((c) => typeof x[c] === 'string') && x['process:spawn'] === 'PASS'
			);

			const shouldPass = [
				'fs:write',
				'fs:read',
				'fs:watch',
				'agents:read',
				'agents:dispatch',
				'notifications:toast',
				'settings:write',
				'settings:read',
				'sessions:read',
				'sessions:create',
				'sessions:write',
				'tabs:manage',
				'transcripts:write',
				'transcripts:read',
				'history:read',
				'storage:write',
				'storage:read',
				'storage:sql',
				'events:subscribe',
				'process:spawn',
				'decisions:write',
				'power:preventSleep',
				'background:service',
			];
			for (const cap of shouldPass) expect(s[cap], `${cap} should PASS once granted`).toBe('PASS');

			// Granted, but the probe invokes an unregistered palette command - the
			// broker allows the round-trip and the renderer registry says no.
			expect(s['ui:command'], 'noop palette command is INERT').toBe('INERT');

			// Network-dependent: broker allowed it (never DENY); PASS online / ERROR offline.
			expect(['PASS', 'ERROR'], 'net:fetch should be broker-allowed').toContain(s['net:fetch']);

			// Deliberately withheld at consent (suite hermeticity).
			expect(s['shell:openExternal'], 'shell:openExternal was withheld').toBe('DENY');

			const out = launched.output();

			// agents:dispatch PASS resolved the seeded session FAIL-CLOSED and audited it.
			expect(out).toContain(
				`agents.dispatch -> session ${SEEDED_SESSION_ID} (requested "${SEEDED_SESSION_ID}", 2 chars)`
			);

			// process:spawn PASS ran the ONE demo-blessed binary through the registry.
			expect(out).toContain('[Plugins] spawn binary blessed: e2e-selftest ->');
			expect(out).toContain(`process.spawn by "${PLUGIN_ID}": e2e-selftest (`);

			// Allowlist scope: with BOTH act verbs granted, an off-scope target is
			// still DENY - the grant covers only its exact named members (the
			// broker's scope check runs BEFORE the act-verb trust gate).
			expect(out).toContain(`[e2e-selftest:${seeded.runId}] ACT-OFFSCOPE agents:dispatch: DENY`);
			expect(out).toContain(`[e2e-selftest:${seeded.runId}] ACT-OFFSCOPE process:spawn: DENY`);
		} finally {
			await teardown(launched, seeded);
		}
	});

	// FC3: the scheduler polls its trigger set every 30s (PluginSchedulerHost's
	// non-configurable POLL_MS): first eligible tick seeds the interval, then
	// the trigger fires after everyMinutes elapses. This journey waits for the
	// observable host output instead of relying on a fixed delay.
	test('scheduler: dispatch trigger without unattended consent notifies instead', async () => {
		test.setTimeout(360_000);
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			// Grant agents:dispatch (high-risk channel) but NOT its nested
			// unattended consent - interactive dispatch works, scheduler must not.
			await approveConsent(launched, {
				withhold: WITHHOLD_SAFE,
				highRisk: ['agents:dispatch'],
			});
			await selfTestUntil(launched, seeded.runId, (x) => x['agents:dispatch'] === 'PASS');

			// The 1-minute interval trigger becomes eligible on the first post-mint
			// poll tick (seed), then fires a tick after everyMinutes elapses. The
			// gate verdict (no unattended consent) downgrades it to notify.
			await expect
				.poll(
					() =>
						launched
							.output()
							.includes(
								`[Plugins] cue trigger "${PLUGIN_ID}/e2e-dispatch-trigger" not auto-dispatched ` +
									'(unattended (scheduler-driven) dispatch requires the separate unattended ' +
									'consent - notifying instead)'
							),
					{
						timeout: 200_000,
						intervals: [5000, 10_000],
						message: 'scheduler never surfaced the unattended-consent denial',
					}
				)
				.toBe(true);
			// And the trigger did NOT reach the dispatch sink.
			expect(launched.output()).not.toContain(
				`agents.dispatch -> session ${SEEDED_SESSION_ID} (requested "${SEEDED_SESSION_ID}", 25 chars)`
			);
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('events: history.entryAdded is metadata-only; withholding history:read silences it', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });

			// Activation's subscribe was denied (pre-consent); re-subscribe now.
			await expect
				.poll(
					async () => {
						await invokePluginCommand(launched, 'resubscribe');
						return launched.output().includes(`[e2e-selftest:${seeded.runId}] RESUBSCRIBED`);
					},
					{ timeout: 60_000, intervals: [1000, 2000, 3000], message: 'plugin never re-subscribed' }
				)
				.toBe(true);

			// A REAL history entry added through the host IPC produces a
			// history.entryAdded delivery whose payload is ids/classification ONLY.
			const entryId = `e2e-hist-${seeded.runId}`;
			const secret = `SECRET-SUMMARY-${seeded.runId}`;
			await launched.window.evaluate(
				({ id, sessionId, scope, sum }) =>
					window.maestro.history.add({
						id,
						type: 'USER',
						timestamp: Date.now(),
						summary: sum,
						projectPath: scope,
						sessionId,
					}),
				{ id: entryId, sessionId: SEEDED_SESSION_ID, scope: seeded.scopeDir, sum: secret }
			);
			await expect
				.poll(
					() => {
						const p = deliveredEventPayload(launched.output(), seeded.runId, 'history.entryAdded');
						return p?.entryId === entryId;
					},
					{ timeout: 45_000, message: 'history.entryAdded never delivered' }
				)
				.toBe(true);
			const payload = deliveredEventPayload(launched.output(), seeded.runId, 'history.entryAdded');
			expect(payload).toMatchObject({ entryId, kind: 'USER', sessionId: SEEDED_SESSION_ID });
			// Metadata ONLY: the summary text never crosses into the sandbox.
			expect(payload).not.toHaveProperty('summary');
			expect(JSON.stringify(payload)).not.toContain(secret);

			// WITHHOLD history:read via a fresh mint (a re-mint REPLACES the grant
			// set; identity is unchanged so the sandbox and its bus subscription
			// survive). The gated topic must fall silent while ungated topics keep
			// delivering.
			await approveConsent(launched, { withhold: [...WITHHOLD_SAFE, 'history:read'] });
			const entryId2 = `e2e-hist2-${seeded.runId}`;
			await launched.window.evaluate(
				({ id, sessionId, scope }) =>
					window.maestro.history.add({
						id,
						type: 'USER',
						timestamp: Date.now(),
						summary: 'withheld-run entry',
						projectPath: scope,
						sessionId,
					}),
				{ id: entryId2, sessionId: SEEDED_SESSION_ID, scope: seeded.scopeDir }
			);
			// Ordering fence: session.updated (needs only events:subscribe) still
			// delivers - fire one AFTER the add and wait for it, so by the time it
			// lands the gated entryAdded delivery would already have happened.
			await expect
				.poll(
					() => {
						triggerSessionUpdated(seeded.demoDir, seeded.runId);
						return sawDeliveredEvent(launched.output(), seeded.runId, 'session.updated');
					},
					{
						timeout: 45_000,
						intervals: [1000, 2000, 3000],
						message: 'session.updated never delivered',
					}
				)
				.toBe(true);
			const p2 = deliveredEventPayload(launched.output(), seeded.runId, 'history.entryAdded');
			expect(
				p2?.entryId,
				'history.entryAdded must NOT deliver for the post-withhold entry'
			).not.toBe(entryId2);
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('events: agent.completed fires on real process exit with metadata only', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			// agent.completed is gated on agents:read (in addition to events:subscribe).
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			await expect
				.poll(
					async () => {
						await invokePluginCommand(launched, 'resubscribe');
						return launched.output().includes(`[e2e-selftest:${seeded.runId}] RESUBSCRIBED`);
					},
					{ timeout: 60_000, intervals: [1000, 2000, 3000], message: 'plugin never re-subscribed' }
				)
				.toBe(true);

			// Hermetic terminal trigger: spawn a PTY whose "shell" (hostname) exits
			// immediately -> ProcessManager 'exit' -> rich agent.completed.
			const doneSession = `e2e-agent-done-${seeded.runId}`;
			await launched.window.evaluate(
				({ sessionId, cwd, shell }) =>
					window.maestro.process.spawnTerminalTab({ sessionId, cwd, shell }).catch(() => undefined),
				{ sessionId: doneSession, cwd: seeded.scopeDir, shell: SPAWN_BINARY }
			);

			await expect
				.poll(
					() => {
						const p = deliveredEventPayload(launched.output(), seeded.runId, 'agent.completed');
						return p?.sessionId === doneSession;
					},
					{ timeout: 60_000, message: 'agent.completed never delivered for the spawned PTY' }
				)
				.toBe(true);
			const payload = deliveredEventPayload(launched.output(), seeded.runId, 'agent.completed');
			expect(payload?.sessionId).toBe(doneSession);
			expect(['completed', 'failed']).toContain(payload?.status);
			expect(typeof payload?.exitCode).toBe('number');
			expect(payload?.agentId, 'a PTY tab completes as the terminal agent').toBe('terminal');
			// Metadata ONLY - no output-bearing keys, ever.
			for (const k of ['stdout', 'stderr', 'output', 'summary', 'fullResponse', 'response']) {
				expect(payload, `agent.completed must not carry "${k}"`).not.toHaveProperty(k);
			}
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('untrusted (stranger-signed) plugin never runs code; declarative contributions survive', async () => {
		const seeded = createSeededEnv();
		// Signed with a key that is NOT in pluginTrustedKeys: signed-but-untrusted
		// must behave exactly like unsigned - never runs.
		await seedAll(seeded, { enabled: true, untrusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			// The ledger gate applies to untrusted too: mint first (withhold
			// transcripts:read so granted egress caps don't trip the untrusted
			// mutual-exclusion rule and reject the whole mint).
			await approveConsent(launched, { withhold: [...WITHHOLD_SAFE, 'transcripts:read'] });
			await expect
				.poll(async () => {
					const snap = await launched.window.evaluate(() => window.maestro.plugins.list());
					return (snap?.plugins ?? []).find((p) => p.id === PLUGIN_ID)?.enabled;
				})
				.toBe(true);

			// Tier-0 (declarative) contributions aggregate for the enabled plugin...
			const contrib = (await launched.window.evaluate(() =>
				window.maestro.plugins.contributions()
			)) as unknown as Record<string, Array<{ pluginId?: string }>>;
			for (const bucket of ['themes', 'prompts', 'settings', 'commands', 'keybindings']) {
				expect(
					(contrib[bucket] ?? []).some((i) => i.pluginId === PLUGIN_ID),
					`${bucket} should aggregate for an untrusted plugin`
				).toBe(true);
			}

			// ...but the sandbox NEVER starts: invokeCommand reports not-dispatched
			// and no self-test SUMMARY for this run ever appears.
			const res = await launched.window.evaluate(
				(id) => window.maestro.plugins.invokeCommand(`${id}/selftest`),
				PLUGIN_ID
			);
			expect(res.dispatched, 'untrusted plugin has no running sandbox').toBe(false);
			// Give a hypothetical (buggy) sandbox start a moment to betray itself.
			await launched.window.waitForTimeout(5000);
			expect(parseSelfTestSummary(launched.output(), seeded.runId)).toBeNull();
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('relaunch: sealed grants persist and the plugin runs again without re-consent', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		let launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');
			expect(fs.existsSync(ledgerPath(seeded)), 'sealed ledger persisted').toBe(true);

			// Quit + fresh boot against the same demo dir. NOTHING is re-seeded and
			// no consent window is driven: the sealed ledger + anchor alone must
			// restore the grants and start the sandbox.
			launched = await relaunch(launched, seeded);
			await waitListed(launched);
			const s = await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');
			expect(s['transcripts:read'], 'content grant survived the relaunch').toBe('PASS');
			expect(s['storage:sql'], 'sql grant survived the relaunch').toBe('PASS');
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('revoke + forged enable-state cannot resurrect a plugin; fresh consent can', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		let launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');

			// Revoke: drops the sealed grants (tombstone) AND disables the plugin.
			await launched.window.evaluate((id) => window.maestro.plugins.revokeGrants(id), PLUGIN_ID);
			await expect
				.poll(async () => {
					const g = await launched.window.evaluate(
						(id) => window.maestro.plugins.getGrants(id),
						PLUGIN_ID
					);
					return g.granted.length;
				})
				.toBe(0);

			// Attack: forge enabled:true into the plain-JSON enable-state file while
			// the app is down. The sealed ledger (tombstoned) is authoritative.
			await launched.app.close();
			seedPluginEnabledState(seeded.demoDir, true);
			launched = await launch(seeded.env);
			await waitListed(launched);
			expect(
				(await launched.window.evaluate(() => window.maestro.plugins.list())).plugins.find(
					(p) => p.id === PLUGIN_ID
				)?.enabled,
				'forged enable-state is force-disabled against the tombstoned ledger'
			).toBe(false);

			// The renderer cannot flip it back on either: no ledger authorization.
			const err = await launched.window.evaluate(
				(id) =>
					window.maestro.plugins
						.setEnabled(id, true)
						.then(() => null)
						.catch((e: Error) => String(e)),
				PLUGIN_ID
			);
			expect(err, 'renderer enable is rejected without a mint').toContain('PluginNotAuthorized');

			// Fresh consent clears the tombstone, re-mints, re-enables, and the
			// sandbox runs again.
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			const s = await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');
			expect(s['fs:read']).toBe('PASS');
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('lost keyring anchor drops grants; full re-consent recovers', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		let launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');
			expect(fs.existsSync(ledgerPath(seeded)), 'sealed ledger persisted').toBe(true);
			expect(readAnchor(seeded), 'freshness anchor established by the mint').not.toBeNull();

			// Simulate a lost/corrupt OS keyring entry: the sealed ledger file still
			// exists, but its freshness can no longer be proven.
			await launched.app.close();
			expect(deleteAnchor(seeded)).toBe(true);
			launched = await launch(seeded.env);
			await waitListed(launched);

			// Unprovable ledger -> grants dropped -> force-disabled; the renderer
			// cannot re-enable without a fresh mint.
			expect(
				(await launched.window.evaluate(() => window.maestro.plugins.list())).plugins.find(
					(p) => p.id === PLUGIN_ID
				)?.enabled,
				'plugin is force-disabled when the ledger freshness anchor is gone'
			).toBe(false);
			const grants = await launched.window.evaluate(
				(id) => window.maestro.plugins.getGrants(id),
				PLUGIN_ID
			);
			expect(grants.granted, 'grants are dropped, not partially trusted').toEqual([]);

			// Full re-consent re-mints and re-establishes the anchor.
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			const s = await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');
			expect(s['storage:read']).toBe('PASS');
			expect(readAnchor(seeded), 'fresh mint re-established the anchor').not.toBeNull();
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('background services: supervised crash-restart; deliberate disable stops cleanly', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		const crashMarker = `[Plugins] plugin "${PLUGIN_ID}" crashed (code `;
		const summaryMarker = `[e2e-selftest:${seeded.runId}] SUMMARY `;
		try {
			await waitListed(launched);
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			await selfTestUntil(launched, seeded.runId, (x) => x['background:service'] === 'PASS');

			// Register a LONG-LIVED service (no unregister) so the sandbox child is
			// under supervision when it crashes.
			await expect
				.poll(
					async () => {
						await invokePluginCommand(launched, 'bgstart');
						return launched.output().includes(`[e2e-selftest:${seeded.runId}] BGSTART {`);
					},
					{ timeout: 30_000, intervals: [1000, 2000], message: 'bgstart never registered' }
				)
				.toBe(true);

			const summariesBeforeCrash = countMarker(launched.output(), summaryMarker);

			// Crash the sandbox for real (host-realm timer throw -> nonzero exit).
			await invokePluginCommand(launched, 'crashprobe');
			await expect
				.poll(() => launched.output().includes(crashMarker), {
					timeout: 30_000,
					message: 'sandbox crash was never observed',
				})
				.toBe(true);

			// Supervised restart: refresh() re-runs activate(), whose self-test
			// prints a NEW SUMMARY for this run - restart proof, not a stale line.
			await expect
				.poll(() => countMarker(launched.output(), summaryMarker), {
					timeout: 60_000,
					intervals: [1000, 2000, 3000],
					message: 'crashed plugin was never restarted by the supervisor',
				})
				.toBeGreaterThan(summariesBeforeCrash);

			// The restarted child re-registers on demand and reports healthy.
			await expect
				.poll(
					async () => {
						await invokePluginCommand(launched, 'bgstart');
						await invokePluginCommand(launched, 'bgstat');
						const marker = `[e2e-selftest:${seeded.runId}] BGSTAT `;
						const lines = launched
							.output()
							.split(/\r?\n/)
							.filter((l) => l.includes(marker));
						if (lines.length === 0) return null;
						const last = lines[lines.length - 1];
						try {
							const health = JSON.parse(last.slice(last.indexOf(marker) + marker.length)) as {
								state?: string;
								services?: Array<{ id?: string }>;
							};
							return health.state === 'running' &&
								(health.services ?? []).some((s) => s.id === 'e2e-live-svc')
								? 'healthy'
								: null;
						} catch {
							return null;
						}
					},
					{
						timeout: 60_000,
						intervals: [1000, 2000, 3000],
						message: 'restarted plugin never reported a healthy supervised service',
					}
				)
				.toBe('healthy');

			// Deliberate disable: onPluginStopped clears supervision BEFORE the
			// child exits - no crash line, no restart (no new SUMMARY) in a grace
			// window comfortably past the 1s restart backoff.
			const crashesBefore = countMarker(launched.output(), crashMarker);
			const summariesBefore = countMarker(launched.output(), summaryMarker);
			await launched.window.evaluate(
				(id) => window.maestro.plugins.setEnabled(id, false),
				PLUGIN_ID
			);
			await expect
				.poll(async () => {
					const snap = await launched.window.evaluate(() => window.maestro.plugins.list());
					return (snap?.plugins ?? []).find((p) => p.id === PLUGIN_ID)?.enabled;
				})
				.toBe(false);
			await launched.window.waitForTimeout(8000);
			expect(
				countMarker(launched.output(), crashMarker),
				'a deliberate stop must never be classified as a crash'
			).toBe(crashesBefore);
			expect(
				countMarker(launched.output(), summaryMarker),
				'a disabled plugin must not be restarted'
			).toBe(summariesBefore);
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('panel render host: isolated webview; fetch/popup/navigation blocked; bridge delivers', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);

			const readContrib = async (): Promise<Record<string, Array<{ pluginId?: string }>>> =>
				(await launched.window.evaluate(() =>
					window.maestro.plugins.contributions()
				)) as unknown as Record<string, Array<{ pluginId?: string }>>;
			const hasOurs = (c: Record<string, Array<{ pluginId?: string }>>, bucket: string): boolean =>
				(c[bucket] ?? []).some((i) => i.pluginId === PLUGIN_ID);

			// Mint WITHOUT ui:panel: the plugin is enabled (tier-0 buckets aggregate)
			// but the grant-gated panels bucket stays empty.
			await approveConsent(launched, { withhold: [...WITHHOLD_SAFE, 'ui:panel'] });
			await expect
				.poll(async () => hasOurs(await readContrib(), 'themes'), {
					timeout: 30_000,
					message: 'contributions never aggregated post-mint',
				})
				.toBe(true);
			expect(hasOurs(await readContrib(), 'panels'), 'panels gated off without ui:panel').toBe(
				false
			);

			// Re-mint WITH ui:panel: the left-docked panel surfaces and the slot
			// renders it in a per-plugin webview guest.
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			await expect
				.poll(async () => hasOurs(await readContrib(), 'panels'), {
					timeout: 30_000,
					message: 'panels never surfaced after granting ui:panel',
				})
				.toBe(true);

			const slot = launched.window.locator('[data-plugin-panel-slot="left"]');
			await expect(slot).toBeVisible({ timeout: 30_000 });
			// Non-suppressible provenance line above the frame.
			await expect(slot.getByText(`from ${PLUGIN_ID}`)).toBeVisible();
			// The guest is an Electron <webview> with the per-plugin partition and
			// the plugin-panel:// document URL (never srcdoc/first-party origin).
			const webview = slot.locator('webview');
			await expect(webview).toHaveAttribute('partition', `plugin:${PLUGIN_ID}`);
			await expect(webview).toHaveAttribute(
				'src',
				`plugin-panel://panel/${encodeURIComponent(`${PLUGIN_ID}/demo-panel`)}`
			);

			// In-guest lockdown, reported over the ONE sanctioned channel (the
			// postMessage bridge -> panelprobe command -> host log). CSP kills fetch
			// BEFORE webRequest sees it, and window.open returns null in-guest, so
			// the bridge report is the honest assertion for both.
			const bridgeMarker = `[e2e-selftest:${seeded.runId}] PANEL-BRIDGE `;
			await expect
				.poll(
					() => {
						const lines = launched
							.output()
							.split(/\r?\n/)
							.filter((l) => l.includes(bridgeMarker));
						if (lines.length === 0) return null;
						const last = lines[lines.length - 1];
						try {
							return JSON.parse(last.slice(last.indexOf(bridgeMarker) + bridgeMarker.length));
						} catch {
							return null;
						}
					},
					{ timeout: 60_000, message: 'panel bridge probe never reached the sandbox' }
				)
				.toEqual({ fetchBlocked: true, popupBlocked: true });

			// Host-side navigation guard: the probe's location.href attempt is
			// denied in the main process and audited. Electron may surface the
			// guest top-frame attempt as will-navigate OR will-frame-navigate
			// (observed: will-frame-navigate); the SAME denyNavigation guard
			// handles both - the contract is "denied + audited", not the event name.
			await expect
				.poll(
					() =>
						/Blocked panel will-(frame-)?navigate: https:\/\/example\.com\/panel-nav/.test(
							launched.output()
						),
					{ timeout: 30_000, message: 'panel navigation was never blocked host-side' }
				)
				.toBe(true);
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('ui:command invokes a real palette command', async () => {
		// The renderer command registry is the SINGLE source for both the command
		// palette and the `ui:command` host verb: invoking
		// `maestro.commandPalette.open` reaches the exact entry the palette lists.
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });

			// The dedicated probe logs one run-scoped marker per invocation:
			//   [e2e-selftest:<runId>] UICMD <PASS|INERT|DENY|ERROR>
			const marker = `[e2e-selftest:${seeded.runId}] UICMD `;
			const lastUicmdResult = (): string | undefined =>
				launched
					.output()
					.split('\n')
					.filter((l) => l.includes(marker))
					.map((l) => l.slice(l.indexOf(marker) + marker.length).trim())
					.pop();

			await expect
				.poll(
					async () => {
						await invokePluginCommand(launched, 'uicmdprobe');
						return lastUicmdResult() ?? null;
					},
					{
						timeout: 90_000,
						intervals: [1000, 2000, 3000, 5000],
						message: 'ui:command probe never reported PASS (host registry bridge unwired?)',
					}
				)
				.toBe('PASS');

			// The probe's command opens the command palette: assert the palette now
			// lists the very command the plugin invoked (shared registry).
			await invokePluginCommand(launched, 'uicmdprobe');
			await expect(
				launched.window.getByText('Open Command Palette', { exact: true }).first()
			).toBeVisible({ timeout: 15_000 });
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('plugin keybinding dispatches its command', async () => {
		// A contributed KeybindingContribution (Ctrl+Shift+F9 -> `keybind-probe`)
		// is bound by the renderer's usePluginKeybindings hook; firing the real
		// chord must route into the sandbox, which logs a run-scoped marker.
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		try {
			await waitListed(launched);
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			// Sandbox must be live for the command to land.
			await selfTestUntil(launched, seeded.runId, (x) => x['fs:write'] === 'PASS');

			const marker = `[e2e-selftest:${seeded.runId}] KEYBIND-FIRED`;
			await expect
				.poll(
					async () => {
						// Move focus off any text input so the hook does not skip the chord
						// (it intentionally ignores keydowns while a field is focused).
						await launched.window.evaluate(() => {
							const el = document.activeElement;
							if (el instanceof HTMLElement) el.blur();
						});
						await launched.window.keyboard.press('Control+Shift+F9');
						return launched.output().includes(marker);
					},
					{
						timeout: 90_000,
						intervals: [1000, 2000, 3000, 5000],
						message: 'plugin keybinding never dispatched its command into the sandbox',
					}
				)
				.toBe(true);
		} finally {
			await teardown(launched, seeded);
		}
	});

	test('extensions marketplace lists, filters, and manages plugins', async () => {
		const seeded = createSeededEnv();
		await seedAll(seeded, { enabled: true, trusted: true });
		const launched = await launch(seeded.env);
		const page = launched.window;
		try {
			await waitListed(launched);
			// Consent-first: an un-minted code plugin is force-disabled at boot; the
			// mint enables it, which is the state the management assertions expect.
			await approveConsent(launched, { withhold: WITHHOLD_SAFE });
			const isEnabled = async (): Promise<boolean | undefined> => {
				const snap = await page.evaluate(() => window.maestro.plugins.list());
				return (snap?.plugins ?? []).find((p) => p.id === PLUGIN_ID)?.enabled;
			};
			await expect.poll(isEnabled, { timeout: 30_000 }).toBe(true);

			// Open Settings by driving the real app shortcut handler (Ctrl/Cmd+,),
			// then switch to the Encore tab, which hosts the Extensions view.
			await expect
				.poll(
					async () => {
						await page.evaluate(() =>
							window.dispatchEvent(
								new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })
							)
						);
						return page.locator('[aria-label="Settings"]').count();
					},
					{ timeout: 30_000, intervals: [500, 1000, 1500], message: 'Settings modal never opened' }
				)
				.toBeGreaterThan(0);

			await page.locator('button[title="Encore Features"]').click();
			const view = page.locator('[data-testid="extensions-view"]');
			await expect(view).toBeVisible();

			// The seeded plugin renders as a tile with its category badge.
			const card = view.locator(`[data-testid="extension-card"][data-extension-id="${PLUGIN_ID}"]`);
			await expect(card).toHaveCount(1);
			await expect(card.locator('[data-testid="extension-category"]')).toContainText('Dev Tools');

			// The category filter narrows the grid: 'data' hides the devtools plugin,
			// 'devtools' surfaces it again.
			await view.locator('[data-testid="extensions-filter"][data-category="data"]').click();
			await expect(card).toHaveCount(0);
			await view.locator('[data-testid="extensions-filter"][data-category="devtools"]').click();
			await expect(card).toHaveCount(1);
			await view.locator('[data-testid="extensions-filter"][data-category="all"]').click();
			await expect(card).toHaveCount(1);

			// The "only installed" toggle hides not-installed built-ins (e.g. the
			// disabled Director's Notes feature) but keeps the enabled plugin.
			const offBuiltin = view.locator(
				'[data-testid="extension-card"][data-extension-id="directorNotes"]'
			);
			await expect(offBuiltin).toHaveCount(1);
			await expect(offBuiltin.locator('[data-testid="extension-state"]')).toContainText(
				'Not installed'
			);
			await view.locator('[data-testid="extensions-only-installed"]').click();
			await expect(offBuiltin).toHaveCount(0);
			await expect(card).toHaveCount(1);
			await view.locator('[data-testid="extensions-only-installed"]').click();
			await expect(offBuiltin).toHaveCount(1);

			// ── First-party Encore tiles (L6 management-surface contract) ─────
			// All five first-party features render as tiles with a category badge
			// and a state pill driven by the Encore flags (demo defaults:
			// usageStats + symphony ON, the rest OFF).
			const FIRST_PARTY_TILES: ReadonlyArray<{
				flag: string;
				category: string;
				state: string;
			}> = [
				{ flag: 'usageStats', category: 'Insights', state: 'Enabled' },
				{ flag: 'symphony', category: 'Agents', state: 'Enabled' },
				{ flag: 'maestroCue', category: 'Automation', state: 'Not installed' },
				{ flag: 'directorNotes', category: 'Insights', state: 'Not installed' },
				{ flag: 'pianola', category: 'Agents', state: 'Not installed' },
			];
			for (const tile of FIRST_PARTY_TILES) {
				const t = view.locator(`[data-testid="extension-card"][data-extension-id="${tile.flag}"]`);
				await expect(t).toHaveCount(1);
				await expect(t).toHaveAttribute('data-extension-kind', 'builtin');
				await expect(t.locator('[data-testid="extension-category"]')).toContainText(tile.category);
				await expect(t.locator('[data-testid="extension-state"]')).toContainText(tile.state);
			}

			// First-party details: static permission disclosure rows (declared
			// capabilities, "Granted on enable") + the supervised background
			// service row for a feature that has one (cue.engine), Stopped while
			// the feature is off.
			const cueCard = view.locator(
				'[data-testid="extension-card"][data-extension-id="maestroCue"]'
			);
			await cueCard.click();
			const fpDetails = view.locator('[data-testid="extension-details"]');
			await expect(fpDetails).toBeVisible();
			await expect(
				fpDetails.locator('[data-testid="extension-permission"][data-cap="fs:watch"]')
			).toHaveCount(1);
			expect(
				await fpDetails.locator('[data-testid="extension-permission"]').count()
			).toBeGreaterThan(1);
			await expect(
				fpDetails.locator('[data-testid="extension-permission-status"]').first()
			).toHaveText('Granted on enable');
			const serviceRow = fpDetails.locator(
				'[data-testid="extension-background-service"][data-service="cue.engine"]'
			);
			await expect(serviceRow).toHaveCount(1);
			await expect(
				serviceRow.locator('[data-testid="extension-background-service-status"]')
			).toHaveText('Stopped');

			// Toggling the tile routes through the first-party lifecycle bridge:
			// the flag flips in the MAIN-process settings store AND the declared
			// grants are minted into the sealed ledger (a bare settings write
			// could flip the flag but never mint).
			const readCueState = async (): Promise<{ flag: unknown; grants: number }> =>
				page.evaluate(async () => {
					const encore = (await window.maestro.settings.get('encoreFeatures')) as Record<
						string,
						unknown
					> | null;
					const grants = await window.maestro.plugins.getGrants('com.maestro.cue');
					return { flag: encore?.maestroCue, grants: grants.granted.length };
				});
			const before = await readCueState();
			expect(before.flag === false || before.flag === undefined).toBe(true);

			await fpDetails.locator('[data-testid="extension-enable-toggle"]').click();
			await expect
				.poll(async () => (await readCueState()).flag, {
					timeout: 15_000,
					message: 'maestroCue flag never flipped on through the bridge',
				})
				.toBe(true);
			expect((await readCueState()).grants).toBeGreaterThan(0);
			// The supervised service row reflects the enabled state.
			await expect(
				serviceRow.locator('[data-testid="extension-background-service-status"]')
			).toHaveText('Running (supervised)');

			// Disable stops the supervised work and clears the flag (grants are
			// kept - disable is not revoke).
			await fpDetails.locator('[data-testid="extension-enable-toggle"]').click();
			await expect
				.poll(async () => (await readCueState()).flag, {
					timeout: 15_000,
					message: 'maestroCue flag never flipped back off',
				})
				.toBe(false);
			await expect(
				serviceRow.locator('[data-testid="extension-background-service-status"]')
			).toHaveText('Stopped');
			await fpDetails.locator('[data-testid="extension-details-back"]').click();

			// The details view lists the plugin's requested permissions.
			await card.click();
			const details = view.locator('[data-testid="extension-details"]');
			await expect(details).toBeVisible();
			await expect(
				details.locator('[data-testid="extension-permission"][data-cap="fs:write"]')
			).toHaveCount(1);
			expect(await details.locator('[data-testid="extension-permission"]').count()).toBeGreaterThan(
				1
			);

			// Configure renders SettingContribution controls and persists writes under
			// the plugin-owned settings namespace. Re-opening the details editor reads
			// the persisted value back instead of the manifest default.
			const readDemoSetting = async (): Promise<unknown> =>
				page.evaluate((id) => window.maestro.settings.get(`plugins.${id}.demoFlag`), PLUGIN_ID);
			await details.locator('[data-testid="extension-configure"]').click();
			const settingInput = details.locator(
				'[data-testid="extension-setting-input"][data-key="demoFlag"]'
			);
			await expect(settingInput).toBeVisible();
			await expect(settingInput).toBeChecked();
			await settingInput.uncheck();
			await expect.poll(readDemoSetting, { timeout: 5_000 }).toBe(false);

			await details.locator('[data-testid="extension-details-back"]').click();
			await card.click();
			await details.locator('[data-testid="extension-configure"]').click();
			await expect(settingInput).not.toBeChecked();

			// Disabling is immediate (no consent round-trip).
			const toggle = details.locator('[data-testid="extension-enable-toggle"]');
			await toggle.click();
			await expect
				.poll(isEnabled, { timeout: 30_000, message: 'plugin never disabled' })
				.toBe(false);

			// Disabling removes the configure surface and any stale setting control, so
			// a revoked plugin cannot keep mutating settings through an old editor.
			await expect(details.locator('[data-testid="extension-configure"]')).toHaveCount(0);
			await expect(settingInput).toHaveCount(0);
			await expect.poll(readDemoSetting, { timeout: 5_000 }).toBe(false);

			// Re-enabling a tier-1 plugin routes through the host-owned consent
			// window again (a fresh mint replaces the prior grants).
			const consentPromise = launched.app.waitForEvent('window', { timeout: 30_000 });
			await toggle.click();
			const consent = await consentPromise;
			await consent.waitForLoadState('domcontentloaded');
			await consent.locator('button.btn-approve').waitFor({ state: 'visible', timeout: 15_000 });
			await consent.locator(`.cap-check[data-cap="shell:openExternal"]`).uncheck();
			await consent.locator('button.btn-approve').click();
			await consent.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);

			await expect
				.poll(isEnabled, { timeout: 30_000, message: 'plugin never re-enabled' })
				.toBe(true);
		} finally {
			await teardown(launched, seeded);
		}
	});
});
