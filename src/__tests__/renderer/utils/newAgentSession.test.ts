/**
 * @file newAgentSession.test.ts
 * @description Tests for the builder both create paths share: the New Agent
 * modal (`createNewSession`) and the CLI / web `create_session` handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildNewAgentSession,
	isRemoteNewAgent,
	probeNewAgentGitState,
	type NewAgentSessionContext,
} from '../../../renderer/utils/newAgentSession';
import type { NewAgentDraft } from '../../../renderer/components/NewInstanceModal/types';
import { gitService } from '../../../renderer/services/git';

let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: () => `test-id-${++idCounter}`,
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(),
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

const draft = (overrides: Partial<NewAgentDraft> = {}): NewAgentDraft => ({
	agentId: 'claude-code',
	workingDir: '/projects/app',
	name: 'App',
	...overrides,
});

const context = (overrides: Partial<NewAgentSessionContext> = {}): NewAgentSessionContext => ({
	id: 'agent-1',
	git: { isGitRepo: false },
	...overrides,
});

/** Every optional draft field a builder could write onto the record. */
const OPTIONAL_FIELDS = [
	'gitBranches',
	'gitTags',
	'gitRefsCacheTime',
	'additionalDirectories',
	'nudgeMessage',
	'newSessionMessage',
	'customPath',
	'customArgs',
	'customEnvVars',
	'customModel',
	'customContextWindow',
	'customProviderPath',
	'customEffort',
	'sessionSshRemoteConfig',
	'enableMaestroP',
	'maestroPPath',
	'maestroPMode',
	'retryOnAvailabilityErrors',
	'retryOnTokenExhaustion',
	'codexAutoResetOnExhaustion',
	'codexTransport',
	'harnessControlMode',
] as const;

beforeEach(() => {
	idCounter = 0;
	vi.clearAllMocks();
});

describe('isRemoteNewAgent', () => {
	it('is true only with SSH enabled and a remote chosen', () => {
		expect(isRemoteNewAgent({})).toBe(false);
		expect(isRemoteNewAgent({ sessionSshRemoteConfig: { enabled: false, remoteId: null } })).toBe(
			false
		);
		expect(
			isRemoteNewAgent({ sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' } })
		).toBe(false);
		expect(isRemoteNewAgent({ sessionSshRemoteConfig: { enabled: true, remoteId: null } })).toBe(
			false
		);
		expect(
			isRemoteNewAgent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } })
		).toBe(true);
	});
});

describe('probeNewAgentGitState', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('reads branches and tags of a local repository and stamps the cache time', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		vi.mocked(gitService.isRepo).mockResolvedValue(true);
		vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'develop']);
		vi.mocked(gitService.getTags).mockResolvedValue(['v1.0']);

		await expect(probeNewAgentGitState(draft())).resolves.toEqual({
			isGitRepo: true,
			gitBranches: ['main', 'develop'],
			gitTags: ['v1.0'],
			gitRefsCacheTime: 1_700_000_000_000,
		});
		expect(gitService.isRepo).toHaveBeenCalledExactlyOnceWith('/projects/app');
		expect(gitService.getBranches).toHaveBeenCalledExactlyOnceWith('/projects/app');
		expect(gitService.getTags).toHaveBeenCalledExactlyOnceWith('/projects/app');
	});

	it('reads nothing more from a local directory that is not a repository', async () => {
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const state = await probeNewAgentGitState(draft());

		expect(state).toEqual({ isGitRepo: false });
		expect(Object.keys(state)).toEqual(['isGitRepo']);
		expect(gitService.getBranches).not.toHaveBeenCalled();
		expect(gitService.getTags).not.toHaveBeenCalled();
	});

	it('leaves an SSH agent unprobed until its remote connects', async () => {
		const state = await probeNewAgentGitState(
			draft({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } })
		);

		expect(state).toEqual({ isGitRepo: false });
		expect(gitService.isRepo).not.toHaveBeenCalled();
	});

	it('probes locally when SSH is on but no remote is chosen', async () => {
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		await probeNewAgentGitState(
			draft({ sessionSshRemoteConfig: { enabled: true, remoteId: null } })
		);

		expect(gitService.isRepo).toHaveBeenCalledExactlyOnceWith('/projects/app');
	});
});

