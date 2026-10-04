/**
 * @file maestro-system-prompt.test.ts
 * @description Main-process system prompt builder used by Cue runs, Group Chat
 * participants, and cross-agent consults (and the moderator's plugin-only
 * variant).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => '/data') },
}));

const prompts: Record<string, string> = {};
vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => {
		if (!(id in prompts)) throw new Error(`Unknown prompt ID: ${id}`);
		return prompts[id];
	}),
}));

let storedSessions: Array<Record<string, any>> = [];
let settings: Record<string, unknown> = {};
vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(() => ({ get: vi.fn(() => storedSessions) })),
	getSettingsStore: vi.fn(() => ({ get: vi.fn((key: string) => settings[key]) })),
}));

vi.mock('../../../main/history-manager', () => ({
	getHistoryManager: vi.fn(() => ({
		getHistoryFilePath: vi.fn(async (id: string) => `/data/history/${id}.jsonl`),
	})),
}));

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(async () => ({ exitCode: 0, stdout: 'feature/x\n', stderr: '' })),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	buildMaestroSystemPromptForSession,
	buildPluginSystemPromptSections,
} from '../../../main/utils/maestro-system-prompt';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';

const agent = (overrides: Record<string, any> = {}) => ({
	id: 'agent-1',
	name: 'Alice',
	toolType: 'claude-code',
	cwd: '/proj',
	projectRoot: '/proj',
	isGitRepo: true,
	...overrides,
});

describe('buildMaestroSystemPromptForSession', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of Object.keys(prompts)) delete prompts[key];
		prompts['maestro-system-prompt'] =
			'{{AGENT_NAME}}|{{GIT_BRANCH}}|{{AGENT_HISTORY_PATH}}|{{CONDUCTOR_PROFILE}}|{{COMPUTER_HISTORY_DIR}}';
		prompts['pianola-system'] = 'PIANOLA';
		prompts['computer-history-system'] = 'HISTORY {{COMPUTER_HISTORY_DIR}}';
		storedSessions = [agent()];
		settings = { conductorProfile: 'me' };
	});

	it('builds the base prompt for a stored agent by id', async () => {
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result).toBe('Alice|feature/x|/data/history/agent-1.jsonl|me|/data/computer-history');
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'git',
			['rev-parse', '--abbrev-ref', 'HEAD'],
			'/proj'
		);
	});

	it('accepts an already-loaded record', async () => {
		storedSessions = [];
		const result = await buildMaestroSystemPromptForSession(agent({ name: 'Bob' }) as any);
		expect(result?.startsWith('Bob|')).toBe(true);
	});

	it('skips the git lookup when the agent is not a git repo', async () => {
		storedSessions = [agent({ isGitRepo: false })];
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(result?.split('|')[1]).toBe('');
	});

	it('leaves branch, history, and store path empty for an SSH agent', async () => {
		storedSessions = [agent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })];
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result).toBe('Alice|||me|');
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it('appends the Pianola role section for the Pianola agent', async () => {
		storedSessions = [agent({ isPianola: true })];
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result?.endsWith('\n\n---\n\nPIANOLA')).toBe(true);
	});

	it('appends enabled plugin sections, but not localOnly ones over SSH', async () => {
		settings.encoreFeatures = { computerHistory: true };
		const local = await buildMaestroSystemPromptForSession('agent-1');
		expect(local?.endsWith('\n\n---\n\nHISTORY /data/computer-history')).toBe(true);

		storedSessions = [agent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })];
		const remote = await buildMaestroSystemPromptForSession('agent-1');
		expect(remote).not.toContain('HISTORY');
	});

	it('skips a section whose prompt is missing instead of failing', async () => {
		settings.encoreFeatures = { computerHistory: true };
		delete prompts['computer-history-system'];
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result).toBe('Alice|feature/x|/data/history/agent-1.jsonl|me|/data/computer-history');
		expect(logger.warn).toHaveBeenCalled();
	});

	it('returns undefined (never throws) for an unknown agent or a missing template', async () => {
		await expect(buildMaestroSystemPromptForSession('nobody')).resolves.toBeUndefined();
		delete prompts['maestro-system-prompt'];
		await expect(buildMaestroSystemPromptForSession('agent-1')).resolves.toBeUndefined();
	});
});

describe('buildPluginSystemPromptSections', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of Object.keys(prompts)) delete prompts[key];
		prompts['computer-history-system'] = 'HISTORY {{COMPUTER_HISTORY_DIR}}';
		settings = {};
	});

	it('returns undefined when no plugin section is enabled', () => {
		expect(buildPluginSystemPromptSections({ isSsh: false })).toBeUndefined();
	});

	it('returns the enabled sections with the local store path', () => {
		settings.encoreFeatures = { computerHistory: true };
		expect(buildPluginSystemPromptSections({ isSsh: false })).toBe(
			'HISTORY /data/computer-history'
		);
	});

	it('drops localOnly sections for an SSH moderator', () => {
		settings.encoreFeatures = { computerHistory: true };
		expect(buildPluginSystemPromptSections({ isSsh: true })).toBeUndefined();
	});
});
