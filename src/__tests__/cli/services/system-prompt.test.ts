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
	resolveSessionHistoryFilePath: vi.fn(),
}));

vi.mock('../../../shared/maestro-run/state-file', () => ({
	readMaestroRunReadyPath: vi.fn(),
}));

vi.mock('../../../cli/services/git-utils', () => ({
	getGitBranch: vi.fn(),
	isGitRepo: vi.fn(),
}));

import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';
import { getCliPrompt } from '../../../cli/services/prompt-loader';
import { readSettingValue, resolveSessionHistoryFilePath } from '../../../cli/services/storage';
import { getGitBranch, isGitRepo } from '../../../cli/services/git-utils';
import { readMaestroRunReadyPath } from '../../../shared/maestro-run/state-file';

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
		// Maestro Cue ships on and carries a section: switch it off by default so
		// each test sees only the sections it is about.
		vi.mocked(readSettingValue).mockImplementation((key: string) =>
			key === 'encoreFeatures' ? { maestroCue: false } : ''
		);
		// Default: history file does NOT exist (fresh session)
		vi.mocked(resolveSessionHistoryFilePath).mockReturnValue(undefined);
		// Default: the app has not recorded MaestroRun as ready.
		vi.mocked(readMaestroRunReadyPath).mockReturnValue(undefined);
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

	it('substitutes the configured worktree directory, and leaves it empty when unset', async () => {
		// Headless spawns get the same Worktree Directory line as desktop tabs, so
		// an agent started from the CLI creates worktrees where the app will see them.
		vi.mocked(getCliPrompt).mockResolvedValue('Worktrees: [{{WORKTREE_BASE_PATH}}]');

		const configured = await prepareMaestroSystemPromptCli(
			mockSession({
				worktreeConfig: { basePath: '/home/me/Project-WorkTrees', watchEnabled: true },
			})
		);
		expect(configured).toContain('Worktrees: [/home/me/Project-WorkTrees]');

		const unset = await prepareMaestroSystemPromptCli(mockSession({ worktreeConfig: undefined }));
		expect(unset).toContain('Worktrees: []');
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

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBe('history=[]');
	});

	it('includes the history file path when the file exists locally', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');
		vi.mocked(resolveSessionHistoryFilePath).mockReturnValue('/mock/config/history/sess-1.jsonl');

		const result = await prepareMaestroSystemPromptCli(mockSession({ id: 'sess-1' }));

		expect(resolveSessionHistoryFilePath).toHaveBeenCalledWith('sess-1');
		expect(result).toBe('history=[/mock/config/history/sess-1.jsonl]');
	});

	it('skips the history file pointer for SSH sessions (path is local-only)', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('history=[{{AGENT_HISTORY_PATH}}]');
		vi.mocked(resolveSessionHistoryFilePath).mockReturnValue('/mock/config/history/x.jsonl');

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
		vi.mocked(readSettingValue).mockImplementation((key: string) =>
			key === 'encoreFeatures' ? { maestroCue: false } : { accidentallyAnObject: true }
		);

		const result = await prepareMaestroSystemPromptCli(mockSession());

		expect(result).toBe('cond=[]');
	});

	describe('role and plugin sections', () => {
		const prompts: Record<string, string> = {
			'maestro-system-prompt': 'BASE {{AGENT_NAME}}',
			'pianola-system': 'PIANOLA',
			'computer-history-system': 'HISTORY at {{COMPUTER_HISTORY_DIR}}',
			'cue-system': 'CUE for {{AGENT_NAME}}',
		};
		const settings = (encoreFeatures: Record<string, unknown>) => (key: string) =>
			key === 'encoreFeatures' ? { maestroCue: false, ...encoreFeatures } : '';

		beforeEach(() => {
			vi.mocked(getCliPrompt).mockImplementation(async (id: string) => {
				if (id in prompts) return prompts[id];
				throw new Error(`Failed to load prompt "${id}" (${id}.md)`);
			});
		});

		it('appends nothing extra while every section flag is off', async () => {
			const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
			expect(result).toBe('BASE A');
		});

		it('appends the Maestro Cue section while Cue is on (its shipped default)', async () => {
			vi.mocked(readSettingValue).mockImplementation((key: string) =>
				key === 'encoreFeatures' ? {} : ''
			);
			const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
			expect(result).toBe('BASE A\n\n---\n\nCUE for A');
		});

		it('appends the Pianola role section for the Pianola agent', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ pianola: true }));
			const result = await prepareMaestroSystemPromptCli(
				mockSession({ name: 'A', isPianola: true })
			);
			expect(result).toBe('BASE A\n\n---\n\nPIANOLA');
		});

		it('leaves the Pianola role section out while the pianola flag is off', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ pianola: false }));
			const result = await prepareMaestroSystemPromptCli(
				mockSession({ name: 'A', isPianola: true })
			);
			expect(result).toBe('BASE A');
		});

		it('appends the Computer History section with the local store path when enabled', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ computerHistory: true }));

			const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));

			expect(result).toBe('BASE A\n\n---\n\nHISTORY at /mock/config/computer-history');
		});

		describe('MaestroRun', () => {
			const LAUNCHER = '/Users/me/Applications/MaestroRun.app/Contents/MacOS/maestro-run';

			beforeEach(() => {
				prompts['maestro-run-system'] = 'RUN {{MAESTRO_RUN_PATH}}';
				vi.mocked(readSettingValue).mockImplementation(settings({ maestroRun: true }));
			});

			it('is left out while the app has not recorded the launcher as ready', async () => {
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
				expect(result).toBe('BASE A');
				expect(readMaestroRunReadyPath).toHaveBeenCalledWith('/mock/config');
			});

			it('is appended with the launcher path once the state file says ready', async () => {
				vi.mocked(readMaestroRunReadyPath).mockReturnValue(LAUNCHER);
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
				expect(result).toBe(`BASE A\n\n---\n\nRUN ${LAUNCHER}`);
			});

			it('is left out when ready but the flag is off', async () => {
				vi.mocked(readMaestroRunReadyPath).mockReturnValue(LAUNCHER);
				vi.mocked(readSettingValue).mockImplementation(settings({ maestroRun: false }));
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
			});

			it('is never given to an SSH agent, and the state file is not read', async () => {
				vi.mocked(readMaestroRunReadyPath).mockReturnValue(LAUNCHER);
				const result = await prepareMaestroSystemPromptCli(
					mockSession({ name: 'A', sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
				);
				expect(result).toBe('BASE A');
				expect(readMaestroRunReadyPath).not.toHaveBeenCalled();
			});
		});

		it('skips the localOnly Computer History section for SSH agents', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ computerHistory: true }));

			const result = await prepareMaestroSystemPromptCli(
				mockSession({ name: 'A', sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
			);

			expect(result).toBe('BASE A');
		});

		it('skips a section whose prompt file is missing instead of dropping the whole prompt', async () => {
			vi.mocked(readSettingValue).mockImplementation(settings({ computerHistory: true }));
			delete prompts['computer-history-system'];
			const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));

			expect(result).toBe('BASE A');
			expect(errSpy).toHaveBeenCalled();
			errSpy.mockRestore();
			prompts['computer-history-system'] = 'HISTORY at {{COMPUTER_HISTORY_DIR}}';
		});
	});
});
