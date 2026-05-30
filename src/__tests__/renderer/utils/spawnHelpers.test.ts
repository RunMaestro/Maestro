import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getStdinFlags, prepareMaestroSystemPrompt } from '../../../renderer/utils/spawnHelpers';

vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((content: string, vars: Record<string, any>) => {
		let result = content;
		for (const [key, value] of Object.entries(vars)) {
			if (typeof value === 'string') {
				result = result.replace(`{{${key}}}`, value);
			}
		}
		return result;
	}),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
	},
}));

describe('prepareMaestroSystemPrompt', () => {
	const baseSession = {
		id: 'session-1',
		cwd: '/test/project',
		isGitRepo: false,
		groupId: 'group-1',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			...(window as any).maestro,
			prompts: {
				get: vi.fn().mockResolvedValue({
					success: true,
					content: 'System prompt for {{activeTabId}}',
				}),
			},
			history: {
				getFilePath: vi.fn().mockResolvedValue('/mock/history/path.jsonl'),
			},
		};
	});

	it('returns undefined when prompt load fails', async () => {
		(window as any).maestro.prompts.get.mockResolvedValue({
			success: false,
			error: 'not found',
		});
		const result = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(result).toBeUndefined();
	});

	it('returns undefined when prompt content is empty', async () => {
		(window as any).maestro.prompts.get.mockResolvedValue({
			success: true,
			content: '',
		});
		const result = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(result).toBeUndefined();
	});

	it('returns substituted prompt', async () => {
		const result = await prepareMaestroSystemPrompt({
			session: baseSession,
			activeTabId: 'tab-42',
		});
		expect(result).toBeDefined();
		expect(typeof result).toBe('string');
		expect((window as any).maestro.prompts.get).toHaveBeenCalledWith('maestro-system-prompt');
	});

	it('resolves git branch when session is a git repo', async () => {
		const { gitService } = await import('../../../renderer/services/git');
		const result = await prepareMaestroSystemPrompt({
			session: { ...baseSession, isGitRepo: true },
		});
		expect(result).toBeDefined();
		expect(gitService.getStatus).toHaveBeenCalledWith('/test/project');
	});

	it('skips git branch when session is not a git repo', async () => {
		const { gitService } = await import('../../../renderer/services/git');
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, isGitRepo: false },
		});
		expect(gitService.getStatus).not.toHaveBeenCalled();
	});

	it('handles git status errors gracefully', async () => {
		const { gitService } = await import('../../../renderer/services/git');
		vi.mocked(gitService.getStatus).mockRejectedValueOnce(new Error('git failed'));
		const result = await prepareMaestroSystemPrompt({
			session: { ...baseSession, isGitRepo: true },
		});
		expect(result).toBeDefined();
	});

	it('fetches history file path for non-SSH sessions', async () => {
		await prepareMaestroSystemPrompt({ session: baseSession });
		expect((window as any).maestro.history.getFilePath).toHaveBeenCalledWith('session-1');
	});

	it('skips history file path for SSH sessions (sshRemoteId)', async () => {
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, sshRemoteId: 'remote-1' },
		});
		expect((window as any).maestro.history.getFilePath).not.toHaveBeenCalled();
	});

	it('skips history file path for SSH sessions (sessionSshRemoteConfig)', async () => {
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
		});
		expect((window as any).maestro.history.getFilePath).not.toHaveBeenCalled();
	});

	it('handles history file path errors gracefully', async () => {
		(window as any).maestro.history.getFilePath.mockRejectedValueOnce(new Error('history failed'));
		const result = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(result).toBeDefined();
	});

	it('re-injects prompt on every call (no resume-based skip)', async () => {
		// Regression: prior impl returned undefined when a legacy `agentSessionId`
		// was present. Because Claude Code's --append-system-prompt is NOT persisted
		// into the session transcript, resuming with `--resume` dropped the Maestro
		// prompt from turn 2 onward. The prompt MUST be re-injected on every spawn.
		const first = await prepareMaestroSystemPrompt({ session: baseSession });
		const second = await prepareMaestroSystemPrompt({ session: baseSession });
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect((window as any).maestro.prompts.get).toHaveBeenCalledTimes(2);
	});
});

describe('getStdinFlags', () => {
	afterEach(() => {
		(window as any).maestro = { platform: 'darwin' };
	});

	it('returns both false on non-Windows platforms', () => {
		(window as any).maestro = { platform: 'darwin' };
		const result = getStdinFlags({
			isSshSession: false,
			supportsStreamJsonInput: true,
			hasImages: false,
		});
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});

	it('returns sendPromptViaStdin when Windows + stream-json + images', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({
			isSshSession: false,
			supportsStreamJsonInput: true,
			hasImages: true,
		});
		expect(result).toEqual({ sendPromptViaStdin: true, sendPromptViaStdinRaw: false });
	});

	it('returns sendPromptViaStdinRaw when Windows + stream-json + no images', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({
			isSshSession: false,
			supportsStreamJsonInput: true,
			hasImages: false,
		});
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: true });
	});

	it('returns sendPromptViaStdinRaw when Windows + stream-json unsupported', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({
			isSshSession: false,
			supportsStreamJsonInput: false,
			hasImages: false,
		});
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: true });
	});

	it('returns both false for SSH sessions on Windows', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({
			isSshSession: true,
			supportsStreamJsonInput: true,
			hasImages: true,
		});
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});

	it('returns both false for SSH sessions on Windows without stream-json', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({
			isSshSession: true,
			supportsStreamJsonInput: false,
			hasImages: false,
		});
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});
});
