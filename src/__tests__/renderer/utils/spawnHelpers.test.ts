import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	loadJourneyFilePath,
	prepareMaestroSystemPrompt,
} from '../../../renderer/utils/spawnHelpers';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { gitService } from '../../../renderer/services/git';
import { resetStore } from '../../helpers/resetStores';

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
			journey: {
				getPath: vi.fn().mockResolvedValue('/mock/journey/session-1.jsonl'),
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

	it('fetches local history when only an observed SSH remote remains', async () => {
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, sshRemoteId: 'remote-1' },
		});
		expect((window as any).maestro.history.getFilePath).toHaveBeenCalledWith('session-1');
	});

	it('skips history file path for SSH sessions (sessionSshRemoteConfig)', async () => {
		await prepareMaestroSystemPrompt({
			session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
		});
		expect((window as any).maestro.history.getFilePath).not.toHaveBeenCalled();
	});

	it('reads the journey path for non-SSH sessions', async () => {
		await prepareMaestroSystemPrompt({ session: baseSession });
		expect((window as any).maestro.journey.getPath).toHaveBeenCalledWith('session-1');
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
		// The base prompt each time, plus the Maestro Cue section (Cue ships on).
		const ids = (window as any).maestro.prompts.get.mock.calls.map((call: unknown[]) => call[0]);
		expect(ids.filter((id: string) => id === 'maestro-system-prompt')).toHaveLength(2);
	});

	describe('Grok selected launch context', () => {
		let savedSettings: ReturnType<typeof useSettingsStore.getState>;
		const session = {
			...baseSession,
			name: 'Selected Grok',
			toolType: 'grok',
			isGitRepo: true,
			fullPath: '/selected/root',
			projectRoot: '/different/project',
			cwd: '/selected/root/subdir',
			remoteCwd: '/stale/terminal',
			sshRemoteId: 'stale-host',
			agentSessionId: 'legacy-native',
			activeTabId: 'other-tab',
			aiTabs: [
				{ id: 'other-tab', agentSessionId: 'other-native' },
				{ id: 'resumed-tab', agentSessionId: 'selected-native' },
				{ id: 'fresh-tab', agentSessionId: null },
			],
			orphanedThinkingTabs: [{ id: 'orphan-tab', agentSessionId: 'orphan-native' }],
		};

		beforeEach(() => {
			savedSettings = useSettingsStore.getState();
			resetStore(useSettingsStore);
			useSettingsStore.setState({ conductorProfile: 'Selected conductor' });
			vi.mocked(gitService.getStatus)
				.mockReset()
				.mockResolvedValue({ branch: 'selected-branch', files: [] });
			vi.mocked(window.maestro.prompts.get).mockImplementation(async (id) =>
				id === 'maestro-system-prompt'
					? {
							success: true,
							content: [
								'{{AGENT_ID}}|{{TOOL_TYPE}}|{{AGENT_PATH}}|{{PROJECT_PATH}}|{{CWD}}',
								'git={{GIT_BRANCH}}|{{IS_GIT_REPO}}|history={{AGENT_HISTORY_PATH}}',
								'tab={{TAB_ID}}|native={{AGENT_SESSION_ID}}|{{TAB_NAME}}|{{SESSION_NAME}}',
								'{{CONDUCTOR_PROFILE}}',
							].join('\n'),
						}
					: { success: false }
			);
		});

		afterEach(() => {
			useSettingsStore.setState(savedSettings, true);
			vi.mocked(gitService.getStatus).mockReset().mockResolvedValue({ branch: 'main', files: [] });
		});

		it.each([undefined, { enabled: false, remoteId: 'disabled-host' }])(
			'uses the local launch cwd despite stale observed SSH fields (%j)',
			async (sessionSshRemoteConfig) => {
				const selected = { ...session, sessionSshRemoteConfig };
				const before = structuredClone(selected);
				const result = await prepareMaestroSystemPrompt({
					session: selected,
					activeTabId: 'resumed-tab',
				});
				expect(gitService.getStatus).toHaveBeenCalledExactlyOnceWith('/selected/root/subdir');
				expect(window.maestro.history.getFilePath).toHaveBeenCalledExactlyOnceWith(session.id);
				expect(result).toBe(
					[
						'session-1|grok|/selected/root|/selected/root|/selected/root/subdir',
						'git=selected-branch|true|history=/mock/history/path.jsonl',
						'tab=resumed-tab|native=selected-native|Selected Grok|Selected Grok',
						'Selected conductor',
					].join('\n')
				);
				expect(selected).toEqual(before);
			}
		);

		it.each(['selected-host', null, undefined])(
			'keeps configured SSH context remote when the selected ID is %s',
			async (remoteId) => {
				const result = await prepareMaestroSystemPrompt({
					session: { ...session, sessionSshRemoteConfig: { enabled: true, remoteId } },
					activeTabId: 'resumed-tab',
				});
				if (remoteId) {
					expect(gitService.getStatus).toHaveBeenCalledExactlyOnceWith(
						'/selected/root/subdir',
						'selected-host'
					);
				} else {
					expect(gitService.getStatus).not.toHaveBeenCalled();
				}
				expect(window.maestro.history.getFilePath).not.toHaveBeenCalled();
				expect(result).toBe(
					[
						'session-1|grok|/selected/root|/selected/root|/selected/root/subdir',
						`git=${remoteId ? 'selected-branch' : ''}|true|history=`,
						'tab=resumed-tab|native=selected-native|Selected Grok|Selected Grok',
						'Selected conductor',
					].join('\n')
				);
			}
		);

		it.each([
			['resumed-tab', 'selected-native'],
			['fresh-tab', ''],
			['not-created-tab', ''],
			['orphan-tab', 'orphan-native'],
			[undefined, 'legacy-native'],
		])(
			'projects native identity for target %s without borrowing the active tab',
			async (tab, id) => {
				const before = structuredClone(session);
				const result = await prepareMaestroSystemPrompt({ session, activeTabId: tab });
				expect(result).toContain(`tab=${tab ?? ''}|native=${id}|Selected Grok|Selected Grok`);
				expect(result).not.toContain('other-native');
				expect(session).toEqual(before);
			}
		);

		it('keeps legacy project/name aliases and omits native identity for headless callers without one', async () => {
			const result = await prepareMaestroSystemPrompt({
				session: { ...session, fullPath: undefined, agentSessionId: undefined },
			});
			expect(result).toContain(
				'session-1|grok|/different/project|/different/project|/selected/root/subdir'
			);
			expect(result).toContain('tab=|native=|Selected Grok|Selected Grok');
		});
	});

	describe('role and plugin sections (shared assembler)', () => {
		const prompts: Record<string, string> = {
			'maestro-system-prompt': 'BASE',
			'pianola-system': 'PIANOLA',
			'computer-history-system': 'HISTORY {{COMPUTER_HISTORY_DIR}}',
		};
		let savedEncore: unknown;

		beforeEach(() => {
			savedEncore = useSettingsStore.getState().encoreFeatures;
			(window as any).maestro.prompts.get = vi.fn(async (id: string) =>
				id in prompts ? { success: true, content: prompts[id] } : { success: false }
			);
			(window as any).maestro.prompts.getSystemPromptPaths = vi
				.fn()
				.mockResolvedValue({ success: true, computerHistoryDir: '/ud/computer-history' });
		});

		afterEach(() => {
			useSettingsStore.setState({ encoreFeatures: savedEncore as any });
		});

		const enableComputerHistory = () =>
			useSettingsStore.setState({
				encoreFeatures: { ...(savedEncore as any), computerHistory: true },
			});

		it('returns only the base prompt while no section applies', async () => {
			useSettingsStore.setState({
				encoreFeatures: { ...(savedEncore as any), computerHistory: false },
			});
			const result = await prepareMaestroSystemPrompt({ session: baseSession });
			expect(result).toBe('BASE');
		});

		it('appends the Pianola role section for the Pianola agent', async () => {
			useSettingsStore.setState({
				encoreFeatures: { ...(savedEncore as any), computerHistory: false, pianola: true },
			});
			const result = await prepareMaestroSystemPrompt({
				session: { ...baseSession, isPianola: true },
			});
			expect(result).toBe('BASE\n\n---\n\nPIANOLA');
		});

		it('leaves the Pianola role section out while the pianola flag is off', async () => {
			useSettingsStore.setState({
				encoreFeatures: { ...(savedEncore as any), computerHistory: false, pianola: false },
			});
			const result = await prepareMaestroSystemPrompt({
				session: { ...baseSession, isPianola: true },
			});
			expect(result).toBe('BASE');
		});

		it('appends the Computer History section with the local store path when enabled', async () => {
			enableComputerHistory();
			const result = await prepareMaestroSystemPrompt({ session: baseSession });
			expect(result).toBe('BASE\n\n---\n\nHISTORY /ud/computer-history');
			expect((window as any).maestro.prompts.get).toHaveBeenCalledWith('computer-history-system');
		});

		it.each([undefined, { enabled: false, remoteId: 'disabled-host' }])(
			'keeps local plugin context after an observed SSH connection (%j)',
			async (sessionSshRemoteConfig) => {
				enableComputerHistory();
				const result = await prepareMaestroSystemPrompt({
					session: {
						...baseSession,
						toolType: 'grok',
						sshRemoteId: 'stale-host',
						sessionSshRemoteConfig,
					},
				});
				expect(result).toBe('BASE\n\n---\n\nHISTORY /ud/computer-history');
			}
		);

		it.each([undefined, 'selected-host'])(
			'skips local plugin paths for SSH target %s',
			async (remoteId) => {
				enableComputerHistory();
				const result = await prepareMaestroSystemPrompt({
					session: {
						...baseSession,
						toolType: 'grok',
						sshRemoteId: 'stale-host',
						sessionSshRemoteConfig: { enabled: true, remoteId },
					},
				});
				expect(result).toBe('BASE');
				expect((window as any).maestro.prompts.get).not.toHaveBeenCalledWith(
					'computer-history-system'
				);
				expect(window.maestro.prompts.getSystemPromptPaths).not.toHaveBeenCalled();
			}
		);

		describe('MaestroRun', () => {
			const LAUNCHER = '/Users/me/Applications/MaestroRun.app/Contents/MacOS/maestro-run';
			const readyPath = () =>
				(window as any).maestro.maestroRun.readyPath as ReturnType<typeof vi.fn>;

			beforeEach(() => {
				prompts['maestro-run-system'] = 'RUN {{MAESTRO_RUN_PATH}}';
				readyPath().mockReset();
				readyPath().mockResolvedValue(null);
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: false, maestroRun: true },
				});
			});

			afterEach(() => {
				delete prompts['maestro-run-system'];
			});

			it('is left out while the tile is on but the launcher is not ready', async () => {
				const result = await prepareMaestroSystemPrompt({ session: baseSession });
				expect(result).toBe('BASE');
				expect(readyPath()).toHaveBeenCalledTimes(1);
				expect((window as any).maestro.prompts.get).not.toHaveBeenCalledWith('maestro-run-system');
			});

			it('is appended with the launcher path once main says ready', async () => {
				readyPath().mockResolvedValue(LAUNCHER);
				const result = await prepareMaestroSystemPrompt({ session: baseSession });
				expect(result).toBe(`BASE\n\n---\n\nRUN ${LAUNCHER}`);
			});

			it('asks main on every spawn, so a new or revoked grant shows up at once', async () => {
				readyPath().mockResolvedValueOnce(LAUNCHER).mockResolvedValueOnce(null);
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toContain('RUN');
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
			});

			it('does not ask main at all while the feature is off', async () => {
				readyPath().mockResolvedValue(LAUNCHER);
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: false, maestroRun: false },
				});
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
				expect(readyPath()).not.toHaveBeenCalled();
			});

			it('is never given to an SSH agent', async () => {
				readyPath().mockResolvedValue(LAUNCHER);
				const result = await prepareMaestroSystemPrompt({
					session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
				});
				expect(result).toBe('BASE');
				expect(readyPath()).not.toHaveBeenCalled();
			});

			it('reads a failed check as not ready', async () => {
				readyPath().mockRejectedValue(new Error('main not ready'));
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
			});
		});

		it('skips a section whose prompt fails to load', async () => {
			enableComputerHistory();
			delete prompts['computer-history-system'];
			const result = await prepareMaestroSystemPrompt({ session: baseSession });
			expect(result).toBe('BASE');
			prompts['computer-history-system'] = 'HISTORY {{COMPUTER_HISTORY_DIR}}';
		});
	});
});

describe('loadJourneyFilePath', () => {
	beforeEach(() => {
		(window as any).maestro = {
			...(window as any).maestro,
			journey: { getPath: vi.fn().mockResolvedValue('/mock/journey/a1.jsonl') },
		};
	});

	it('returns the path for a local agent', async () => {
		await expect(loadJourneyFilePath('a1', false)).resolves.toBe('/mock/journey/a1.jsonl');
	});

	it('skips the local-only path for an SSH agent', async () => {
		await expect(loadJourneyFilePath('a1', true)).resolves.toBeUndefined();
		expect((window as any).maestro.journey.getPath).not.toHaveBeenCalled();
	});

	it('reads a failed lookup or a missing bridge as no path', async () => {
		(window as any).maestro.journey.getPath.mockRejectedValueOnce(new Error('no path'));
		await expect(loadJourneyFilePath('a1', false)).resolves.toBeUndefined();
		(window as any).maestro = { ...(window as any).maestro, journey: undefined };
		await expect(loadJourneyFilePath('a1', false)).resolves.toBeUndefined();
	});
});
