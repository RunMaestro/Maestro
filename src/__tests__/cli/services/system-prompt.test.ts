/**
 * @file system-prompt.test.ts
 * @description Tests for `prepareMaestroSystemPromptCli` - the CLI-side
 * builder that loads `maestro-system-prompt`, threads in branch / history /
 * conductor context, and returns the substituted template for use as
 * `appendSystemPrompt`. Mirrors the renderer's `prepareMaestroSystemPrompt`
 * in `src/renderer/utils/spawnHelpers.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getConfigDirectory: vi.fn(() => '/mock/config'),
	readSessions: vi.fn(() => []),
	getJourneyFilePath: vi.fn((id: string) => `/mock/config/journey/${id}.jsonl`),
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

// The desktop app, as the CLI reaches it. `desktop.reply` is what it answers
// `system_one_access` with; `null` is a desktop that is not running.
const desktop = vi.hoisted(() => ({
	reply: null as Record<string, unknown> | null,
	sendCommand: (async () => null) as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(async (action: (client: unknown) => Promise<unknown>) => {
		if (desktop.reply === null) throw new Error('Maestro desktop app is not running');
		return action({ sendCommand: (...args: unknown[]) => desktop.sendCommand(...args) });
	}),
}));

import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';
import {
	SYSTEM_ONE_ACCESS_TIMEOUT_MS,
	readSystemOneAccessFromDesktop,
} from '../../../cli/services/system-one-access';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import {
	SYSTEM_ONE_GATES,
	refusedSystemOneAccess,
	systemOneAccess,
} from '../../helpers/systemOneAccess';
import { getCliPrompt } from '../../../cli/services/prompt-loader';
import {
	readSessions,
	readSettingValue,
	resolveSessionHistoryFilePath,
} from '../../../cli/services/storage';
import { formatPeerAgentsForPrompt, resolvePeerRoster } from '../../../shared/peerAgents';
import {
	CONSULT_BUDGET_FILE,
	spendConsultBudget,
} from '../../../main/peer-consults/consult-budget';
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
		vi.mocked(readSessions).mockReturnValue([]);
		// Default: history file does NOT exist (fresh session)
		vi.mocked(resolveSessionHistoryFilePath).mockReturnValue(undefined);
		// Default: the app has not recorded MaestroRun as ready.
		vi.mocked(readMaestroRunReadyPath).mockReturnValue(undefined);
		// Default: the desktop app is not running, so System One cannot be asked about.
		desktop.reply = null;
		desktop.sendCommand = vi.fn(async () => desktop.reply);
	});

	it('fills the journey path, and leaves it empty for SSH sessions', async () => {
		vi.mocked(getCliPrompt).mockResolvedValue('journey=[{{AGENT_JOURNEY_PATH}}]');

		expect(await prepareMaestroSystemPromptCli(mockSession({ id: 'sess-1' }))).toBe(
			'journey=[/mock/config/journey/sess-1.jsonl]'
		);
		expect(
			await prepareMaestroSystemPromptCli(
				mockSession({ id: 'sess-1', sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
			)
		).toBe('journey=[]');
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

	describe('Peer Agents', () => {
		const R = { read: true, write: false };
		const RW = { read: true, write: true };
		const me = (overrides: Partial<SessionInfo> = {}) =>
			mockSession({ id: 'me', name: 'Me', groupId: 'group-1', ...overrides });
		const alpha = mockSession({ id: 'peer-a', name: 'Alpha', groupId: 'group-1' });
		const bravo = mockSession({ id: 'peer-b', name: 'Bravo', groupId: 'group-2' });
		const child = mockSession({ id: 'peer-c', name: 'Charlie', parentSessionId: 'me' });

		beforeEach(() => {
			vi.mocked(getCliPrompt).mockResolvedValue('BASE\n\n{{PEER_AGENTS}}');
			vi.mocked(readSessions).mockReturnValue([me(), alpha, bravo, child]);
		});

		it('renders nothing, and never reads the sessions file, for an agent with no peer configuration', async () => {
			expect(await prepareMaestroSystemPromptCli(me())).toBe('BASE\n\n');
			expect(readSessions).not.toHaveBeenCalled();
		});

		it('does not read the sessions file for a row that grants nothing and has no grant to exclude from', async () => {
			const result = await prepareMaestroSystemPromptCli(
				me({ peerAgents: [{ sessionId: 'peer-a', read: false, write: false }] })
			);
			expect(result).toBe('BASE\n\n');
			expect(readSessions).not.toHaveBeenCalled();
		});

		it('renders an explicit peer with its live name, its id and its note', async () => {
			const result = await prepareMaestroSystemPromptCli(
				me({ peerAgents: [{ sessionId: 'peer-b', ...R, description: 'docs' }] })
			);
			expect(result).toContain('## Peer Agents');
			expect(result).toContain('| Bravo | `peer-b` | Consult only | docs |');
			expect(result).not.toContain('Alpha');
		});

		it('resolves a group grant against every agent on disk, leaving out the agent itself', async () => {
			const result = await prepareMaestroSystemPromptCli(me({ groupPeerAccess: RW }));
			expect(result).toContain('| Alpha | `peer-a` | Consult + Delegate |');
			expect(result).not.toContain('Bravo');
			expect(result).not.toContain('| Me |');
			expect(readSessions).toHaveBeenCalledTimes(1);
		});

		it('resolves the worktree family grant from parentSessionId', async () => {
			const result = await prepareMaestroSystemPromptCli(me({ worktreePeerAccess: R }));
			expect(result).toContain('| Charlie | `peer-c` | Consult only |');
			expect(result).not.toContain('Alpha');
		});

		it('puts the spawning agent in the delegate command', async () => {
			const result = await prepareMaestroSystemPromptCli(me({ groupPeerAccess: RW }));
			expect(result).toContain('--new-tab --notify-on-complete me`');
			expect(result).not.toContain('{{');
		});

		it('renders nothing when every configured peer has been deleted', async () => {
			const result = await prepareMaestroSystemPromptCli(
				me({ peerAgents: [{ sessionId: 'gone', ...RW }] })
			);
			expect(result).toBe('BASE\n\n');
		});

		it('gives a headless spawn the roster a desktop spawn resolves for the same agent', async () => {
			// The desktop builders resolve with `resolvePeerRoster` over their store.
			// Same agent and same agent list here must list the same peers.
			const session = me({
				groupPeerAccess: RW,
				worktreePeerAccess: R,
				peerAgents: [{ sessionId: 'peer-b', ...R, description: 'docs' }],
			});
			const fleet = [session, alpha, bravo, child];
			vi.mocked(readSessions).mockReturnValue(fleet);
			const roster = resolvePeerRoster(session, fleet);
			expect(roster.map((peer) => peer.sessionId)).toEqual(['peer-a', 'peer-b', 'peer-c']);

			const result = await prepareMaestroSystemPromptCli(session);
			const table = (text: string) => text.split('\n').filter((line) => line.startsWith('| '));
			expect(table(result ?? '')).toEqual(table(formatPeerAgentsForPrompt(roster)));
		});

		it('reads the agent list from the reader it is handed (the builder inside the app)', async () => {
			vi.mocked(readSessions).mockReturnValue([]);
			const readAgents = vi.fn(() => [me(), alpha]);
			const result = await prepareMaestroSystemPromptCli(me({ groupPeerAccess: R }), {
				readAgents,
			});
			expect(result).toContain('| Alpha | `peer-a` | Consult only |');
			expect(readAgents).toHaveBeenCalledTimes(1);
			expect(readSessions).not.toHaveBeenCalled();
		});

		// The one sentence that lets a sent-to agent ration. Every case passes a
		// temp directory: the default counter is the live one in an agent's shell.
		describe('the remaining budget', () => {
			let budgetDir: string;
			const chain = { chainId: 'chain-a', depth: 1 };
			const budgetLines = (text: string | undefined) =>
				(text ?? '').split('\n').filter((line) => line.startsWith('- **Budget:**'));
			const setting = (value: unknown) =>
				vi
					.mocked(readSettingValue)
					.mockImplementation((key: string) => (key === 'maxConsultationsPerTurn' ? value : ''));

			beforeEach(() => {
				budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-consult-budget-'));
			});

			afterEach(() => {
				fs.rmSync(budgetDir, { recursive: true, force: true });
			});

			it('states what is left of the chain the send was admitted to', async () => {
				spendConsultBudget('chain-a', 25, { dataDir: budgetDir });

				const result = await prepareMaestroSystemPromptCli(me({ groupPeerAccess: RW }), {
					consultChain: chain,
					consultBudgetStore: { dataDir: budgetDir },
				});

				expect(budgetLines(result)).toHaveLength(1);
				expect(budgetLines(result)[0]).toContain('24 of the 25 consults and delegations');
			});

			it('reads the whole budget as left for a chain the user just rooted', async () => {
				const result = await prepareMaestroSystemPromptCli(me({ groupPeerAccess: RW }), {
					consultChain: { chainId: 'chain-new', depth: 0 },
					consultBudgetStore: { dataDir: budgetDir },
				});

				expect(budgetLines(result)[0]).toContain('25 of the 25');
			});

			it('reads the limit from the setting, through the normalizer', async () => {
				const built = () =>
					prepareMaestroSystemPromptCli(me({ groupPeerAccess: RW }), {
						consultChain: chain,
						consultBudgetStore: { dataDir: budgetDir },
					});

				setting(4);
				expect(budgetLines(await built())[0]).toContain('4 of the 4 consults');

				// `0` is a real budget, not "unset".
				setting(0);
				expect(budgetLines(await built())[0]).toContain('switched off');
			});

			it('says nothing when the caller put the spawn in no chain (a playbook, a goal run)', async () => {
				const result = await prepareMaestroSystemPromptCli(me({ groupPeerAccess: RW }), {
					consultBudgetStore: { dataDir: budgetDir },
				});

				expect(result).toContain('## Peer Agents');
				expect(result).not.toMatch(/budget/i);
			});

			it('says nothing, and reads no counter, for an agent with no peers', async () => {
				fs.writeFileSync(path.join(budgetDir, CONSULT_BUDGET_FILE), 'not json', 'utf-8');

				const result = await prepareMaestroSystemPromptCli(me(), {
					consultChain: chain,
					consultBudgetStore: { dataDir: budgetDir },
				});

				expect(result).toBe('BASE\n\n');
			});

			it('leaves the sentence out, and keeps the roster, when the counter cannot be read', async () => {
				fs.writeFileSync(path.join(budgetDir, CONSULT_BUDGET_FILE), 'not json', 'utf-8');

				const result = await prepareMaestroSystemPromptCli(me({ groupPeerAccess: RW }), {
					consultChain: chain,
					consultBudgetStore: { dataDir: budgetDir },
				});

				expect(result).toContain('| Alpha | `peer-a` | Consult + Delegate |');
				expect(result).not.toMatch(/budget/i);
			});
		});
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

		describe('System One', () => {
			const SSH = { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } };
			const SECTION =
				'S1 Jev (TypeSafe cloud)|calibrated: of the answers it gives 0.8, about 80% are true, so act on thresholds|$1.00 a day across all agents; more than half is left today';

			beforeEach(() => {
				prompts['system-one-system'] =
					'S1 {{SYSTEM_ONE_ENGINE}}|{{SYSTEM_ONE_CALIBRATED}}|{{SYSTEM_ONE_BUDGET}}';
				desktop.reply = { success: true, access: systemOneAccess() };
			});

			it('is appended when the desktop says a request from this agent would be answered', async () => {
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }));
				expect(result).toBe(`BASE A\n\n---\n\n${SECTION}`);
				// Asked about the agent being spawned, with a wait that cannot hold a spawn long.
				expect(desktop.sendCommand).toHaveBeenCalledWith(
					{ type: 'system_one_access', agentId: 'agent-abc-123' },
					'system_one_access_result',
					SYSTEM_ONE_ACCESS_TIMEOUT_MS
				);
			});

			it('is left out behind each gate that refuses the agent', async () => {
				for (const gate of SYSTEM_ONE_GATES) {
					desktop.reply = { success: true, access: refusedSystemOneAccess(gate) };
					expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' })), gate).toBe(
						'BASE A'
					);
				}
			});

			it('is left out when the desktop app is not running: the verbs could not reach it either', async () => {
				desktop.reply = null;
				const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
				// A closed desktop is a normal state for a headless run: nothing is printed.
				expect(errSpy).not.toHaveBeenCalled();
				errSpy.mockRestore();
			});

			it('is left out when the desktop is too old for the question, or refuses it', async () => {
				desktop.sendCommand = vi.fn(async () => {
					throw new Error('Unsupported command: system_one_access');
				});
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');

				desktop.sendCommand = vi.fn(async () => ({ success: false, error: 'no' }));
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
				await expect(readSystemOneAccessFromDesktop('agent-abc-123')).resolves.toBeUndefined();
			});

			it('is never given to an SSH remote agent, and the desktop is not asked', async () => {
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A', ...SSH }));
				expect(result).toBe('BASE A');
				expect(withMaestroClient).not.toHaveBeenCalled();
			});

			it('asks the reader it is handed instead of the desktop (the builder inside the app)', async () => {
				desktop.reply = null;
				const readSystemOneAccess = vi.fn(async () => systemOneAccess());
				const result = await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }), {
					readSystemOneAccess,
				});
				expect(result).toBe(`BASE A\n\n---\n\n${SECTION}`);
				expect(readSystemOneAccess).toHaveBeenCalledWith('agent-abc-123');
				expect(withMaestroClient).not.toHaveBeenCalled();
			});

			it('sits after the role section and before the plugin sections', async () => {
				vi.mocked(readSettingValue).mockImplementation(
					settings({ computerHistory: true, pianola: true })
				);
				const result = await prepareMaestroSystemPromptCli(
					mockSession({ name: 'A', isPianola: true })
				);
				expect(result?.split('\n\n---\n\n').map((part) => part.slice(0, 4))).toEqual([
					'BASE',
					'PIAN',
					'S1 J',
					'HIST',
				]);
			});

			it('skips the section when its prompt file is missing', async () => {
				delete prompts['system-one-system'];
				const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				expect(await prepareMaestroSystemPromptCli(mockSession({ name: 'A' }))).toBe('BASE A');
				errSpy.mockRestore();
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
