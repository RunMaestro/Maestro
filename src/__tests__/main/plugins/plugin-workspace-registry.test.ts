import { describe, expect, it } from 'vitest';
import {
	PluginWorkspaceRegistry,
	WorkspaceRegistryError,
	type ExternalSessionStatus,
	type WorkspaceCapability,
} from '../../../main/plugins/plugin-workspace-registry';
import {
	parseWorkspaceFoundation,
	parseWorkspaceLink,
	type CanonicalWorkspaceFoundation,
} from '../../../shared/plugins/workspace-foundation';

const OWNER_PLUGIN_ID = 'com.maestro.omp';
const WORKSPACE_LOCAL_ID = 'omp-workspace';
const PANEL_LOCAL_ID = 'omp-panel';

const EXTERNAL_SESSION_STATUSES = [
	'starting',
	'idle',
	'working',
	'waiting_for_input',
	'waiting_for_approval',
	'retrying',
	'completed',
	'aborted',
	'failed',
	'offline',
] as const satisfies readonly ExternalSessionStatus[];

interface TestHarness {
	readonly registry: PluginWorkspaceRegistry;
	readonly selectedContexts: Array<unknown>;
	readonly enabledOwners: Set<string>;
	tokenCalls(): number;
}

function parsedFoundation(
	ownerPluginId = OWNER_PLUGIN_ID,
	overrides: Partial<{ workspaceTitle: string; panelTitle: string }> = {}
): CanonicalWorkspaceFoundation {
	const result = parseWorkspaceFoundation(
		{
			workspaces: [
				{
					localId: WORKSPACE_LOCAL_ID,
					title: overrides.workspaceTitle ?? 'OMP Workspace',
					icon: 'sparkles',
					interactivePanelLocalId: PANEL_LOCAL_ID,
				},
			],
			interactivePanels: [
				{
					localId: PANEL_LOCAL_ID,
					title: overrides.panelTitle ?? 'OMP Panel',
					entry: 'dist/panel.js',
					workspaceLocalId: WORKSPACE_LOCAL_ID,
				},
			],
		},
		[{ capability: 'ui:workspace' }, { capability: 'ui:interactivePanel' }],
		ownerPluginId
	);
	if (!result.ok) throw new Error(result.errors.join(', '));
	return result.value;
}

function token(index: number): string {
	return `t${index.toString(36).padStart(21, '0')}`;
}

function externalSession(
	externalSessionId: string,
	overrides: Partial<{
		externalSessionId: unknown;
		title: unknown;
		status: unknown;
		unread: unknown;
		pendingApproval: unknown;
		updatedAt: unknown;
	}> = {}
): Record<string, unknown> {
	return {
		externalSessionId: Object.prototype.hasOwnProperty.call(overrides, 'externalSessionId')
			? overrides.externalSessionId
			: externalSessionId,
		title: Object.prototype.hasOwnProperty.call(overrides, 'title')
			? overrides.title
			: `Session ${externalSessionId}`,
		status: Object.prototype.hasOwnProperty.call(overrides, 'status') ? overrides.status : 'idle',
		unread: Object.prototype.hasOwnProperty.call(overrides, 'unread') ? overrides.unread : 0,
		pendingApproval: Object.prototype.hasOwnProperty.call(overrides, 'pendingApproval')
			? overrides.pendingApproval
			: false,
		updatedAt: Object.prototype.hasOwnProperty.call(overrides, 'updatedAt')
			? overrides.updatedAt
			: 1_000,
	};
}

function ownerContext(
	overrides: Partial<{
		ownerPluginId: string;
		generation: bigint;
		trusted: boolean;
		enabled: boolean;
		grants: readonly string[];
	}> = {}
): {
	ownerPluginId: string;
	generation: bigint;
	trusted: boolean;
	enabled: boolean;
	grants: readonly string[];
} {
	return {
		ownerPluginId: overrides.ownerPluginId ?? OWNER_PLUGIN_ID,
		generation: overrides.generation ?? 1n,
		trusted: overrides.trusted ?? true,
		enabled: overrides.enabled ?? true,
		grants: overrides.grants ?? ['ui:workspace', 'ui:interactivePanel'],
	};
}

