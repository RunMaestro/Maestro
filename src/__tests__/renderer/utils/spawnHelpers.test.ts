import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prepareMaestroSystemPrompt } from '../../../renderer/utils/spawnHelpers';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import {
	SYSTEM_ONE_GATES,
	refusedSystemOneAccess,
	systemOneAccess,
} from '../../helpers/systemOneAccess';

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
		// The base prompt each time, plus the Maestro Cue section (Cue ships on).
		const ids = (window as any).maestro.prompts.get.mock.calls.map((call: unknown[]) => call[0]);
		expect(ids.filter((id: string) => id === 'maestro-system-prompt')).toHaveLength(2);
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

		it('skips the localOnly section and the store path for SSH agents', async () => {
			enableComputerHistory();
			const result = await prepareMaestroSystemPrompt({
				session: { ...baseSession, sessionSshRemoteConfig: { enabled: true } },
			});
			expect(result).toBe('BASE');
			expect((window as any).maestro.prompts.get).not.toHaveBeenCalledWith(
				'computer-history-system'
			);
		});

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

		describe('System One', () => {
			const SECTION =
				'S1 Jev (TypeSafe cloud)|calibrated: of the answers it gives 0.8, about 80% are true, so act on thresholds|$1.00 a day across all agents; more than half is left today';
			const agentAccess = () =>
				(window as any).maestro.localModels.systemOne.agentAccess as ReturnType<typeof vi.fn>;

			beforeEach(() => {
				prompts['system-one-system'] =
					'S1 {{SYSTEM_ONE_ENGINE}}|{{SYSTEM_ONE_CALIBRATED}}|{{SYSTEM_ONE_BUDGET}}';
				agentAccess().mockReset();
				agentAccess().mockResolvedValue(systemOneAccess());
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: false },
				});
			});

			afterEach(() => {
				delete prompts['system-one-system'];
				agentAccess().mockResolvedValue(refusedSystemOneAccess('engine-off'));
			});

			it('is appended when main says a request from this agent would be answered', async () => {
				const result = await prepareMaestroSystemPrompt({ session: baseSession });
				expect(result).toBe(`BASE\n\n---\n\n${SECTION}`);
				expect(agentAccess()).toHaveBeenCalledWith('session-1');
			});

			it('is left out behind each gate that refuses the agent', async () => {
				for (const gate of SYSTEM_ONE_GATES) {
					agentAccess().mockResolvedValue(refusedSystemOneAccess(gate));
					expect(await prepareMaestroSystemPrompt({ session: baseSession }), gate).toBe('BASE');
				}
				expect((window as any).maestro.prompts.get).not.toHaveBeenCalledWith('system-one-system');
			});

			it('asks main on every spawn, so switching System One off removes it from the next one', async () => {
				agentAccess()
					.mockResolvedValueOnce(systemOneAccess())
					.mockResolvedValueOnce(refusedSystemOneAccess('agents-off'));
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toContain('S1 ');
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
			});

			it('is never given to an SSH remote agent, and main is not asked', async () => {
				for (const ssh of [{ sessionSshRemoteConfig: { enabled: true } }, { sshRemoteId: 'r1' }]) {
					const result = await prepareMaestroSystemPrompt({ session: { ...baseSession, ...ssh } });
					expect(result).toBe('BASE');
				}
				expect(agentAccess()).not.toHaveBeenCalled();
			});

			it('reads a failed check, or an older preload, as no answer', async () => {
				agentAccess().mockRejectedValue(new Error('main not ready'));
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');

				const saved = (window as any).maestro.localModels;
				(window as any).maestro.localModels = undefined;
				expect(await prepareMaestroSystemPrompt({ session: baseSession })).toBe('BASE');
				(window as any).maestro.localModels = saved;
			});

			it('sits after the role section and before the plugin sections', async () => {
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: true, pianola: true },
				});
				const result = await prepareMaestroSystemPrompt({
					session: { ...baseSession, isPianola: true },
				});
				expect(result?.split('\n\n---\n\n').map((part) => part.slice(0, 4))).toEqual([
					'BASE',
					'PIAN',
					'S1 J',
					'HIST',
				]);
			});
		});

		describe('Peer Agents', () => {
			const R = { read: true, write: false };
			const RW = { read: true, write: true };
			const me = { ...baseSession, name: 'Me' };
			let savedSessions: ReturnType<typeof useSessionStore.getState>['sessions'];

			const setFleet = (...others: Array<{ id: string; name: string; groupId?: string }>) =>
				useSessionStore.setState({
					sessions: [createMockSession(me), ...others.map((other) => createMockSession(other))],
				});

			beforeEach(() => {
				prompts['maestro-system-prompt'] = 'BASE\n\n{{PEER_AGENTS}}';
				savedSessions = useSessionStore.getState().sessions;
				useSettingsStore.setState({
					encoreFeatures: { ...(savedEncore as any), computerHistory: false },
				});
				setFleet(
					{ id: 'peer-a', name: 'Alpha', groupId: 'group-1' },
					{ id: 'peer-b', name: 'Bravo', groupId: 'group-2' }
				);
			});

			afterEach(() => {
				prompts['maestro-system-prompt'] = 'BASE';
				useSessionStore.setState({ sessions: savedSessions });
				vi.restoreAllMocks();
			});

			it('renders nothing, and never reads the fleet, for an agent with no peer configuration', async () => {
				const getState = vi.spyOn(useSessionStore, 'getState');
				const result = await prepareMaestroSystemPrompt({ session: me });
				expect(result).toBe('BASE\n\n');
				expect(getState).not.toHaveBeenCalled();
			});

			it('does not read the fleet for a row that grants nothing and has no grant to exclude from', async () => {
				const getState = vi.spyOn(useSessionStore, 'getState');
				const result = await prepareMaestroSystemPrompt({
					session: { ...me, peerAgents: [{ sessionId: 'peer-a', read: false, write: false }] },
				});
				expect(result).toBe('BASE\n\n');
				expect(getState).not.toHaveBeenCalled();
			});

			it('renders an explicit peer with its live name and its id', async () => {
				const result = await prepareMaestroSystemPrompt({
					session: { ...me, peerAgents: [{ sessionId: 'peer-b', ...R, description: 'docs' }] },
				});
				expect(result).toContain('## Peer Agents');
				expect(result).toContain('| Bravo | `peer-b` | Consult only | docs |');
				expect(result).not.toContain('Alpha');
			});

			it('resolves a group grant against the whole fleet, leaving out the agent itself', async () => {
				const result = await prepareMaestroSystemPrompt({
					session: { ...me, groupPeerAccess: RW },
				});
				expect(result).toContain('| Alpha | `peer-a` | Consult + Delegate |');
				expect(result).not.toContain('Bravo');
				expect(result).not.toContain('| Me |');
			});

			it('puts the spawning agent in the delegate command', async () => {
				const result = await prepareMaestroSystemPrompt({
					session: { ...me, groupPeerAccess: RW },
				});
				expect(result).toContain('--new-tab --notify-on-complete session-1`');
				expect(result).not.toContain('{{');
			});

			it('reads the fleet at spawn time, so a peer added since the last spawn shows up', async () => {
				const session = { ...me, groupPeerAccess: R };
				expect(await prepareMaestroSystemPrompt({ session })).not.toContain('Charlie');
				setFleet(
					{ id: 'peer-a', name: 'Alpha', groupId: 'group-1' },
					{ id: 'peer-c', name: 'Charlie', groupId: 'group-1' }
				);
				expect(await prepareMaestroSystemPrompt({ session })).toContain(
					'| Charlie | `peer-c` | Consult only |'
				);
			});

			it('renders nothing when every configured peer has been deleted', async () => {
				const result = await prepareMaestroSystemPrompt({
					session: { ...me, peerAgents: [{ sessionId: 'gone', ...RW }] },
				});
				expect(result).toBe('BASE\n\n');
			});

			// The counter is a file and a root turn's chain is minted in main, so the
			// renderer asks main where the budget stands.
			describe('the remaining budget', () => {
				const consultBudget = vi.fn();
				const budgetLines = (text: string | undefined) =>
					(text ?? '').split('\n').filter((line) => line.startsWith('- **Budget:**'));

				beforeEach(() => {
					consultBudget.mockReset();
					consultBudget.mockResolvedValue({ limit: 25, spent: 0 });
					(window as any).maestro.crossAgent = { consultBudget };
				});

				it('asks main with no chain for a turn the user started, and states the answer', async () => {
					const result = await prepareMaestroSystemPrompt({
						session: { ...me, groupPeerAccess: RW },
					});

					expect(consultBudget).toHaveBeenCalledTimes(1);
					expect(consultBudget).toHaveBeenCalledWith(undefined);
					expect(budgetLines(result)).toHaveLength(1);
					expect(budgetLines(result)[0]).toContain('25 of the 25 consults and delegations');
				});

				it('asks main about the chain of a turn another agent delegated', async () => {
					consultBudget.mockResolvedValue({ limit: 25, spent: 6 });
					const consultChain = { chainId: 'chain-a', depth: 2 };

					const result = await prepareMaestroSystemPrompt({
						session: { ...me, groupPeerAccess: RW },
						consultChain,
					});

					expect(consultBudget).toHaveBeenCalledWith(consultChain);
					expect(budgetLines(result)[0]).toContain('19 of the 25 consults and delegations');
				});

				it('asks on every spawn, so the count is never a cached one', async () => {
					consultBudget
						.mockResolvedValueOnce({ limit: 25, spent: 1 })
						.mockResolvedValueOnce({ limit: 25, spent: 9 });
					const session = { ...me, groupPeerAccess: RW };

					expect(budgetLines(await prepareMaestroSystemPrompt({ session }))[0]).toContain('24 of');
					expect(budgetLines(await prepareMaestroSystemPrompt({ session }))[0]).toContain('16 of');
				});

				it('does not ask main for an agent with no peers', async () => {
					expect(await prepareMaestroSystemPrompt({ session: me })).toBe('BASE\n\n');
					// Every configured peer deleted: no roster, so nothing to ration.
					await prepareMaestroSystemPrompt({
						session: { ...me, peerAgents: [{ sessionId: 'gone', ...RW }] },
					});
					expect(consultBudget).not.toHaveBeenCalled();
				});

				it('leaves the sentence out, and keeps the roster, when main cannot say', async () => {
					const session = { ...me, groupPeerAccess: RW };

					consultBudget.mockResolvedValue(null);
					const unknown = await prepareMaestroSystemPrompt({ session });
					expect(unknown).toContain('| Alpha | `peer-a` | Consult + Delegate |');
					expect(unknown).not.toMatch(/budget/i);

					consultBudget.mockRejectedValue(new Error('main not ready'));
					expect(await prepareMaestroSystemPrompt({ session })).toBe(unknown);

					// An older preload has no such method.
					(window as any).maestro.crossAgent = {};
					expect(await prepareMaestroSystemPrompt({ session })).toBe(unknown);
				});
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
