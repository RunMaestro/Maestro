/**
 * @file maestro-system-prompt.test.ts
 * @description Main-process system prompt builder used by Cue runs, Group Chat
 * participants, and cross-agent consults (and the moderator's plugin-only
 * variant).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
/** Counts reads of the sessions store; `throws` makes the next reads fail. */
const sessionsStoreRead = vi.hoisted(() => ({ count: 0, throws: false }));
vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(() => ({
		get: vi.fn(() => {
			sessionsStoreRead.count += 1;
			if (sessionsStoreRead.throws) throw new Error('store unreadable');
			return storedSessions;
		}),
	})),
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

/** What the System One service answers for the agent asked about. Off unless a test sets it. */
const systemOne = vi.hoisted(() => ({
	getSystemOneAgentAccess: vi.fn(),
}));
vi.mock('../../../main/local-models/system-one/agent-service', () => systemOne);

import {
	buildMaestroSystemPromptForSession,
	buildPluginSystemPromptSections,
	localSystemOneAccess,
} from '../../../main/utils/maestro-system-prompt';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';
import { formatPeerAgentsForPrompt, resolvePeerRoster } from '../../../shared/peerAgents';
import {
	CONSULT_BUDGET_FILE,
	spendConsultBudget,
} from '../../../main/peer-consults/consult-budget';
import {
	SYSTEM_ONE_GATES,
	refusedSystemOneAccess,
	systemOneAccess,
} from '../../helpers/systemOneAccess';

const agent = (overrides: Record<string, any> = {}) => ({
	id: 'agent-1',
	name: 'Alice',
	toolType: 'claude-code',
	cwd: '/proj',
	projectRoot: '/proj',
	isGitRepo: true,
	...overrides,
});