function createHarness(tokens: readonly string[] = [token(1), token(2), token(3)]): TestHarness {
	let tokenIndex = 0;
	const enabledOwners = new Set([OWNER_PLUGIN_ID]);
	const selectedContexts: Array<unknown> = [];
	const registry = new PluginWorkspaceRegistry({
		tokenSource: () => tokens[tokenIndex++] ?? token(tokenIndex),
		isOwnerEnabled: (ownerPluginId) => enabledOwners.has(ownerPluginId),
	});
	registry.onDidChangeContext((context) => selectedContexts.push(context));
	return {
		registry,
		selectedContexts,
		enabledOwners,
		tokenCalls: () => tokenIndex,
	};
}

function registerCurrent(
	harness: TestHarness,
	generation = 1n,
	ownerPluginId = OWNER_PLUGIN_ID
): void {
	harness.registry.register(parsedFoundation(ownerPluginId), generation);
}

function acquireCurrent(harness: TestHarness, generation = 1n, ownerPluginId = OWNER_PLUGIN_ID) {
	return harness.registry.acquire(ownerContext({ generation, ownerPluginId }), WORKSPACE_LOCAL_ID);
}

function sessionLink(
	tokenValue: string,
	ownerPluginId = OWNER_PLUGIN_ID,
	workspaceLocalId = WORKSPACE_LOCAL_ID
): string {
	return `maestro://workspace/${ownerPluginId}/${workspaceLocalId}/session/${tokenValue}`;
}

function publishedSessions(harness: TestHarness, capability: WorkspaceCapability) {
	return harness.registry.getExternalSessions(capability);
}

function expectRegistryError(action: () => unknown, code: string): void {
	try {
		action();
		throw new Error('expected workspace registry operation to throw');
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspaceRegistryError);
		expect(error).toMatchObject({ code });
	}
}

