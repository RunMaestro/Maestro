import { describe, expect, it } from 'vitest';
import type { Session } from '../../../renderer/types';
import { createMockAITab, createMockSession } from '../../helpers';
import {
	buildSendMenuModel,
	getSteerSupport,
	shouldOpenSendMenu,
	steerFeatureRequestUrl,
} from '../../../renderer/utils/sendMenu';
import { describeSteerBlocked, getSteerEligibility } from '../../../renderer/utils/executionQueue';

function workingSession(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		state: 'busy',
		activeTabId: 'tab-1',
		aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
		enableMaestroP: true,
		maestroPMode: 'interactive',
		claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		...overrides,
	});
}

function rowFor(session: Session, action: string, text = 'also check the retry path') {
	const model = buildSendMenuModel(
		session,
		{ text, imageCount: 0 },
		{ forcedParallelEnabled: true }
	);
	return model.rows.find((row) => row.action === action)!;
}

describe('shouldOpenSendMenu', () => {
	it('opens only while the agent works and there is a draft', () => {
		const busy = workingSession();
		expect(shouldOpenSendMenu(busy, { menuEnabled: true, hasDraft: true })).toBe(true);
		expect(shouldOpenSendMenu(busy, { menuEnabled: true, hasDraft: false })).toBe(false);
		expect(shouldOpenSendMenu(busy, { menuEnabled: false, hasDraft: true })).toBe(false);
	});

	it('sends straight away when the agent is idle', () => {
		const idle = createMockSession({ aiTabs: [createMockAITab()], activeTabId: 'tab-1' });
		expect(shouldOpenSendMenu(idle, { menuEnabled: true, hasDraft: true })).toBe(false);
	});

	it('opens when another tab of the agent is working', () => {
		const session = createMockSession({
			activeTabId: 'tab-1',
			aiTabs: [
				createMockAITab({ id: 'tab-1', state: 'idle' }),
				createMockAITab({ id: 'tab-2', state: 'busy' }),
			],
		});
		expect(shouldOpenSendMenu(session, { menuEnabled: true, hasDraft: true })).toBe(true);
	});

	it('never opens in terminal mode', () => {
		const session = workingSession({ inputMode: 'terminal' });
		expect(shouldOpenSendMenu(session, { menuEnabled: true, hasDraft: true })).toBe(false);
	});
});

