/**
 * @file system-prompt.test.ts
 * @description Tests for `prepareMaestroSystemPromptCli` - the CLI-side
 * builder that loads `maestro-system-prompt`, threads in branch / history /
 * conductor context, and returns the substituted template for use as
 * `appendSystemPrompt`. Mirrors the renderer's `prepareMaestroSystemPrompt`
 * in `src/renderer/utils/spawnHelpers.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getConfigDirectory: vi.fn(() => '/mock/config'),
	readSettingValue: vi.fn(),
}));

vi.mock('../../../cli/services/git-utils', () => ({
	getGitBranch: vi.fn(),
	isGitRepo: vi.fn(),
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	// `actual.constants` is a getter on the fs module - spreading `actual`
	// drops it (only own enumerable data properties carry through), and
	// production code reads `fs.constants.R_OK`. Inline the literal so the
	// mock surface still exposes a usable constants object.
	const mocked = {
		...actual,
		accessSync: vi.fn(),
		constants: { ...actual.constants, R_OK: 4 },
	};
	return { ...mocked, default: mocked };
});

import fs from 'fs';
import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';
import { getCliPrompt } from '../../../cli/services/prompt-loader';
import { readSettingValue } from '../../../cli/services/storage';
import { getGitBranch, isGitRepo } from '../../../cli/services/git-utils';

const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	id: 'agent-abc-123',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/path/to/project',
	projectRoot: '/path/to/project',
	...overrides,
});

describe('prepareMaestroSystemPromptCli', () => {
	beforeEach(() => {
		// Clear call history but keep implementations - explicit per-test
		// defaults below so behavior is unambiguous.
		vi.clearAllMocks();
		// Re-establish the mocked storage default since resetAllMocks would
		// nuke it, and we want a stable getConfigDirectory return value.
		vi.mocked(isGitRepo).mockReturnValue(true);
		vi.mocked(getGitBranch).mockReturnValue('main');
		vi.mocked(readSettingValue).mockReturnValue('');
		vi.mocked(fs.accessSync).mockImplementation(() => {
			// Default: history file does NOT exist (fresh session)
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});
	});

	it('substitutes agent identity, branch, and conductor profile into the template', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue(
			'You are {{AGENT_NAME}} on branch {{GIT_BRANCH}}.\nConductor: {{CONDUCTOR_PROFILE}}'
		);
		vi.mocked(readSettingValue).mockReturnValue('senior engineer, prefers concise');

		const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'Codex Bot' }));

		expect(result).toContain('You are Codex Bot on branch main.');
		expect(result).toContain('Conductor: senior engineer, prefers concise');
	});

	it('returns undefined when the prompt template fails to load (non-fatal)', async () => {
		vi.mocked(getCliPrompt).mockRejectedValue(
			new Error('Failed to load prompt "maestro-system-prompt" (maestro-system-prompt.md)')
		);

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBeUndefined();
	});

	it('re-throws unexpected errors so genuine bugs surface (not just "failed to load")', async () => {
		// A non-"Failed to load…" error indicates a bug in the loader or a
		// caller misuse - those must propagate so the user sees them rather
		// than silently spawning without a system prompt.
		vi.mocked(getCliPrompt).mockRejectedValue(new TypeError('something is undefined'));

		await expect(prepareMaestroSystemPromptCli(mockSession())).rejects.toThrow(
			/something is undefined/
		);
	});

	it('skips git branch lookup when the cwd is not a git repo', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('branch=[{{GIT_BRANCH}}]');
		vi.mocked(isGitRepo).mockReturnValue(false);

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(getGitBranch).not.toHaveBeenCalled();
		expect(result).toBe('branch=[]');
	});

	it('omits the history file path when one is not yet written (fresh session)', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');
		// fs.accessSync is already mocked to throw ENOENT in beforeEach

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBe('history=[]');
	});

	it('includes the history file path when the file exists locally', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');
		// Override the throw-by-default beforeEach with a no-op success.
		vi.mocked(fs.accessSync).mockImplementation(() => undefined);

		const result = await prepareMaestroSystemPromptCli(mockSession({ id: 'sess-1' }));

		// Sanitized session id forms the filename
		expect(result).toMatch(/history=\[.*sess-1\.json\]/);
	});

	it('skips the history file pointer for SSH sessions (path is local-only)', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');
		vi.mocked(fs.accessSync).mockImplementation(() => undefined);

		const result = await prepareMaestroSystemPromptCli(
			mockSession({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote1' },
			})
		);

		expect(result).toBe('history=[]');
	});

	it('tolerates a non-string conductor profile setting', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('cond=[{{CONDUCTOR_PROFILE}}]');
		// e.g. a malformed settings file with a non-string value
		vi.mocked(readSettingValue).mockReturnValue({ accidentallyAnObject: true });

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBe('cond=[]');
	});
});