describe('PluginWorkspaceRegistry lifecycle', () => {
	it('creates one canonical workspace record when a foundation is registered', () => {
		const harness = createHarness();
		registerCurrent(harness);

		expect(harness.registry.getWorkspace(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID)).toMatchObject({
			ownerPluginId: OWNER_PLUGIN_ID,
			workspaceLocalId: WORKSPACE_LOCAL_ID,
			generation: 1n,
			workspace: { title: 'OMP Workspace', panelLocalId: PANEL_LOCAL_ID },
			panel: { title: 'OMP Panel', localId: PANEL_LOCAL_ID },
		});
	});

	it('refreshes same-generation metadata without invalidating capability, snapshots, tokens, or selection', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshots = structuredClone(publishedSessions(harness, capability));
		const snapshotToken = snapshots[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');
		harness.registry.setSelectedContext(capability, snapshotToken);
		const eventCount = harness.selectedContexts.length;

		harness.registry.register(
			parsedFoundation(OWNER_PLUGIN_ID, { workspaceTitle: 'Renamed OMP' }),
			1n
		);

		expect(harness.registry.getWorkspace(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID)).toMatchObject({
			generation: 1n,
			workspace: { title: 'Renamed OMP' },
		});
		expect(publishedSessions(harness, capability)).toEqual(snapshots);
		expect(harness.selectedContexts).toHaveLength(eventCount);
		expect(harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken))).toMatchObject({
			kind: 'resolved',
		});
	});

	it.each(['unregister', 'generation rotation'])(
		'clears retained same-generation selection exactly once on %s',
		(action) => {
			const harness = createHarness();
			registerCurrent(harness);
			const capability = acquireCurrent(harness);
			harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
			const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
			if (!snapshotToken) throw new Error('expected a snapshot token');
			harness.registry.setSelectedContext(capability, snapshotToken);
			harness.registry.register(parsedFoundation(), 1n);
			const eventCount = harness.selectedContexts.length;

			if (action === 'unregister') {
				harness.registry.unregister(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID);
			} else {
				harness.registry.register(parsedFoundation(), 2n);
			}

			expect(harness.selectedContexts.slice(eventCount)).toEqual([
				{
					kind: 'selection-cleared',
					ownerPluginId: OWNER_PLUGIN_ID,
					workspaceLocalId: WORKSPACE_LOCAL_ID,
				},
			]);
		}
	);
	it('rotates generation-bound capability and revokes prior tokens on newer registration', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const oldCapability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(oldCapability, 1, [externalSession('session-1')]);
		const oldToken = publishedSessions(harness, oldCapability)[0]?.snapshotToken;
		if (!oldToken) throw new Error('expected a snapshot token');

		harness.registry.register(parsedFoundation(), 2n);
		expectRegistryError(
			() => harness.registry.publishExternalSessions(oldCapability, 2, []),
			'capability_unavailable'
		);
		expect(harness.registry.getWorkspace(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID)).toMatchObject({
			generation: 2n,
		});
		expect(harness.registry.resolveWorkspaceLink(sessionLink(oldToken))).toEqual({
			kind: 'revoked',
		});

		const newCapability = acquireCurrent(harness, 2n);
		expect(() => harness.registry.publishExternalSessions(newCapability, 1, [])).not.toThrow();
	});

	it('isolates same local IDs across owners through acquisition, publishing, links, and unregister', () => {
		const otherOwnerPluginId = 'com.example.other';
		const harness = createHarness();
		harness.enabledOwners.add(otherOwnerPluginId);
		registerCurrent(harness);
		registerCurrent(harness, 1n, otherOwnerPluginId);
		const ownerCapability = acquireCurrent(harness);
		const otherCapability = acquireCurrent(harness, 1n, otherOwnerPluginId);
		harness.registry.publishExternalSessions(ownerCapability, 1, [
			externalSession('owner-session'),
		]);
		harness.registry.publishExternalSessions(otherCapability, 1, [
			externalSession('other-session'),
		]);
		const ownerToken = publishedSessions(harness, ownerCapability)[0]?.snapshotToken;
		const otherToken = publishedSessions(harness, otherCapability)[0]?.snapshotToken;
		if (!ownerToken || !otherToken) throw new Error('expected owner-isolated snapshot tokens');

		expect(harness.registry.resolveWorkspaceLink(sessionLink(ownerToken))).toMatchObject({
			kind: 'resolved',
			externalSession: { externalSessionId: 'owner-session' },
		});
		expect(
			harness.registry.resolveWorkspaceLink(sessionLink(otherToken, otherOwnerPluginId))
		).toMatchObject({
			kind: 'resolved',
			externalSession: { externalSessionId: 'other-session' },
		});

		harness.registry.unregister(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID);

		expect(harness.registry.resolveWorkspaceLink(sessionLink(ownerToken))).toEqual({
			kind: 'revoked',
		});
		expect(
			harness.registry.resolveWorkspaceLink(sessionLink(otherToken, otherOwnerPluginId))
		).toMatchObject({ kind: 'resolved' });
		expect(() =>
			harness.registry.publishExternalSessions(otherCapability, 2, [
				externalSession('other-session-2'),
			])
		).not.toThrow();
	});
	it('rejects an owner context that does not match the registered workspace owner', () => {
		const harness = createHarness();
		registerCurrent(harness);

		expectRegistryError(
			() =>
				harness.registry.acquire(
					ownerContext({ ownerPluginId: 'com.example.foreign' }),
					WORKSPACE_LOCAL_ID
				),
			'capability_unavailable'
		);
	});

	it('unregisters by revoking capability and tokens, deleting the record, and clearing selection', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');
		harness.registry.setSelectedContext(capability, snapshotToken);

		harness.registry.unregister(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID);
		expect(harness.registry.getWorkspace(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID)).toBeNull();
		expectRegistryError(
			() => harness.registry.publishExternalSessions(capability, 2, []),
			'capability_unavailable'
		);
		expect(harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken))).toEqual({
			kind: 'revoked',
		});
		expect(harness.selectedContexts.at(-1)).toEqual({
			kind: 'selection-cleared',
			ownerPluginId: OWNER_PLUGIN_ID,
			workspaceLocalId: WORKSPACE_LOCAL_ID,
		});
	});
});

