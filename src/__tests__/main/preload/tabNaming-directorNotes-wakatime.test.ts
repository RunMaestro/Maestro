import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectorNotesApi } from '../../../main/preload/directorNotes';
import { createTabNamingApi } from '../../../main/preload/tabNaming';
import { createWakatimeApi } from '../../../main/preload/wakatime';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

describe('Tab Naming preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('generates a tab name through the expected IPC channel with local config', async () => {
		mockInvoke.mockResolvedValue('Fix failing tests');
		const api = createTabNamingApi();
		const config = {
			userMessage: 'Please fix the failing tests',
			agentType: 'codex',
			cwd: '/repo',
		};

		const result = await api.generateTabName(config);

		expect(mockInvoke).toHaveBeenCalledWith('tabNaming:generateTabName', config);
		expect(result).toBe('Fix failing tests');
	});

	it('preserves SSH remote config and nullable generation results', async () => {
		mockInvoke.mockResolvedValue(null);
		const api = createTabNamingApi();
		const config = {
			userMessage: 'Summarize the remote branch',
			agentType: 'claude-code',
			cwd: '/local/repo',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/repo',
			},
		};

		const result = await api.generateTabName(config);

		expect(mockInvoke).toHaveBeenCalledWith('tabNaming:generateTabName', config);
		expect(result).toBeNull();
	});
});

describe("Director's Notes preload API", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('fetches paginated unified history through the Director Notes IPC channel', async () => {
		const historyResult = {
			entries: [
				{
					id: 'entry-1',
					type: 'AUTO',
					timestamp: 123,
					summary: 'Ran task',
					projectPath: '/repo',
					sourceSessionId: 'session-1',
				},
			],
			total: 1,
			limit: 25,
			offset: 0,
			hasMore: false,
			stats: {
				agentCount: 1,
				sessionCount: 1,
				autoCount: 1,
				userCount: 0,
				totalCount: 1,
			},
		};
		mockInvoke.mockResolvedValue(historyResult);
		const api = createDirectorNotesApi();
		const options = { lookbackDays: 7, filter: 'AUTO' as const, limit: 25, offset: 0 };

		const result = await api.getUnifiedHistory(options);

		expect(mockInvoke).toHaveBeenCalledWith('director-notes:getUnifiedHistory', options);
		expect(result).toEqual(historyResult);
	});

	it('generates a synopsis with provider-specific options', async () => {
		const synopsisResult = {
			success: true,
			synopsis: 'Recent work focused on tests.',
			generatedAt: 456,
			stats: { agentCount: 2, entryCount: 8, durationMs: 1200 },
		};
		mockInvoke.mockResolvedValue(synopsisResult);
		const api = createDirectorNotesApi();
		const options = {
			lookbackDays: 14,
			provider: 'claude-code' as const,
			customPath: '/bin/claude',
			customArgs: '--model test',
			customEnvVars: { ANTHROPIC_BASE_URL: 'https://example.invalid' },
		};

		const result = await api.generateSynopsis(options);

		expect(mockInvoke).toHaveBeenCalledWith('director-notes:generateSynopsis', options);
		expect(result).toEqual(synopsisResult);
	});
});

describe('WakaTime preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('checks CLI availability through IPC', async () => {
		mockInvoke.mockResolvedValue({ available: true, version: '1.100.0' });
		const api = createWakatimeApi();

		const result = await api.checkCli();

		expect(mockInvoke).toHaveBeenCalledWith('wakatime:checkCli');
		expect(result).toEqual({ available: true, version: '1.100.0' });
	});

	it('validates API keys through IPC without local filtering', async () => {
		mockInvoke.mockResolvedValue({ valid: false });
		const api = createWakatimeApi();

		const result = await api.validateApiKey('waka_secret_key');

		expect(mockInvoke).toHaveBeenCalledWith('wakatime:validateApiKey', 'waka_secret_key');
		expect(result).toEqual({ valid: false });
	});
});
