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

vi.mock('../../../main/user-journey-manager', () => ({
	getJourneyFilePath: vi.fn((id: string) => `/data/journey/${id}.jsonl`),
}));

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(async () => ({ exitCode: 0, stdout: 'feature/x\n', stderr: '' })),
}));

let bundledCliPath: string | null = null;
vi.mock('../../../main/maestro-cli-manager', () => ({
	resolveBundledCliPathSync: vi.fn(() => bundledCliPath),
}));

/** The MaestroRun launcher path while ready; undefined otherwise. `null` = no service yet. */
let maestroRun: { fresh?: string; cached?: string; throws?: boolean } | null = null;
vi.mock('../../../main/maestro-run', () => ({
	getMaestroRunService: vi.fn(() =>
		maestroRun
			? {
					readyBinaryPath: vi.fn(async () => {
						if (maestroRun?.throws) throw new Error('doctor exploded');
						return maestroRun?.fresh;
					}),
					readyBinaryPathCached: vi.fn(() => maestroRun?.cached),
				}
			: null
	),
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

	it('fills the journey path, and leaves it empty for an SSH agent', async () => {
		prompts['maestro-system-prompt'] = 'journey=[{{AGENT_JOURNEY_PATH}}]';
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe(
			'journey=[/data/journey/agent-1.jsonl]'
		);
		storedSessions = [agent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })];
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('journey=[]');
	});

	it('appends the Pianola role section for the Pianola agent', async () => {
		settings.encoreFeatures = { pianola: true };
		storedSessions = [agent({ isPianola: true })];
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result?.endsWith('\n\n---\n\nPIANOLA')).toBe(true);
	});

	it('leaves the Pianola role section out while the pianola flag is off', async () => {
		settings.encoreFeatures = { pianola: false };
		storedSessions = [agent({ isPianola: true })];
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result).not.toContain('PIANOLA');
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

describe('the MaestroRun section (main builder)', () => {
	const LAUNCHER = '/Users/me/Applications/MaestroRun.app/Contents/MacOS/maestro-run';

	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of Object.keys(prompts)) delete prompts[key];
		prompts['maestro-system-prompt'] = 'BASE';
		prompts['maestro-run-system'] = 'RUN {{MAESTRO_RUN_PATH}}';
		storedSessions = [agent()];
		settings = { encoreFeatures: { maestroRun: true } };
		maestroRun = null;
	});

	it('is left out while the flag is on but the launcher is not ready', async () => {
		maestroRun = { fresh: undefined };
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
		maestroRun = null; // no service at all (headless boot)
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
	});

	it('is appended with the launcher path once the service says ready', async () => {
		maestroRun = { fresh: LAUNCHER };
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe(
			`BASE\n\n---\n\nRUN ${LAUNCHER}`
		);
	});

	it('is never given to an SSH agent, and the service is not asked', async () => {
		maestroRun = { fresh: LAUNCHER };
		storedSessions = [agent({ sshRemoteId: 'remote-1' })];
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
	});

	it('is left out when the flag is off, even if the launcher is ready', async () => {
		maestroRun = { fresh: LAUNCHER };
		settings = { encoreFeatures: { maestroRun: false } };
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
	});

	it('reads a failed readiness check as not ready instead of failing the spawn', async () => {
		maestroRun = { throws: true };
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
		expect(logger.warn).toHaveBeenCalled();
	});

	it('uses the cached answer for the synchronous moderator variant', () => {
		maestroRun = { fresh: LAUNCHER, cached: undefined };
		expect(buildPluginSystemPromptSections({ isSsh: false })).toBeUndefined();
		maestroRun = { cached: LAUNCHER };
		expect(buildPluginSystemPromptSections({ isSsh: false })).toBe(`RUN ${LAUNCHER}`);
		expect(buildPluginSystemPromptSections({ isSsh: true })).toBeUndefined();
	});
});

describe('buildPluginSystemPromptSections', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of Object.keys(prompts)) delete prompts[key];
		prompts['computer-history-system'] = 'HISTORY {{COMPUTER_HISTORY_DIR}}';
		settings = {};
		maestroRun = null;
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

	it('points {{MAESTRO_CLI_PATH}} at the CLI the app resolved, not the default install path', () => {
		settings.encoreFeatures = { computerHistory: true };
		prompts['computer-history-system'] = 'RUN {{MAESTRO_CLI_PATH}} computer-history';
		bundledCliPath = '/work/maestro/dist/cli/maestro-cli.js';
		try {
			expect(buildPluginSystemPromptSections({ isSsh: false })).toBe(
				'RUN node "/work/maestro/dist/cli/maestro-cli.js" computer-history'
			);
		} finally {
			bundledCliPath = null;
		}
	});
});