describe('PluginWorkspaceRegistry capability acquisition', () => {
	it.each([
		['an undeclared local ID', ownerContext(), 'not-declared'],
		['an untrusted owner', ownerContext({ trusted: false }), WORKSPACE_LOCAL_ID],
		['a disabled owner', ownerContext({ enabled: false }), WORKSPACE_LOCAL_ID],
		[
			'a missing workspace grant',
			ownerContext({ grants: ['ui:interactivePanel'] }),
			WORKSPACE_LOCAL_ID,
		],
		[
			'a missing interactive panel grant',
			ownerContext({ grants: ['ui:workspace'] }),
			WORKSPACE_LOCAL_ID,
		],
		['a stale generation', ownerContext({ generation: 0n }), WORKSPACE_LOCAL_ID],
	])('rejects %s without minting a capability', (_reason, context, localId) => {
		const harness = createHarness();
		registerCurrent(harness);

		expectRegistryError(() => harness.registry.acquire(context, localId), 'capability_unavailable');
	});

	it.each([null, undefined, {}, { ownerPluginId: OWNER_PLUGIN_ID }])(
		'rejects malformed owner context without throwing a native error',
		(context) => {
			const harness = createHarness();
			registerCurrent(harness);

			expectRegistryError(
				() => harness.registry.acquire(context as never, WORKSPACE_LOCAL_ID),
				'capability_unavailable'
			);
		}
	);

	it('issues a capability only for the current trusted owner with both paired grants', () => {
		const harness = createHarness();
		registerCurrent(harness);

		expect(harness.registry.acquire(ownerContext(), WORKSPACE_LOCAL_ID)).toBeDefined();
	});
});