describe('buildNewAgentSession', () => {
	it('builds the one-tab skeleton from the draft and the context', () => {
		const session = buildNewAgentSession(
			draft(),
			context({ saveToHistory: true, showThinking: 'on' })
		);

		expect(session).toMatchObject({
			id: 'agent-1',
			name: 'App',
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/projects/app',
			fullPath: '/projects/app',
			projectRoot: '/projects/app',
			shellCwd: '/projects/app',
			inputMode: 'ai',
			aiPid: 0,
			isGitRepo: false,
			autoRunFolderPath: '/projects/app/.maestro/playbooks',
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		});
		expect(session.aiTabs).toHaveLength(1);
		const [tab] = session.aiTabs;
		expect(tab).toMatchObject({
			id: 'test-id-1',
			agentSessionId: null,
			state: 'idle',
			saveToHistory: true,
			showThinking: 'on',
		});
		expect(session.activeTabId).toBe(tab.id);
		expect(session.unifiedTabOrder).toEqual([{ type: 'ai', id: tab.id }]);
	});

	it('leaves no key for a setting the draft leaves unset', () => {
		const session = buildNewAgentSession(draft(), context());

		for (const field of OPTIONAL_FIELDS) {
			expect(field in session, field).toBe(false);
		}
		expect(session.aiTabs[0].permissionMode).toBeUndefined();
		expect(session.aiTabs[0].readOnlyMode).toBeUndefined();
	});

	it('stores every setting the draft sets', () => {
		const settings: Partial<NewAgentDraft> = {
			nudgeMessage: 'Be terse',
			newSessionMessage: 'Read the README first',
			customPath: '/opt/bin/claude',
			customArgs: '--verbose',
			customEnvVars: { DEBUG: '1' },
			customModel: 'opus',
			customContextWindow: 200000,
			customProviderPath: '/opt/provider',
			customEffort: 'high',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/app',
				syncHistory: true,
			},
			groupId: 'group-1',
			enableMaestroP: true,
			maestroPPath: '/opt/maestro-p',
			maestroPMode: 'interactive',
			retryOnAvailabilityErrors: true,
			retryOnTokenExhaustion: true,
			additionalDirectories: [{ path: '/shared', read: true, write: false }],
		};

		const session = buildNewAgentSession(draft(settings), context());

		const { groupId, ...fields } = settings;
		expect(session).toMatchObject(fields);
		expect(session.groupId).toBe(groupId);
	});

	it('keeps an explicit false, an empty list and an empty environment: each is a choice', () => {
		const session = buildNewAgentSession(
			draft({
				enableMaestroP: false,
				retryOnAvailabilityErrors: false,
				retryOnTokenExhaustion: false,
				additionalDirectories: [],
				customEnvVars: {},
				sessionSshRemoteConfig: { enabled: false, remoteId: null },
			}),
			context()
		);

		expect(session.enableMaestroP).toBe(false);
		expect(session.retryOnAvailabilityErrors).toBe(false);
		expect(session.retryOnTokenExhaustion).toBe(false);
		expect(session.additionalDirectories).toEqual([]);
		expect(session.customEnvVars).toEqual({});
		expect(session.sessionSshRemoteConfig).toEqual({ enabled: false, remoteId: null });
	});

	it('copies the git state it is handed', () => {
		const session = buildNewAgentSession(
			draft(),
			context({
				git: {
					isGitRepo: true,
					gitBranches: ['main'],
					gitTags: ['v2'],
					gitRefsCacheTime: 42,
				},
			})
		);

		expect(session).toMatchObject({
			isGitRepo: true,
			gitBranches: ['main'],
			gitTags: ['v2'],
			gitRefsCacheTime: 42,
		});
	});

	it.each([
		[{ codexAutoResetOnExhaustion: true }, { codexAutoResetOnExhaustion: true }],
		[{ codexTransport: 'app-server' as const }, { codexTransport: 'app-server' }],
		[{ harnessControlMode: 'native' as const }, { harnessControlMode: 'native' }],
	])('stores the opt-in %o', (setting, stored) => {
		expect(buildNewAgentSession(draft({ agentId: 'codex', ...setting }), context())).toMatchObject(
			stored
		);
	});

	it.each([
		{ codexAutoResetOnExhaustion: false },
		{ codexTransport: 'exec' as const },
		{ harnessControlMode: 'current' as const },
	])('stores no default for %o', (setting) => {
		const session = buildNewAgentSession(draft({ agentId: 'codex', ...setting }), context());

		for (const field of Object.keys(setting)) {
			expect(field in session, field).toBe(false);
		}
	});

	it.each([
		['full', false],
		['standard', false],
		['readonly', true],
	] as const)('starts the tab in %s permission mode', (permissionMode, readOnlyMode) => {
		const session = buildNewAgentSession(draft({ permissionMode }), context());

		expect(session.aiTabs).toHaveLength(1);
		expect(session.aiTabs[0]).toMatchObject({ permissionMode, readOnlyMode });
	});

	it('stamps the fresh Claude mode only on Claude Code', () => {
		expect(buildNewAgentSession(draft(), context()).claudeInteractive).toEqual({
			mode: 'api',
			modeReason: 'auto',
		});
		expect(
			buildNewAgentSession(draft({ agentId: 'codex' }), context()).claudeInteractive
		).toBeUndefined();
	});

	it('opens a terminal agent in terminal mode', () => {
		expect(buildNewAgentSession(draft({ agentId: 'terminal' }), context()).inputMode).toBe(
			'terminal'
		);
	});

	it('changes nothing it is handed', () => {
		const input = draft({
			customEnvVars: { DEBUG: '1' },
			additionalDirectories: [{ path: '/shared', read: true, write: false }],
			permissionMode: 'readonly',
		});
		const ctx = context({ git: { isGitRepo: true, gitBranches: ['main'] } });
		const before = structuredClone({ input, ctx });

		buildNewAgentSession(input, ctx);

		expect({ input, ctx }).toEqual(before);
	});
});
