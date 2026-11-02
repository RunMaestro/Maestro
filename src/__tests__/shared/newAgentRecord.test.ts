/**
 * The shared new-agent skeleton. The desktop treats an agent with no tabs of
 * any kind as corrupted on restore, so every record this builds must carry
 * exactly one AI tab that the active tab and the unified tab order agree on.
 */

import { describe, it, expect } from 'vitest';
import {
	buildDuplicateAgentInput,
	buildNewAgentRecord,
	defaultDuplicateAgentName,
	duplicateAgentBlocker,
	newAgentClaudeInteractive,
	type DuplicateAgentSource,
} from '../../shared/newAgentRecord';

function idSource() {
	let n = 0;
	return () => `id-${++n}`;
}

describe('buildNewAgentRecord', () => {
	it('starts with one idle AI tab that the active tab and the tab order point at', () => {
		const record = buildNewAgentRecord(
			{ id: 'agent-1', name: 'Alpha', toolType: 'codex', cwd: '/work/proj' },
			{ generateId: idSource(), now: 1000 }
		);
		expect(record.aiTabs).toHaveLength(1);
		const [tab] = record.aiTabs;
		expect(tab).toMatchObject({ agentSessionId: null, state: 'idle', createdAt: 1000 });
		expect(record.activeTabId).toBe(tab.id);
		expect(record.unifiedTabOrder).toEqual([{ type: 'ai', id: tab.id }]);
	});

	it('roots the agent, its shell and its Auto Run folder at cwd', () => {
		const record = buildNewAgentRecord(
			{ id: 'a', name: 'A', toolType: 'claude-code', cwd: '/work/proj' },
			{ generateId: idSource() }
		);
		expect(record).toMatchObject({
			id: 'a',
			cwd: '/work/proj',
			fullPath: '/work/proj',
			projectRoot: '/work/proj',
			shellCwd: '/work/proj',
			autoRunFolderPath: '/work/proj/.maestro/playbooks',
			inputMode: 'ai',
			fileTreeAutoRefreshInterval: 180,
			aiPid: 0,
		});
	});

	it('takes an explicit Auto Run folder, group and tab defaults', () => {
		const record = buildNewAgentRecord(
			{
				id: 'a',
				name: 'A',
				toolType: 'codex',
				cwd: '/p',
				autoRunFolderPath: '/p/docs/runs',
				groupId: 'g1',
				saveToHistory: false,
				showThinking: 'sticky',
			},
			{ generateId: idSource() }
		);
		expect(record.autoRunFolderPath).toBe('/p/docs/runs');
		expect(record.groupId).toBe('g1');
		expect(record.aiTabs[0]).toMatchObject({ saveToHistory: false, showThinking: 'sticky' });
	});

	it('leaves the tab defaults unset when the caller has none', () => {
		const record = buildNewAgentRecord(
			{ id: 'a', name: 'A', toolType: 'codex', cwd: '/p' },
			{ generateId: idSource() }
		);
		expect('saveToHistory' in record.aiTabs[0]).toBe(false);
		expect('showThinking' in record.aiTabs[0]).toBe(false);
	});

	it('opens a terminal agent in terminal mode', () => {
		const record = buildNewAgentRecord(
			{ id: 'a', name: 'A', toolType: 'terminal', cwd: '/p' },
			{ generateId: idSource() }
		);
		expect(record.inputMode).toBe('terminal');
	});
});

describe('newAgentClaudeInteractive', () => {
	it('starts Claude Code in automatic API mode and leaves other providers unset', () => {
		expect(newAgentClaudeInteractive('claude-code')).toEqual({ mode: 'api', modeReason: 'auto' });
		expect(newAgentClaudeInteractive('codex')).toBeUndefined();
	});
});