describe('PluginWorkspaceRegistry external session publication', () => {
	it('accepts exactly 500 external-session snapshots', () => {
		const harness = createHarness(Array.from({ length: 500 }, (_, index) => token(index)));
		registerCurrent(harness);
		const capability = acquireCurrent(harness);

		harness.registry.publishExternalSessions(
			capability,
			1,
			Array.from({ length: 500 }, (_, index) => externalSession(`session-${index}`))
		);

		expect(publishedSessions(harness, capability)).toHaveLength(500);
	});

	it.each(EXTERNAL_SESSION_STATUSES)('accepts the %s external-session status', (status) => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);

		harness.registry.publishExternalSessions(capability, 1, [
			externalSession('session-1', { status }),
		]);

		expect(publishedSessions(harness, capability)).toMatchObject([
			{ externalSessionId: 'session-1', status },
		]);
	});

	it('accepts title, unread, and pending-approval boundaries', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		const longestTitle = '🙂'.repeat(160);

		harness.registry.publishExternalSessions(capability, 1, [
			externalSession('minimum', { unread: 0, updatedAt: 0 }),
			externalSession('maximum', {
				title: longestTitle,
				unread: 9_999,
				pendingApproval: true,
			}),
			externalSession('fractional-updated-at', { updatedAt: 0.5 }),
		]);

		expect(publishedSessions(harness, capability)).toMatchObject([
			{ externalSessionId: 'minimum', unread: 0, updatedAt: 0 },
			{
				externalSessionId: 'maximum',
				title: longestTitle,
				unread: 9_999,
				pendingApproval: true,
			},
			{ externalSessionId: 'fractional-updated-at', updatedAt: 0.5 },
		]);
	});

	it('rejects 501 external-session snapshots without replacing the last accepted state', () => {
		const harness = createHarness(Array.from({ length: 502 }, (_, index) => token(index)));
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('kept')]);
		const before = structuredClone(publishedSessions(harness, capability));

		expectRegistryError(
			() =>
				harness.registry.publishExternalSessions(
					capability,
					2,
					Array.from({ length: 501 }, (_, index) => externalSession(`session-${index}`))
				),
			'too_many_external_sessions'
		);
		expect(publishedSessions(harness, capability)).toEqual(before);
	});

	it('requires a strictly increasing revision without mutating accepted snapshots', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 2, [externalSession('kept')]);
		const before = structuredClone(publishedSessions(harness, capability));

		expectRegistryError(
			() => harness.registry.publishExternalSessions(capability, 2, [externalSession('rejected')]),
			'revision_not_increasing'
		);
		expectRegistryError(
			() => harness.registry.publishExternalSessions(capability, 1, [externalSession('rejected')]),
			'revision_not_increasing'
		);
		expect(publishedSessions(harness, capability)).toEqual(before);
	});

	it('rejects duplicate external-session IDs without mutating accepted snapshots', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('kept')]);
		const before = structuredClone(publishedSessions(harness, capability));

		expectRegistryError(
			() =>
				harness.registry.publishExternalSessions(capability, 2, [
					externalSession('same'),
					externalSession('same'),
				]),
			'duplicate_external_session_id'
		);
		expect(publishedSessions(harness, capability)).toEqual(before);
	});

	it.each([
		['externalSessionId', externalSession('invalid-id', { externalSessionId: '' })],
		['title type', externalSession('invalid-title', { title: 1 })],
		['title scalar length', externalSession('invalid-title-length', { title: '🙂'.repeat(161) })],
		['status', externalSession('invalid-status', { status: 'active' })],
		['unread type', externalSession('invalid-unread', { unread: 'yes' })],
		['negative unread', externalSession('invalid-unread-negative', { unread: -1 })],
		['too-large unread', externalSession('invalid-unread-large', { unread: 10_000 })],
		['fractional unread', externalSession('invalid-unread-fractional', { unread: 0.5 })],
		['pendingApproval', externalSession('invalid-pending', { pendingApproval: 1 })],
		['updatedAt type', externalSession('invalid-updated', { updatedAt: 'now' })],
		['negative updatedAt', externalSession('invalid-updated-negative', { updatedAt: -1 })],
		[
			'non-finite updatedAt',
			externalSession('invalid-updated-nonfinite', { updatedAt: Number.NaN }),
		],
		['null externalSessionId', externalSession('invalid-id-null', { externalSessionId: null })],
		['null title', externalSession('invalid-title-null', { title: null })],
		['null status', externalSession('invalid-status-null', { status: null })],
		['null unread', externalSession('invalid-unread-null', { unread: null })],
		['NaN unread', externalSession('invalid-unread-nan', { unread: Number.NaN })],
		[
			'infinite unread',
			externalSession('invalid-unread-infinite', { unread: Number.POSITIVE_INFINITY }),
		],
		['null pendingApproval', externalSession('invalid-pending-null', { pendingApproval: null })],
		['null updatedAt', externalSession('invalid-updated-null', { updatedAt: null })],
	])('rejects malformed %s without mutating accepted snapshots', (_field, invalidSnapshot) => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('kept')]);
		const before = structuredClone(publishedSessions(harness, capability));

		expectRegistryError(
			() => harness.registry.publishExternalSessions(capability, 2, [invalidSnapshot]),
			'invalid_external_session'
		);
		expect(publishedSessions(harness, capability)).toEqual(before);
	});

	it('emits only injected opaque tokens with 22–86 URL-safe characters', () => {
		const shortest = 'Ab9_KLMNopQRsTuvWxyZ12';
		const longest = `${'A'.repeat(85)}_`;
		const harness = createHarness([shortest, longest]);
		registerCurrent(harness);
		const capability = acquireCurrent(harness);

		harness.registry.publishExternalSessions(capability, 1, [
			externalSession('short-token'),
			externalSession('long-token'),
		]);

		expect(publishedSessions(harness, capability).map((session) => session.snapshotToken)).toEqual([
			shortest,
			longest,
		]);
		expect(
			publishedSessions(harness, capability).every((session) =>
				/^[A-Za-z0-9_-]{22,86}$/.test(session.snapshotToken)
			)
		).toBe(true);
	});

	it('clones accepted snapshots and returned sessions at the registry boundary', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		const input = externalSession('session-1');
		const published = harness.registry.publishExternalSessions(capability, 1, [input]);
		const snapshotToken = published[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');

		input.title = 'Mutated input';
		input.unread = 9_999;
		const mutablePublished = published[0] as unknown as Record<string, unknown>;
		mutablePublished.title = 'Mutated publish return';
		mutablePublished.unread = 9_999;
		const mutableGetterSession = publishedSessions(harness, capability)[0] as unknown as Record<
			string,
			unknown
		>;
		mutableGetterSession.title = 'Mutated getter return';
		mutableGetterSession.unread = 9_999;

		expect(publishedSessions(harness, capability)).toMatchObject([
			{ externalSessionId: 'session-1', title: 'Session session-1', unread: 0 },
		]);
		expect(harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken))).toMatchObject({
			kind: 'resolved',
			externalSession: { title: 'Session session-1', unread: 0 },
		});
	});

	it('retries a duplicate token at most four times then rejects the publication atomically', () => {
		const collidingToken = token(1);
		const harness = createHarness(Array.from({ length: 6 }, () => collidingToken));
		registerCurrent(harness);
		const capability = acquireCurrent(harness);

		expectRegistryError(
			() =>
				harness.registry.publishExternalSessions(capability, 1, [
					externalSession('first'),
					externalSession('second'),
				]),
			'token_collision'
		);

		expect(harness.tokenCalls()).toBe(6);
		expect(publishedSessions(harness, capability)).toEqual([]);
	});

	it('preserves a prior revision and link when replacement token minting collides', () => {
		const priorToken = token(1);
		const harness = createHarness([priorToken, ...Array.from({ length: 5 }, () => priorToken)]);
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('kept')]);
		const before = structuredClone(publishedSessions(harness, capability));

		expectRegistryError(
			() =>
				harness.registry.publishExternalSessions(capability, 2, [externalSession('replacement')]),
			'token_collision'
		);

		expect(harness.tokenCalls()).toBe(6);
		expect(publishedSessions(harness, capability)).toEqual(before);
		expect(harness.registry.resolveWorkspaceLink(sessionLink(priorToken))).toMatchObject({
			kind: 'resolved',
		});
	});

	it('does not let a colliding token from another owner replace an existing owner link', () => {
		const otherOwnerPluginId = 'com.example.other';
		const ownerToken = token(1);
		const harness = createHarness([ownerToken, ...Array.from({ length: 5 }, () => ownerToken)]);
		harness.enabledOwners.add(otherOwnerPluginId);
		registerCurrent(harness);
		registerCurrent(harness, 1n, otherOwnerPluginId);
		const ownerCapability = acquireCurrent(harness);
		const otherCapability = acquireCurrent(harness, 1n, otherOwnerPluginId);
		harness.registry.publishExternalSessions(ownerCapability, 1, [
			externalSession('owner-session'),
		]);

		expectRegistryError(
			() =>
				harness.registry.publishExternalSessions(otherCapability, 1, [
					externalSession('other-session'),
				]),
			'token_collision'
		);

		expect(harness.tokenCalls()).toBe(6);
		expect(publishedSessions(harness, otherCapability)).toEqual([]);
		expect(harness.registry.resolveWorkspaceLink(sessionLink(ownerToken))).toMatchObject({
			kind: 'resolved',
			externalSession: { externalSessionId: 'owner-session' },
		});
	});

	it('rejects an invalid token-source value without publishing a partial snapshot', () => {
		const harness = createHarness(['short']);
		registerCurrent(harness);
		const capability = acquireCurrent(harness);

		expectRegistryError(
			() => harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]),
			'invalid_snapshot_token'
		);
		expect(publishedSessions(harness, capability)).toEqual([]);
	});
});

