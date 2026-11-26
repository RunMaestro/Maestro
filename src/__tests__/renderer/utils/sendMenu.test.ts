import { describe, expect, it } from 'vitest';
import type { Session } from '../../../renderer/types';
import { AGENT_MODES, agentModeFields, createMockAITab, createMockSession } from '../../helpers';
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
	it('offers Steer, not Force Send, when the active tab is working', () => {
		const session = workingSession();
		expect(rowFor(session, 'steer').enabled).toBe(true);
		expect(rowFor(session, 'force')).toMatchObject({ enabled: false });
		expect(rowFor(session, 'queue').enabled).toBe(true);
		expect(rowFor(session, 'hold').enabled).toBe(true);
	});

	it('local, SSH, and hosted agents get the same Queue, Force Send, and Queue Held rows', () => {
		const draft = { text: 'hi', imageCount: 0 };
		const opts = { forcedParallelEnabled: true };
		const local = buildSendMenuModel(workingSession(), draft, opts);
		const ssh = buildSendMenuModel(workingSession({ sshRemoteId: 'remote-1' }), draft, opts);
		const hosted = buildSendMenuModel(workingSession(), draft, { ...opts, hosted: true });
		const rows = (model: typeof local) => model.rows.filter((row) => row.action !== 'steer');
		expect(rows(ssh)).toEqual(rows(local));
		expect(rows(hosted)).toEqual(rows(local));
		expect(hosted.rows.find((row) => row.action === 'hold')).toEqual({
			action: 'hold',
			enabled: true,
		});
	});

	it('a hosted agent steers as a local agent does, though its record keeps its SSH remote', () => {
		const draft = { text: 'also check the retry path', imageCount: 0 };
		const opts = { forcedParallelEnabled: true };
		const local = buildSendMenuModel(workingSession(), draft, opts);
		// The host runs the turn on its own machine: the record's SSH remote is not the turn's hop.
		const hosted = buildSendMenuModel(workingSession({ sshRemoteId: 'remote-1' }), draft, {
			...opts,
			hosted: true,
		});
		const ssh = buildSendMenuModel(workingSession({ sshRemoteId: 'remote-1' }), draft, opts);
		expect(hosted.rows).toEqual(local.rows);
		expect(hosted.steerSupport).toEqual({ kind: 'supported' });
		expect(ssh.rows.find((row) => row.action === 'steer')).toMatchObject({ enabled: false });
	});

	it.each(AGENT_MODES)('keeps the Steer row in the menu for a %s agent', (mode) => {
		const session = workingSession(agentModeFields(mode));
		const model = buildSendMenuModel(
			session,
			{ text: 'also check the retry path', imageCount: 0 },
			{ forcedParallelEnabled: true, hosted: mode === 'hosted' }
		);
		expect(model.rows.map((row) => row.action)).toEqual(['queue', 'force', 'steer', 'hold']);
		const steer = model.rows.find((row) => row.action === 'steer')!;
		if (mode === 'ssh') {
			// LOCKED (B1.15): the steering socket is on the remote. The row stays, dead, with why.
			expect(steer.enabled).toBe(false);
			expect(steer.reason).toContain('Queue the message and it sends when the turn ends.');
		} else {
			expect(steer).toEqual({ action: 'steer', enabled: true });
		}
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
		expect(row.reason).toMatch(/exec transport/);
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
