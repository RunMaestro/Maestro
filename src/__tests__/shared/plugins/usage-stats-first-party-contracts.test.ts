// Source: src/__tests__/shared/plugins/usage-stats-first-party-plugin.test.ts
// Source: src/__tests__/shared/plugins/contributions-tools.test.ts
// Source: src/__tests__/shared/plugins/events.test.ts
// Source: src/__tests__/shared/plugins/publisher-keys.test.ts
// Source: src/__tests__/shared/plugins/contribution-registry.test.ts
// Source: src/__tests__/main/plugins/usage-stats-sampler-lifecycle.test.ts
import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { parsePermissions } from '../../../shared/plugins/permissions';
import { grantsFromRequests } from '../../../shared/plugins/permissions';
import { isPermitted } from '../../../shared/plugins/permissions';
import { FIRST_PARTY_PLUGINS } from '../../../shared/plugins/first-party';
import { USAGE_STATS_FIRST_PARTY_PLUGIN } from '../../../shared/plugins/first-party';
import { hasRequiredFirstPartyGrants } from '../../../main/plugins/first-party-bridge';
import { collectContributions } from '../../../shared/plugins/contributions';
import { aggregateContributions } from '../../../shared/plugins/contributions';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';
import { isPluginEventTopic } from '../../../shared/plugins/events';
import { PLUGIN_EVENT_TOPICS } from '../../../shared/plugins/events';
import type { PluginEventPayloads } from '../../../shared/plugins/events';
import { createPublicKey } from 'crypto';
import { MAESTRO_PUBLISHER_KEYS } from '../../../shared/plugins/publisher-keys';
import { resolveTrustedKeys } from '../../../shared/plugins/publisher-keys';
import { mergeContributions } from '../../../shared/plugins/contribution-registry';
import { mergedItems } from '../../../shared/plugins/contribution-registry';
import type { RegistryEntry } from '../../../shared/plugins/contribution-registry';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { UsageRefreshScheduler } from '../../../main/agents/usage-refresh-scheduler';
import type { UsageRefreshSchedulerDeps } from '../../../main/agents/usage-refresh-scheduler';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { FirstPartyPluginBridge } from '../../../main/plugins/first-party-bridge';
const { runClaudeMock, runCodexMock } = vi.hoisted(() => ({
	runClaudeMock: vi.fn(),
	runCodexMock: vi.fn(),
}));
vi.mock('../../../main/agents/claude-usage-startup', () => ({
	runStartupUsageSampling: runClaudeMock,
}));
vi.mock('../../../main/agents/codex-usage-startup', () => ({
	runCodexUsageSampling: runCodexMock,
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

__maestroMicrobenchDescribe('usage-stats-first-party-plugin', () => {
	describe('Usage & Stats first-party plugin definition', () => {
		it('declares Usage & Stats as a first-party plugin-backed insights extension', () => {
			expect(USAGE_STATS_FIRST_PARTY_PLUGIN).toMatchObject({
				id: 'com.maestro.usage-stats',
				name: 'Usage & Stats',
				firstParty: true,
				category: 'insights',
				settingsNamespace: 'usageStats',
				encoreFlag: 'usageStats',
			});
			expect(FIRST_PARTY_PLUGINS.usageStats).toBe(USAGE_STATS_FIRST_PARTY_PLUGIN);
		});

		it('requests only valid broker capabilities the feature actually touches', () => {
			const parsed = parsePermissions(USAGE_STATS_FIRST_PARTY_PLUGIN.permissions);
			expect(parsed.errors).toEqual([]);
			expect(parsed.requests.map((p) => [p.capability, p.scope ?? null])).toEqual([
				['settings:read', null],
				['sessions:read', null],
				['agents:read', null],
				// WakaTime CLI auto-install: release lookup on github.com, asset
				// download redirected to the githubusercontent.com CDN.
				['net:fetch', 'github.com'],
				['net:fetch', 'githubusercontent.com'],
				// Cue telemetry batches (dual-gated on usageStats AND maestroCue).
				['net:fetch', 'runmaestro.ai'],
				['background:service', null],
			]);
			expect(
				parsed.requests.every((p) => typeof p.reason === 'string' && p.reason.length > 0)
			).toBe(true);
		});

		it('never claims host-owned surfaces as broker capabilities', () => {
			const caps = USAGE_STATS_FIRST_PARTY_PLUGIN.permissions.map((p) => p.capability);
			// The stats DB is HOST-OWNED SQLite, not the plugin's own brokered
			// store - claiming storage:* would be dishonest (see first-party.ts NOTE).
			expect(caps).not.toContain('storage:sql');
			expect(caps).not.toContain('storage:read');
			expect(caps).not.toContain('storage:write');
			// The feature never reads the history store; it records into its own DB.
			expect(caps).not.toContain('history:read');
			// Sampler/WakaTime spawns are host-owned; act verbs never ride the
			// bundled first-party mint.
			expect(caps).not.toContain('process:spawn');
			expect(caps).not.toContain('agents:dispatch');
			// CSV export goes through the user-driven OS save dialog only.
			expect(caps).not.toContain('fs:write');
		});

		it('registers the stats.sampler supervised background service', () => {
			expect(USAGE_STATS_FIRST_PARTY_PLUGIN.backgroundServices).toEqual([
				{
					id: 'stats.sampler',
					kind: 'supervised',
					description: expect.stringContaining('sampling loop'),
				},
			]);
			// The service declaration is backed by the matching broker capability.
			expect(USAGE_STATS_FIRST_PARTY_PLUGIN.permissions.map((p) => p.capability)).toContain(
				'background:service'
			);
		});

		it('scoped net:fetch grants minted from the declaration satisfy it (bridge round-trip)', () => {
			// The bridge minter turns requests into grants verbatim; a scoped
			// request must be satisfied by its own scoped grant, or enable()
			// would fail closed forever.
			const grants = grantsFromRequests([...USAGE_STATS_FIRST_PARTY_PLUGIN.permissions], 1000);
			expect(hasRequiredFirstPartyGrants(USAGE_STATS_FIRST_PARTY_PLUGIN, grants)).toBe(true);
			// And the scoped grants stay scoped: a foreign host is NOT permitted.
			expect(isPermitted(grants, 'net:fetch', 'api.github.com')).toBe(true); // subdomain of github.com
			expect(isPermitted(grants, 'net:fetch', 'evil.example.com')).toBe(false);
		});
	});
});
__maestroMicrobenchDescribe('contributions-tools', () => {
	function manifest(
		id: string,
		contributes: Record<string, unknown> | undefined,
		tier: 0 | 1 | 2 = 0
	): PluginManifest {
		return {
			id,
			name: id,
			version: '1.0.0',
			tier,
			maestro: { minHostApi: '1.0.0' },
			...(contributes ? { contributes } : {}),
		};
	}

	describe('tool contributions', () => {
		it('parses and namespaces a tier-1 tool contribution', () => {
			const out = collectContributions(
				manifest(
					'p',
					{
						tools: [
							{
								id: 'lookup',
								name: 'Lookup',
								description: 'Look something up',
								inputSchema: { type: 'object' },
							},
						],
					},
					1
				)
			);
			expect(out.errors).toEqual([]);
			expect(out.tools).toHaveLength(1);
			expect(out.tools[0]).toMatchObject({
				id: 'p/lookup',
				localId: 'lookup',
				pluginId: 'p',
				name: 'Lookup',
				description: 'Look something up',
				inputSchema: { type: 'object' },
			});
		});

		it('rejects tools for a tier-0 plugin (they run code)', () => {
			const out = collectContributions(
				manifest('p', { tools: [{ id: 'lookup', name: 'Lookup', description: 'd' }] }, 0)
			);
			expect(out.tools).toHaveLength(0);
			expect(out.errors.some((e) => e.includes('tools require tier'))).toBe(true);
		});

		it('aggregates tools across plugins under errorsByPlugin', () => {
			const a = manifest('a', { tools: [{ id: 'one', name: 'One', description: 'd' }] }, 1);
			const b = manifest('b', { tools: [{ id: 'two', name: 'Two', description: 'd' }] }, 1);
			const agg = aggregateContributions([a, b]);
			expect(agg.tools.map((t) => t.id).sort()).toEqual(['a/one', 'b/two']);
			expect(agg.errorsByPlugin).toEqual({});
		});
	});
});
__maestroMicrobenchDescribe('events', () => {
	describe('plugin event topics', () => {
		it('recognizes exactly the catalog topics', () => {
			for (const t of PLUGIN_EVENT_TOPICS) expect(isPluginEventTopic(t)).toBe(true);
			expect(isPluginEventTopic('')).toBe(false);
			expect(isPluginEventTopic(42)).toBe(false);
			expect(isPluginEventTopic('not.a.topic')).toBe(false);
		});

		it('catalog carries NO raw-content topic (metadata-only guarantee)', () => {
			// A plugin must never receive message bodies / agent output over the bus.
			expect(PLUGIN_EVENT_TOPICS).not.toContain('agent.output');
			expect(PLUGIN_EVENT_TOPICS).not.toContain('session.message');
			expect(PLUGIN_EVENT_TOPICS).not.toContain('transcript.appended');
		});

		it('carries session.activated as an ids-only focus signal', () => {
			expect(PLUGIN_EVENT_TOPICS).toContain('session.activated');
			const activated: PluginEventPayloads['session.activated'] = { sessionId: 's1' };
			expect(activated.sessionId).toBe('s1');
			// tabId is optional; nothing derived from the session's content rides along.
			const withTab: PluginEventPayloads['session.activated'] = { sessionId: 's1', tabId: 't1' };
			expect(Object.keys(withTab).sort()).toEqual(['sessionId', 'tabId']);
		});

		it('agent.completed payload supports rich metadata without raw output', () => {
			const completed: PluginEventPayloads['agent.completed'] = {
				sessionId: 's1',
				agentId: 'claude',
				tabId: 's1',
				status: 'completed',
				providerSessionId: 'provider-session-1',
				queueDepth: 2,
				inputTokens: 100,
				outputTokens: 25,
				cacheReadInputTokens: 10,
				cacheCreationInputTokens: 5,
				reasoningTokens: 3,
				totalTokens: 143,
				runId: 'run-1',
				parentRunId: 'run-0',
				chainRootId: 'root-1',
				parentEventId: 'event-0',
				pipelineId: 'pipe-1',
				pipelineName: 'Review',
				lineageDepth: 3,
			};

			expect(completed.providerSessionId).toBe('provider-session-1');
			expect(completed.queueDepth).toBe(2);
			expect(completed.totalTokens).toBe(143);
			expect(completed.chainRootId).toBe('root-1');
		});
	});
});
__maestroMicrobenchDescribe('publisher-keys', () => {
	describe('MAESTRO_PUBLISHER_KEYS', () => {
		it('bakes only well-formed base64 SPKI public keys as the trust anchor', () => {
			// The anchor must stay populated: an accidental future emptying would
			// silently revert to pre-A1 behavior (no bundled plugin ever seeds).
			expect(MAESTRO_PUBLISHER_KEYS.length).toBeGreaterThan(0);
			// Proves every anchor entry is a non-empty, valid SPKI key crypto can
			// load - never hard-coding the real key value here.
			for (const key of MAESTRO_PUBLISHER_KEYS) {
				expect(typeof key).toBe('string');
				expect(key.trim().length).toBeGreaterThan(0);
				// Node decodes base64 leniently (padding/whitespace/url-safe), so a
				// baked string that is not canonical could still load. Round-trip the
				// DER bytes back to base64 and require an exact match to reject any
				// non-canonical anchor.
				const der = Buffer.from(key, 'base64');
				expect(der.toString('base64')).toBe(key);
				const publicKey = createPublicKey({
					key: der,
					format: 'der',
					type: 'spki',
				});
				// The plugin signing scheme is ed25519 (SIGNATURE_ALGORITHM), so the
				// anchor must be an ed25519 public key, not merely any valid SPKI key.
				expect(publicKey.asymmetricKeyType).toBe('ed25519');
			}
		});
	});

	describe('resolveTrustedKeys', () => {
		it('unions the built-in publisher anchor with user keys, trimmed and de-duplicated', () => {
			expect(resolveTrustedKeys(['userA', '  userB  ', 'userA', ''])).toEqual([
				...MAESTRO_PUBLISHER_KEYS,
				'userA',
				'userB',
			]);
		});

		it('returns just the anchor when there are no user keys', () => {
			expect(resolveTrustedKeys([])).toEqual([...MAESTRO_PUBLISHER_KEYS]);
		});

		it('drops blank and whitespace-only user keys', () => {
			expect(resolveTrustedKeys(['', '   '])).toEqual([...MAESTRO_PUBLISHER_KEYS]);
		});
	});
});
__maestroMicrobenchDescribe('contribution-registry', () => {
	interface Item extends RegistryEntry {
		label: string;
	}
	const mk = (id: string, label = id): Item => ({ id, label });

	describe('mergeContributions', () => {
		it('keeps built-ins, appends plugin entries, and tags provenance', () => {
			const r = mergeContributions([mk('builtin.a')], [{ pluginId: 'p1', items: [mk('p1/x')] }]);
			expect(r.errors).toEqual([]);
			expect(r.items.map((i) => i.item.id)).toEqual(['builtin.a', 'p1/x']);
			expect(r.items[0].provenance).toEqual({ source: 'builtin' });
			expect(r.items[1].provenance).toEqual({ source: 'plugin', pluginId: 'p1' });
		});

		it('built-in ALWAYS wins a collision; the plugin entry is dropped with an error', () => {
			const r = mergeContributions(
				[mk('shared')],
				[{ pluginId: 'evil', items: [mk('shared', 'spoof')] }]
			);
			expect(r.items).toHaveLength(1);
			expect(r.items[0].provenance).toEqual({ source: 'builtin' });
			expect(r.items[0].item.label).toBe('shared');
			expect(r.errors[0]).toContain('collides with a built-in');
		});

		it('earlier plugin wins over a later duplicate id', () => {
			const r = mergeContributions(
				[],
				[
					{ pluginId: 'p1', items: [mk('p1/x')] },
					{ pluginId: 'p2', items: [mk('p1/x', 'dup')] },
				]
			);
			expect(r.items).toHaveLength(1);
			expect(r.items[0].provenance).toEqual({ source: 'plugin', pluginId: 'p1' });
			expect(r.errors[0]).toContain('duplicates another contribution');
		});

		it('mergedItems returns just the surviving items in order', () => {
			expect(
				mergedItems([mk('a')], [{ pluginId: 'p', items: [mk('p/b')] }]).map((i) => i.id)
			).toEqual(['a', 'p/b']);
		});
	});
});
describe('usage-stats-sampler-lifecycle', () => {
	const INTERVAL_MS = 60_000;

	/** One store double serving BOTH consumers: the scheduler reads
	 * `usageRefreshIntervals` (+ onDidChange), the bridge reads/writes
	 * `encoreFeatures`. */
	function makeSettingsStore(intervals: Record<string, number>) {
		const values: Record<string, unknown> = {
			usageRefreshIntervals: intervals,
			encoreFeatures: {},
		};
		return {
			get: (key: string) => values[key],
			set: (key: string, value: unknown) => {
				values[key] = value;
			},
			onDidChange: vi.fn(() => vi.fn()),
		};
	}

	/** Minimal in-memory grants ledger (mint verbatim from the declaration). */
	function makeGrantsLedger() {
		const byPlugin = new Map<string, readonly PermissionGrant[]>();
		return {
			readGrants: (pluginId: string) => byPlugin.get(pluginId) ?? [],
			mint: (pluginId: string, grants: readonly PermissionGrant[]) =>
				byPlugin.set(pluginId, grants),
			revoke: (pluginId: string) => byPlugin.delete(pluginId),
		};
	}

	function makeHarness() {
		const settingsStore = makeSettingsStore({ 'claude-code': INTERVAL_MS });
		const scheduler = new UsageRefreshScheduler({
			sessionsStore: { get: vi.fn() } as unknown as UsageRefreshSchedulerDeps['sessionsStore'],
			agentConfigsStore: {} as unknown as UsageRefreshSchedulerDeps['agentConfigsStore'],
			settingsStore: settingsStore as unknown as UsageRefreshSchedulerDeps['settingsStore'],
			agentDetector: {} as unknown as UsageRefreshSchedulerDeps['agentDetector'],
		});
		const ledger = makeGrantsLedger();
		// The EXACT hooks index.ts registers under firstPartySupervisors.usageStats.
		const bridge = new FirstPartyPluginBridge(USAGE_STATS_FIRST_PARTY_PLUGIN, {
			settingsStore,
			readGrants: (id) => ledger.readGrants(id),
			mintFirstPartyGrants: (definition) =>
				ledger.mint(definition.id, grantsFromRequests([...definition.permissions], 1000)),
			revokeGrants: (id) => ledger.revoke(id),
			supervisor: {
				reconcile: () => scheduler.start(),
				stopAll: () => scheduler.stop(),
			},
		});
		return { scheduler, bridge, settingsStore, ledger };
	}

	describe('stats.sampler lifecycle through the first-party bridge', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			runClaudeMock.mockReset().mockResolvedValue(undefined);
			runCodexMock.mockReset().mockResolvedValue(undefined);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('enable mints the declared grants and arms the sampling loop', async () => {
			const { bridge, scheduler } = makeHarness();

			const state = bridge.setEnabled(true);
			expect(state).toEqual({ enabled: true, authorized: true });

			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);
			scheduler.stop();
		});

		it('marketplace disable stops the sampling loop (no further ticks)', async () => {
			const { bridge } = makeHarness();
			bridge.setEnabled(true);

			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);

			const state = bridge.setEnabled(false);
			expect(state.enabled).toBe(false);

			await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
			expect(runClaudeMock).toHaveBeenCalledTimes(1); // nothing after disable
		});

		it('re-enable re-arms the loop from the persisted intervals', async () => {
			const { bridge, scheduler } = makeHarness();
			bridge.setEnabled(true);
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			bridge.setEnabled(false);
			await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);

			bridge.setEnabled(true);
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			expect(runClaudeMock).toHaveBeenCalledTimes(2);
			scheduler.stop();
		});

		it('revoke stops the loop and drops authority (fails closed)', async () => {
			const { bridge, ledger } = makeHarness();
			bridge.setEnabled(true);
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);

			const state = bridge.revoke();
			expect(state).toEqual({ enabled: false, authorized: false });
			expect(ledger.readGrants(USAGE_STATS_FIRST_PARTY_PLUGIN.id)).toEqual([]);

			await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);
		});

		it('reconcileBackgroundService stops the loop when grants are gone', async () => {
			const { bridge, ledger, settingsStore } = makeHarness();
			bridge.setEnabled(true);
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);

			// Simulate out-of-band grant loss (ledger wipe) with the flag still on.
			ledger.revoke(USAGE_STATS_FIRST_PARTY_PLUGIN.id);
			const state = bridge.reconcileBackgroundService();
			expect(state).toEqual({ enabled: false, authorized: false });
			expect((settingsStore.get('encoreFeatures') as Record<string, unknown>).usageStats).toBe(
				false
			);

			await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);
		});
	});
});