describe('PluginWorkspaceRegistry selected context', () => {
	it('publishes a selected context and clears it when generation revocation occurs', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');

		harness.registry.setSelectedContext(capability, snapshotToken);
		expect(harness.selectedContexts.at(-1)).toEqual({
			kind: 'external-session-selected',
			ownerPluginId: OWNER_PLUGIN_ID,
			workspaceLocalId: WORKSPACE_LOCAL_ID,
			snapshotToken,
		});

		harness.registry.register(parsedFoundation(), 2n);
		expect(harness.selectedContexts.at(-1)).toEqual({
			kind: 'selection-cleared',
			ownerPluginId: OWNER_PLUGIN_ID,
			workspaceLocalId: WORKSPACE_LOCAL_ID,
		});
	});

	it('clears a dropped selected snapshot once after committing a replacement revision', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');
		harness.registry.setSelectedContext(capability, snapshotToken);
		const eventCount = harness.selectedContexts.length;

		harness.registry.publishExternalSessions(capability, 2, [externalSession('session-2')]);

		expect(harness.selectedContexts.slice(eventCount)).toEqual([
			{
				kind: 'selection-cleared',
				ownerPluginId: OWNER_PLUGIN_ID,
				workspaceLocalId: WORKSPACE_LOCAL_ID,
			},
		]);
		expect(Object.isFrozen(harness.selectedContexts.at(-1))).toBe(true);
	});

	it('preserves selected context and emits no event for unknown or stale snapshot tokens', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const staleToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!staleToken) throw new Error('expected a stale snapshot token');
		harness.registry.publishExternalSessions(capability, 2, [externalSession('session-1')]);
		const currentToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!currentToken) throw new Error('expected a current snapshot token');
		harness.registry.setSelectedContext(capability, currentToken);
		const before = structuredClone(harness.selectedContexts);

		harness.registry.setSelectedContext(capability, token(99));
		harness.registry.setSelectedContext(capability, staleToken);

		expect(harness.selectedContexts).toEqual(before);
	});
});