describe('getSteerSupport', () => {
	it('uses the running provider for support even when the next provider differs', () => {
		const session = workingSession({
			toolType: 'opencode',
			providerOverrides: { 'claude-code': { enableMaestroP: true, maestroPMode: 'interactive' } },
			aiTabs: [
				createMockAITab({
					id: 'tab-1',
					state: 'busy',
					tabProvider: 'codex',
					turnProvider: 'claude-code',
				}),
			],
		});
		const model = buildSendMenuModel(
			session,
			{ text: 'change course', imageCount: 0 },
			{ forcedParallelEnabled: true }
		);
		expect(model.steerProvider).toBe('claude-code');
		expect(model.steerSupport).toEqual({ kind: 'supported' });
		expect(model.rows.find((row) => row.action === 'steer')).toMatchObject({
			enabled: false,
			reason: expect.stringContaining('another provider'),
		});
	});

	it('does not borrow the agent default steering support for a foreign turn', () => {
		const session = workingSession({
			aiTabs: [
				createMockAITab({
					id: 'tab-1',
					state: 'busy',
					tabProvider: 'opencode',
					turnProvider: 'opencode',
				}),
			],
		});
		const model = buildSendMenuModel(
			session,
			{ text: 'change course', imageCount: 0 },
			{ forcedParallelEnabled: true }
		);
		expect(model.steerProvider).toBe('opencode');
		expect(model.steerSupport).toMatchObject({
			kind: 'unsupported',
			detail: expect.stringContaining('OpenCode'),
		});
	});

	it('supports a Claude agent on the TUI token source', () => {
		expect(getSteerSupport(workingSession()).kind).toBe('supported');
	});

	it('calls a Claude API agent fixable', () => {
		const support = getSteerSupport(
			workingSession({
				enableMaestroP: false,
				claudeInteractive: { mode: 'api', modeReason: 'auto' },
			})
		);
		expect(support).toMatchObject({ kind: 'fixable', reason: 'api-token-source' });
	});

	it('names the Dynamic fallback when a Dynamic agent fell back to API', () => {
		const support = getSteerSupport(
			workingSession({
				maestroPMode: 'dynamic',
				claudeInteractive: { mode: 'api', modeReason: 'limit' },
			})
		);
		expect(support.kind).toBe('fixable');
		expect(support.kind !== 'supported' && support.detail).toMatch(/Dynamic mode/);
	});

	it('splits Codex by transport', () => {
		expect(
			getSteerSupport(workingSession({ toolType: 'codex', codexTransport: 'app-server' })).kind
		).toBe('supported');
		expect(getSteerSupport(workingSession({ toolType: 'codex' }))).toMatchObject({
			kind: 'fixable',
			reason: 'codex-exec',
		});
	});

	it('calls any other harness unsupported', () => {
		expect(getSteerSupport(workingSession({ toolType: 'opencode' }))).toMatchObject({
			kind: 'unsupported',
			reason: 'not-claude',
		});
	});

	it('calls an SSH Claude agent unsupported', () => {
		const support = getSteerSupport(workingSession({ sshRemoteId: 'remote-1' }));
		expect(support).toMatchObject({ kind: 'unsupported', reason: 'ssh-remote' });
	});

	it('supports an SSH Codex agent on app-server, and calls one on exec fixable', () => {
		expect(
			getSteerSupport(
				workingSession({ sshRemoteId: 'remote-1', toolType: 'codex', codexTransport: 'app-server' })
			)
		).toEqual({ kind: 'supported' });
		expect(
			getSteerSupport(workingSession({ sshRemoteId: 'remote-1', toolType: 'codex' }))
		).toMatchObject({ kind: 'fixable', reason: 'codex-exec' });
	});
});