describe('buildDuplicateAgentInput', () => {
	const source: DuplicateAgentSource = {
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: '/work/proj',
		groupId: 'g1',
		additionalDirectories: [{ path: '/shared/docs', read: true, write: false }],
		nudgeMessage: ' be brief ',
		newSessionMessage: 'hello',
		customPath: '/opt/claude',
		customArgs: '--verbose',
		customEnvVars: { DEBUG: '1' },
		customModel: 'opus',
		customContextWindow: 200000,
		customProviderPath: '/opt/provider',
		customEffort: 'high',
		enableMaestroP: true,
		maestroPMode: 'interactive',
		maestroPPath: '/opt/maestro-p',
		retryOnAvailabilityErrors: false,
		retryOnTokenExhaustion: undefined,
		codexAutoResetOnExhaustion: true,
		codexTransport: 'app-server',
	};

	it('copies the provider, directory, group and every custom setting', () => {
		expect(buildDuplicateAgentInput(source)).toEqual({
			toolType: 'claude-code',
			name: 'Alpha (Copy)',
			cwd: '/work/proj',
			groupId: 'g1',
			additionalDirectories: [{ path: '/shared/docs', read: true, write: false }],
			nudgeMessage: 'be brief',
			newSessionMessage: 'hello',
			customPath: '/opt/claude',
			customArgs: '--verbose',
			customEnvVars: { DEBUG: '1' },
			customModel: 'opus',
			customContextWindow: 200000,
			customProviderPath: '/opt/provider',
			customEffort: 'high',
			enableMaestroP: true,
			maestroPMode: 'interactive',
			maestroPPath: '/opt/maestro-p',
			retryOnAvailabilityErrors: false,
			retryOnTokenExhaustion: true,
			codexAutoResetOnExhaustion: true,
			codexTransport: 'app-server',
			sessionSshRemoteConfig: { enabled: false, remoteId: null },
		});
	});

	it('clones additional directories and env vars instead of aliasing them', () => {
		const input = buildDuplicateAgentInput(source);
		expect(input.additionalDirectories[0]).not.toBe(source.additionalDirectories![0]);
		expect(input.customEnvVars).not.toBe(source.customEnvVars);
	});

	it('falls back to the fresh-agent defaults for an unconfigured source', () => {
		const input = buildDuplicateAgentInput({ name: 'B', toolType: 'codex', cwd: '/p' });
		expect(input).toEqual({
			toolType: 'codex',
			name: 'B (Copy)',
			cwd: '/p',
			groupId: undefined,
			additionalDirectories: [],
			nudgeMessage: undefined,
			newSessionMessage: undefined,
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
			customModel: undefined,
			customContextWindow: undefined,
			customProviderPath: undefined,
			customEffort: undefined,
			// Unset stays unset: the same default path a fresh agent takes.
			enableMaestroP: undefined,
			maestroPMode: undefined,
			maestroPPath: undefined,
			retryOnAvailabilityErrors: true,
			retryOnTokenExhaustion: true,
			codexAutoResetOnExhaustion: false,
			codexTransport: 'exec',
			sessionSshRemoteConfig: { enabled: false, remoteId: null },
		});
	});

	it('keeps an explicit Adaptive Mode off and drops its refinements', () => {
		const input = buildDuplicateAgentInput({
			...source,
			enableMaestroP: false,
			maestroPMode: 'interactive',
			maestroPPath: '/opt/maestro-p',
		});
		expect(input.enableMaestroP).toBe(false);
		expect(input.maestroPMode).toBeUndefined();
		expect(input.maestroPPath).toBeUndefined();
	});

	it('defaults the token-source mode to dynamic when Adaptive Mode is on', () => {
		const input = buildDuplicateAgentInput({ ...source, maestroPMode: undefined });
		expect(input.maestroPMode).toBe('dynamic');
	});

	it('treats blank strings and an empty env map as unset', () => {
		const input = buildDuplicateAgentInput({
			...source,
			customPath: '  ',
			customArgs: '',
			customEnvVars: {},
			customEffort: ' ',
		});
		expect(input.customPath).toBeUndefined();
		expect(input.customArgs).toBeUndefined();
		expect(input.customEnvVars).toBeUndefined();
		expect(input.customEffort).toBeUndefined();
	});

	it('starts an SSH copy in the remote override and gives it its own override', () => {
		const input = buildDuplicateAgentInput({
			...source,
			cwd: '/local/placeholder',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/app',
			},
		});
		expect(input.cwd).toBe('/srv/app');
		expect(input.sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/srv/app',
		});
	});

	it('never carries the stored SSH override or history-sync flags to a moved copy', () => {
		const input = buildDuplicateAgentInput(
			{
				...source,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/srv/app',
					syncHistory: true,
					shareHistoryToProjectDir: true,
				} as DuplicateAgentSource['sessionSshRemoteConfig'],
			},
			{ cwd: '/srv/other' }
		);
		expect(input.cwd).toBe('/srv/other');
		expect(input.sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/srv/other',
		});
	});

	it('runs locally when SSH is configured but disabled or has no remote', () => {
		const disabled = buildDuplicateAgentInput({
			...source,
			sessionSshRemoteConfig: { enabled: false, remoteId: 'r', workingDirOverride: '/srv' },
		});
		expect(disabled.cwd).toBe('/work/proj');
		expect(disabled.sessionSshRemoteConfig).toEqual({ enabled: false, remoteId: null });
		const noRemote = buildDuplicateAgentInput({
			...source,
			sessionSshRemoteConfig: { enabled: true, remoteId: null },
		});
		expect(noRemote.sessionSshRemoteConfig).toEqual({ enabled: false, remoteId: null });
	});

	it('applies name, group and working directory overrides', () => {
		const input = buildDuplicateAgentInput(source, {
			name: ' Beta ',
			groupId: 'g2',
			cwd: '/elsewhere',
		});
		expect(input).toMatchObject({ name: 'Beta', groupId: 'g2', cwd: '/elsewhere' });
	});

	it('moves the copy out of every group with a null group override', () => {
		expect(buildDuplicateAgentInput(source, { groupId: null }).groupId).toBeUndefined();
	});
});

describe('duplicate agent helpers', () => {
	it('names a copy after its source', () => {
		expect(defaultDuplicateAgentName('Alpha')).toBe('Alpha (Copy)');
	});

	it('refuses only the Pianola manager', () => {
		expect(duplicateAgentBlocker({ isPianola: true })).toMatch(/Pianola/);
		expect(duplicateAgentBlocker({ isPianola: false })).toBeNull();
		expect(duplicateAgentBlocker({})).toBeNull();
	});
});