describe('workspace link parsing and resolution', () => {
	it('parses underscore and hyphen opaque tokens as syntax only', () => {
		const underscoreToken = 'Ab9_KLMNopQRsTuvWxyZ12';
		const hyphenToken = 'Ab9-KLMNopQRsTuvWxyZ12';

		expect(parseWorkspaceLink(sessionLink(underscoreToken))).toMatchObject({
			pluginId: OWNER_PLUGIN_ID,
			workspaceLocalId: WORKSPACE_LOCAL_ID,
			snapshotToken: underscoreToken,
		});
		expect(parseWorkspaceLink(sessionLink(hyphenToken))).toMatchObject({
			snapshotToken: hyphenToken,
		});
	});

	it.each([
		'maestro://workspace/com.maestro.omp/omp-workspace/session/short',
		'maestro://workspace/com.maestro.omp/omp-workspace/session/invalid*token',
		'maestro://workspace/com.maestro.omp/omp-workspace/session/Ab9_KLMNopQRsTuvWxyZ12?query=true',
		'%%%',
	])('rejects malformed workspace-link syntax: %s', (url) => {
		expect(parseWorkspaceLink(url)).toBeNull();
	});

	it('distinguishes syntax failure from an unknown token', () => {
		const harness = createHarness();
		registerCurrent(harness);

		expect(harness.registry.resolveWorkspaceLink('%%%')).toEqual({ kind: 'syntax_invalid' });
		expect(harness.registry.resolveWorkspaceLink(sessionLink(token(99)))).toEqual({
			kind: 'unknown_token',
		});
	});

	it('rejects a token presented under a foreign owner or workspace path', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');

		expect(
			harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken, 'com.example.foreign'))
		).toEqual({
			kind: 'foreign_owner',
		});
		expect(
			harness.registry.resolveWorkspaceLink(
				sessionLink(snapshotToken, OWNER_PLUGIN_ID, 'other-workspace')
			)
		).toEqual({
			kind: 'foreign_owner',
		});
	});

	it('expires a token when a later projection revision replaces it', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');
		harness.registry.publishExternalSessions(capability, 2, [externalSession('session-2')]);

		expect(harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken))).toEqual({
			kind: 'expired',
		});
	});

	it('distinguishes a revoked token after unregistering its workspace', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');
		harness.registry.unregister(OWNER_PLUGIN_ID, WORKSPACE_LOCAL_ID);

		expect(harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken))).toEqual({
			kind: 'revoked',
		});
	});

	it('distinguishes a disabled owner from an otherwise current token', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');
		harness.enabledOwners.delete(OWNER_PLUGIN_ID);

		expect(harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken))).toEqual({
			kind: 'disabled_owner',
		});
	});

	it('resolves a current token to its owner-bound workspace and external session', () => {
		const harness = createHarness();
		registerCurrent(harness);
		const capability = acquireCurrent(harness);
		harness.registry.publishExternalSessions(capability, 1, [externalSession('session-1')]);
		const snapshotToken = publishedSessions(harness, capability)[0]?.snapshotToken;
		if (!snapshotToken) throw new Error('expected a snapshot token');

		expect(harness.registry.resolveWorkspaceLink(sessionLink(snapshotToken))).toMatchObject({
			kind: 'resolved',
			ownerPluginId: OWNER_PLUGIN_ID,
			workspaceLocalId: WORKSPACE_LOCAL_ID,
			externalSession: expect.objectContaining({ externalSessionId: 'session-1', snapshotToken }),
		});
	});
});