// System One is off for every test that does not turn it on, in every describe below.
beforeEach(() => {
	systemOne.getSystemOneAgentAccess.mockReset();
	systemOne.getSystemOneAgentAccess.mockResolvedValue(refusedSystemOneAccess('engine-off'));
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

	it('names the captured consult provider and tab without changing the agent default', async () => {
		prompts['maestro-system-prompt'] = '{{TOOL_TYPE}}|{{TAB_ID}}';
		expect(
			await buildMaestroSystemPromptForSession('agent-1', {
				provider: 'codex',
				activeTabId: 'consult-tab',
			})
		).toBe('codex|consult-tab');
		expect(storedSessions[0].toolType).toBe('claude-code');
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

describe('the Peer Agents roster (main builder)', () => {
	const R = { read: true, write: false };
	const RW = { read: true, write: true };
	const me = (overrides: Record<string, any> = {}) =>
		agent({ id: 'me', name: 'Me', groupId: 'group-1', ...overrides });
	const alpha = agent({ id: 'peer-a', name: 'Alpha', groupId: 'group-1' });
	const bravo = agent({ id: 'peer-b', name: 'Bravo', groupId: 'group-2' });
	const child = agent({ id: 'peer-c', name: 'Charlie', parentSessionId: 'me' });

	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of Object.keys(prompts)) delete prompts[key];
		prompts['maestro-system-prompt'] = 'BASE\n\n{{PEER_AGENTS}}';
		storedSessions = [me(), alpha, bravo, child];
		settings = {};
		sessionsStoreRead.count = 0;
	});

	// The store is shared by every describe in this file: never leave it failing.
	afterEach(() => {
		sessionsStoreRead.throws = false;
	});

	it('renders nothing, and reads the store once (to find the agent), with no peer configuration', async () => {
		expect(await buildMaestroSystemPromptForSession('me')).toBe('BASE\n\n');
		expect(sessionsStoreRead.count).toBe(1);
	});

	it('never reads the store for a loaded record with no peer configuration', async () => {
		expect(await buildMaestroSystemPromptForSession(me() as any)).toBe('BASE\n\n');
		// An exclusion with no grant to exclude from is no configuration either.
		const excluded = me({ peerAgents: [{ sessionId: 'peer-a', read: false, write: false }] });
		expect(await buildMaestroSystemPromptForSession(excluded as any)).toBe('BASE\n\n');
		expect(sessionsStoreRead.count).toBe(0);
	});

	it('reads the grants from the stored record and renders an explicit peer', async () => {
		storedSessions[0] = me({ peerAgents: [{ sessionId: 'peer-b', ...R, description: 'docs' }] });
		const result = await buildMaestroSystemPromptForSession('me');
		expect(result).toContain('## Peer Agents');
		expect(result).toContain('| Bravo | `peer-b` | Consult only | docs |');
		expect(result).not.toContain('Alpha');
	});

	it('resolves a group grant against the whole store, for a loaded record too', async () => {
		const result = await buildMaestroSystemPromptForSession(me({ groupPeerAccess: RW }) as any);
		expect(result).toContain('| Alpha | `peer-a` | Consult + Delegate |');
		expect(result).not.toContain('Bravo');
		expect(result).not.toContain('| Me |');
		expect(sessionsStoreRead.count).toBe(1);
	});

	it('resolves the worktree family grant from parentSessionId', async () => {
		storedSessions[0] = me({ worktreePeerAccess: R });
		const result = await buildMaestroSystemPromptForSession('me');
		expect(result).toContain('| Charlie | `peer-c` | Consult only |');
		expect(result).not.toContain('Alpha');
	});

	it('teaches the delegate command with the agent id and the CLI the app resolved', async () => {
		storedSessions[0] = me({ groupPeerAccess: RW });
		bundledCliPath = '/work/maestro/dist/cli/maestro-cli.js';
		try {
			const result = await buildMaestroSystemPromptForSession('me');
			expect(result).toContain(
				'`node "/work/maestro/dist/cli/maestro-cli.js" dispatch <agent-id> "<task>" --new-tab --notify-on-complete me`'
			);
			expect(result).not.toContain('{{');
		} finally {
			bundledCliPath = null;
		}
	});

	it('gives a Cue run, a consult and a group chat turn the roster a desktop tab resolves', async () => {
		// The renderer builder resolves with `resolvePeerRoster` over its store.
		// Same agent and same agent list here must list the same peers.
		const session = me({
			groupPeerAccess: RW,
			worktreePeerAccess: R,
			peerAgents: [{ sessionId: 'peer-b', ...R, description: 'docs' }],
		});
		storedSessions = [session, { ...alpha, peerDescription: 'Builds labs' }, bravo, child];
		const roster = resolvePeerRoster(session as any, storedSessions as any);
		expect(roster.map((peer) => peer.sessionId)).toEqual(['peer-a', 'peer-b', 'peer-c']);

		const result = await buildMaestroSystemPromptForSession('me');
		const table = (text: string) => text.split('\n').filter((line) => line.startsWith('| '));
		expect(table(result ?? '')).toEqual(table(formatPeerAgentsForPrompt(roster)));
		expect(result).toContain('| Alpha | `peer-a` | Consult + Delegate | Builds labs |');
	});

	// The one sentence that lets a consulted agent ration. Every case passes a
	// temp directory: the default counter is the live one in an agent's shell.
	describe('the remaining budget', () => {
		let budgetDir: string;
		const chain = { chainId: 'chain-a', depth: 1 };
		const budgetLines = (text: string | undefined) =>
			(text ?? '').split('\n').filter((line) => line.startsWith('- **Budget:**'));

		beforeEach(() => {
			budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msp-consult-budget-'));
			storedSessions[0] = me({ groupPeerAccess: RW });
		});

		afterEach(() => {
			fs.rmSync(budgetDir, { recursive: true, force: true });
		});

		it('states what is left of the chain the spawn was placed in', async () => {
			spendConsultBudget('chain-a', 25, { dataDir: budgetDir });
			spendConsultBudget('chain-a', 25, { dataDir: budgetDir });

			const result = await buildMaestroSystemPromptForSession('me', {
				consultChain: chain,
				consultBudgetStore: { dataDir: budgetDir },
			});

			expect(budgetLines(result)).toHaveLength(1);
			expect(budgetLines(result)[0]).toContain('23 of the 25 consults and delegations');
		});

		it('reads the limit from the setting, through the normalizer', async () => {
			settings = { maxConsultationsPerTurn: 4 };
			spendConsultBudget('chain-a', 4, { dataDir: budgetDir });
			const built = () =>
				buildMaestroSystemPromptForSession('me', {
					consultChain: chain,
					consultBudgetStore: { dataDir: budgetDir },
				});

			expect(budgetLines(await built())[0]).toContain('3 of the 4 consults');

			// `0` is a real budget, not "unset".
			settings = { maxConsultationsPerTurn: 0 };
			expect(budgetLines(await built())[0]).toContain('switched off');

			// A value the CLI stored by hand as a string is the default.
			settings = { maxConsultationsPerTurn: 'lots' };
			expect(budgetLines(await built())[0]).toContain('24 of the 25 consults');
		});

		it('says nothing when the caller put the spawn in no chain (a Cue run, a group chat turn)', async () => {
			const result = await buildMaestroSystemPromptForSession('me', {
				consultBudgetStore: { dataDir: budgetDir },
			});

			expect(result).toContain('## Peer Agents');
			expect(result).not.toMatch(/budget/i);
		});

		it('says nothing, and reads no counter, for an agent with no peers', async () => {
			storedSessions[0] = me();
			fs.writeFileSync(path.join(budgetDir, CONSULT_BUDGET_FILE), 'not json', 'utf-8');

			const result = await buildMaestroSystemPromptForSession('me', {
				consultChain: chain,
				consultBudgetStore: { dataDir: budgetDir },
			});

			expect(result).toBe('BASE\n\n');
		});

		it('leaves the sentence out, and keeps the roster, when the counter cannot be read', async () => {
			fs.writeFileSync(path.join(budgetDir, CONSULT_BUDGET_FILE), 'not json', 'utf-8');

			const result = await buildMaestroSystemPromptForSession('me', {
				consultChain: chain,
				consultBudgetStore: { dataDir: budgetDir },
			});

			expect(result).toContain('| Alpha | `peer-a` | Consult + Delegate |');
			expect(result).not.toMatch(/budget/i);
		});
	});

	it('renders no roster (never throws) when the store cannot be read for the agent list', async () => {
		sessionsStoreRead.throws = true;
		const result = await buildMaestroSystemPromptForSession(me({ groupPeerAccess: RW }) as any);
		expect(result).toBe('BASE\n\n');
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe('the System One section (main builder)', () => {
	const SSH = { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } };

	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of Object.keys(prompts)) delete prompts[key];
		prompts['maestro-system-prompt'] = 'BASE';
		prompts['pianola-system'] = 'PIANOLA';
		prompts['computer-history-system'] = 'HISTORY';
		prompts['system-one-system'] =
			'S1 {{SYSTEM_ONE_ENGINE}}|{{SYSTEM_ONE_CALIBRATED}}|{{SYSTEM_ONE_BUDGET}}';
		storedSessions = [agent()];
		settings = {};
		systemOne.getSystemOneAgentAccess.mockResolvedValue(systemOneAccess());
	});

	it('is appended, with the engine and the budget, when every gate passes', async () => {
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result).toBe(
			'BASE\n\n---\n\nS1 Jev (TypeSafe cloud)|calibrated: of the answers it gives 0.8, about 80% are true, so act on thresholds|$1.00 a day across all agents; more than half is left today'
		);
		// Asked for the agent being spawned, so its own switch and its own cap count.
		expect(systemOne.getSystemOneAgentAccess).toHaveBeenCalledWith('agent-1');
	});

	it('is left out behind each gate that refuses the agent', async () => {
		for (const gate of SYSTEM_ONE_GATES) {
			systemOne.getSystemOneAgentAccess.mockResolvedValue(refusedSystemOneAccess(gate));
			expect(await buildMaestroSystemPromptForSession('agent-1'), gate).toBe('BASE');
		}
	});

	it('is asked on every spawn, so switching System One off removes it from the next one', async () => {
		expect(await buildMaestroSystemPromptForSession('agent-1')).toContain('S1 ');
		systemOne.getSystemOneAgentAccess.mockResolvedValue(refusedSystemOneAccess('agents-off'));
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
		expect(systemOne.getSystemOneAgentAccess).toHaveBeenCalledTimes(2);
	});

	it('is never given to an SSH remote agent, and the service is not asked', async () => {
		storedSessions = [agent(SSH)];
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
		expect(systemOne.getSystemOneAgentAccess).not.toHaveBeenCalled();

		storedSessions = [agent({ sshRemoteId: 'r1' })];
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
		expect(systemOne.getSystemOneAgentAccess).not.toHaveBeenCalled();
	});

	it('reads a failed check as no answer instead of failing the spawn', async () => {
		systemOne.getSystemOneAgentAccess.mockRejectedValue(new Error('settings unreadable'));
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
		expect(logger.warn).toHaveBeenCalled();
		await expect(localSystemOneAccess('agent-1')).resolves.toBeUndefined();
	});

	it('sits after the role section and before the plugin sections', async () => {
		storedSessions = [agent({ isPianola: true })];
		settings.encoreFeatures = { computerHistory: true, pianola: true };
		const result = await buildMaestroSystemPromptForSession('agent-1');
		expect(result?.split('\n\n---\n\n').map((part) => part.slice(0, 4))).toEqual([
			'BASE',
			'PIAN',
			'S1 J',
			'HIST',
		]);
	});

	it('skips the section when its prompt is missing instead of failing', async () => {
		delete prompts['system-one-system'];
		expect(await buildMaestroSystemPromptForSession('agent-1')).toBe('BASE');
	});

	it('is not part of the moderator variant, which has no agent to count it against', () => {
		settings.encoreFeatures = { computerHistory: true };
		expect(buildPluginSystemPromptSections({ isSsh: false })).toBe('HISTORY');
		expect(systemOne.getSystemOneAgentAccess).not.toHaveBeenCalled();
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