describe('buildSendMenuModel', () => {
	it('blocks an image turn on exec even when the agent prefers app-server', () => {
		const session = workingSession({
			toolType: 'codex',
			codexTransport: 'app-server',
			aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy', turnCodexTransport: 'exec' })],
		});
		expect(rowFor(session, 'steer')).toMatchObject({
			enabled: false,
			reason: expect.stringContaining('exec fallbacks'),
		});
	});

	it('keeps steering available when the preference changes during an app-server turn', () => {
		const session = workingSession({
			toolType: 'codex',
			codexTransport: 'exec',
			aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy', turnCodexTransport: 'app-server' })],
		});
		expect(rowFor(session, 'steer').enabled).toBe(true);
	});

	it('offers Steer, not Force Send, when the active tab is working', () => {
		const session = workingSession();
		expect(rowFor(session, 'steer').enabled).toBe(true);
		expect(rowFor(session, 'force')).toMatchObject({ enabled: false });
		expect(rowFor(session, 'queue').enabled).toBe(true);
		expect(rowFor(session, 'hold').enabled).toBe(true);
	});

	it('reports whether any tab works, for a right-click on an idle agent', () => {
		const opts = { forcedParallelEnabled: true };
		const draft = { text: 'hi', imageCount: 0 };
		expect(buildSendMenuModel(workingSession(), draft, opts).agentWorking).toBe(true);
		const idle = workingSession({ state: 'idle', aiTabs: [createMockAITab({ id: 'tab-1' })] });
		expect(buildSendMenuModel(idle, draft, opts)).toMatchObject({
			agentWorking: false,
			activeTabWorking: false,
		});
	});

	it('offers Force Send, not Steer, when only another tab is working', () => {
		const session = workingSession({
			aiTabs: [
				createMockAITab({ id: 'tab-1', state: 'idle' }),
				createMockAITab({ id: 'tab-2', state: 'busy' }),
			],
		});
		expect(rowFor(session, 'force').enabled).toBe(true);
		expect(rowFor(session, 'steer')).toMatchObject({ enabled: false });
	});

	it('points a dead Force Send at the setting when Forced Parallel is off', () => {
		const session = workingSession({
			aiTabs: [
				createMockAITab({ id: 'tab-1', state: 'idle' }),
				createMockAITab({ id: 'tab-2', state: 'busy' }),
			],
		});
		const model = buildSendMenuModel(
			session,
			{ text: 'hi', imageCount: 0 },
			{ forcedParallelEnabled: false }
		);
		expect(model.rows.find((r) => r.action === 'force')).toMatchObject({
			enabled: false,
			opensSetting: true,
		});
	});

	it('ghosts Steer with the harness reason on an unsteerable agent', () => {
		const row = rowFor(workingSession({ toolType: 'codex' }), 'steer');
		expect(row.enabled).toBe(false);
		expect(row.reason).toMatch(/exec fallbacks/);
	});

	it('ghosts Steer with the draft reason when the draft cannot be steered', () => {
		expect(rowFor(workingSession(), 'steer', '/compact').reason).toMatch(/starts with \//);
		const withImages = buildSendMenuModel(
			workingSession(),
			{ text: 'look at this', imageCount: 1 },
			{ forcedParallelEnabled: true }
		);
		expect(withImages.rows.find((r) => r.action === 'steer')?.reason).toMatch(/Images/);
	});
});

describe('Grok steering', () => {
	const grokTwoTabs = (overrides: Partial<Session> = {}) =>
		workingSession({
			toolType: 'grok',
			aiTabs: [
				createMockAITab({ id: 'tab-1', state: 'busy' }),
				createMockAITab({ id: 'tab-2', state: 'busy' }),
			],
			...overrides,
		});

	it('names the absent input operation on either transport, local or remote', () => {
		for (const session of [grokTwoTabs(), grokTwoTabs({ sshRemoteId: 'remote-1' })]) {
			const support = getSteerSupport(session);
			expect(support).toMatchObject({ kind: 'unsupported', reason: 'grok-no-input-op' });
			expect(support.kind !== 'supported' && support.detail).toMatch(/headless route/);
			expect(support.kind !== 'supported' && support.detail).toMatch(/ACP route/);
		}
	});

	it('ghosts Steer on each of two active turns with the reason the steer itself gives', () => {
		for (const activeTabId of ['tab-1', 'tab-2']) {
			const session = grokTwoTabs({ activeTabId });
			const row = rowFor(session, 'steer');
			expect(row).toEqual({
				action: 'steer',
				enabled: false,
				reason: describeSteerBlocked('grok-no-input-op'),
			});
			// The row and the queued card's predicate agree for the same tab.
			expect(getSteerEligibility(session, { tabId: activeTabId, text: 'also' })).toEqual({
				canSteer: false,
				blockedReason: 'grok-no-input-op',
			});
			// Queue stays the way the message reaches the turn; no Force Send replaces it.
			expect(rowFor(session, 'queue').enabled).toBe(true);
			expect(rowFor(session, 'force').enabled).toBe(false);
		}
	});

	it('reads tab-not-working for an idle Grok tab, not the provider gap', () => {
		const session = grokTwoTabs({
			aiTabs: [
				createMockAITab({ id: 'tab-1', state: 'idle' }),
				createMockAITab({ id: 'tab-2', state: 'busy' }),
			],
		});
		expect(getSteerEligibility(session, { tabId: 'tab-1', text: 'x' })).toEqual({
			canSteer: false,
			blockedReason: 'tab-not-working',
		});
		expect(rowFor(session, 'force').enabled).toBe(true);
	});
});

describe('steerFeatureRequestUrl', () => {
	it('pre-fills a GitHub issue naming the provider', () => {
		const url = steerFeatureRequestUrl('opencode');
		expect(url).toContain('https://github.com/RunMaestro/Maestro/issues/new?title=');
		expect(decodeURIComponent(url)).toContain('Steering support for OpenCode');
	});
});
