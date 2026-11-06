import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildContextCompactionLogEntry,
	canCompactTabContext,
	compactTabContext,
	recordContextCompaction,
	registerContextCompactionSpawner,
	settleContextCompaction,
	getTabContextCompactionBlocker,
	type HiddenTurnSpawner,
} from '../../../renderer/services/contextCompaction';
import {
	getContextCompactCommand,
	getContextCompactionBlocker,
} from '../../../shared/contextCompaction';
import { isSelfContainedCard } from '../../../renderer/utils/logEntries';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

const SESSION = 's1';
const TAB = 't1';

function seed(overrides: Partial<Session> = {}, agentSessionId: string | null = 'claude-abc') {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: SESSION,
				toolType: 'claude-code',
				cwd: '/repo',
				aiTabs: [createMockAITab({ id: TAB, agentSessionId })],
				activeTabId: TAB,
				...overrides,
			}),
		],
	} as never);
}

function logs() {
	return useSessionStore.getState().sessions[0].aiTabs[0].logs;
}

beforeEach(() => {
	seed();
});

afterEach(() => {
	registerContextCompactionSpawner(null);
});

describe('getContextCompactCommand', () => {
	it('names a command only for providers verified to honor it', () => {
		expect(getContextCompactCommand('claude-code')).toBe('/compact');
		expect(getContextCompactCommand('codex')).toBeUndefined();
		expect(getContextCompactCommand(undefined)).toBeUndefined();
	});
});

describe('canCompactTabContext', () => {
	it('needs a wired spawner, a provider command, and a session to resume', () => {
		expect(canCompactTabContext(SESSION, TAB)).toBe(false);

		registerContextCompactionSpawner(vi.fn<HiddenTurnSpawner>());
		expect(canCompactTabContext(SESSION, TAB)).toBe(true);
		expect(canCompactTabContext(SESSION, 'missing-tab')).toBe(false);
		expect(canCompactTabContext('missing-session', TAB)).toBe(false);

		seed({ toolType: 'codex' });
		expect(canCompactTabContext(SESSION, TAB)).toBe(false);

		seed({}, null);
		expect(canCompactTabContext(SESSION, TAB)).toBe(false);
	});
});

describe('compactTabContext', () => {
	it("resumes the tab's provider session with the compaction command, on the agent's own config", async () => {
		const spawner = vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true });
		registerContextCompactionSpawner(spawner);
		seed({
			customModel: 'opus[1m]',
			customPath: '/usr/local/bin/claude',
			customEnvVars: { FOO: 'bar' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
		});

		await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({ success: true });

		expect(spawner).toHaveBeenCalledTimes(1);
		const [sessionId, cwd, resumeId, prompt, toolType, config, options] = spawner.mock.calls[0];
		expect([sessionId, cwd, resumeId, prompt, toolType]).toEqual([
			SESSION,
			'/repo',
			'claude-abc',
			'/compact',
			'claude-code',
		]);
		expect(config).toMatchObject({
			customModel: 'opus[1m]',
			customPath: '/usr/local/bin/claude',
			customEnvVars: { FOO: 'bar' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
		});
		expect(options).toEqual({ keepTurnSettings: true, allowEmptyResponse: true });
	});

	it('reports a failed or thrown compaction instead of throwing', async () => {
		registerContextCompactionSpawner(
			vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: false, error: 'Prompt is too long' })
		);
		await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({
			success: false,
			error: 'Prompt is too long',
		});

		registerContextCompactionSpawner(
			vi.fn<HiddenTurnSpawner>().mockRejectedValue(new Error('spawn refused'))
		);
		await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({
			success: false,
			error: 'spawn refused',
		});
	});

	it('fails without spawning when there is nothing to compact', async () => {
		const spawner = vi.fn<HiddenTurnSpawner>();
		registerContextCompactionSpawner(spawner);
		seed({}, null);

		expect((await compactTabContext(SESSION, TAB)).success).toBe(false);
		expect(spawner).not.toHaveBeenCalled();
	});
});

describe('the compaction pill', () => {
	it('is a self-contained card, so streamed output never appends to it', () => {
		expect(isSelfContainedCard(buildContextCompactionLogEntry('pending'))).toBe(true);
	});

	it('is appended pending and settled in place', () => {
		const before = logs().length;
		const ref = recordContextCompaction(SESSION, TAB)!;

		expect(logs()).toHaveLength(before + 1);
		expect(logs()[before].id).toBe(ref.entryId);
		expect(logs()[before].contextCompaction).toEqual({ status: 'pending' });

		settleContextCompaction(ref, { status: 'done' });
		expect(logs()).toHaveLength(before + 1);
		expect(logs()[before].contextCompaction).toEqual({ status: 'done' });

		// Already settled: a late outcome does not overwrite the first.
		settleContextCompaction(ref, { status: 'error', error: 'late' });
		expect(logs()[before].contextCompaction).toEqual({ status: 'done' });
	});

	it('records nothing for a tab that is gone', () => {
		expect(recordContextCompaction(SESSION, 'missing-tab')).toBeNull();
		expect(recordContextCompaction('missing-session', TAB)).toBeNull();
	});
});

/**
 * Grok has no qualified native compaction operation, so
 * the success branch of its context-limit recovery does not exist: the recovery
 * is a visible required-feature blocker. These cases pin that a scripted Grok
 * operation reporting success is never reached, never stands in for a
 * compaction, and leaves the tab's native identity (resume ID, account root,
 * host, model) and transcript exactly as they were. A future qualified operation
 * replaces the blocker and must replace these cases with the success contract.
 */
describe('Grok context-limit recovery', () => {
	const GROK_NATIVE_ID = 'grok-native-session-7';
	const GROK_ACCOUNT_ENV = { GROK_HOME: '/accounts/grok-work' };
	const GROK_SSH = { enabled: true, remoteId: 'grok-host-1' };

	/** A Grok tab mid-conversation on a selected account, model and host. */
	function seedGrok(agentSessionId: string | null = GROK_NATIVE_ID) {
		seed(
			{
				toolType: 'grok',
				customModel: 'grok-4',
				customEnvVars: { ...GROK_ACCOUNT_ENV },
				sessionSshRemoteConfig: { ...GROK_SSH },
			},
			agentSessionId
		);
	}

	/**
	 * A scripted Grok operation that would report every outcome the recovery
	 * could mistake for a compaction: success, an empty success, a failure and a
	 * thrown refusal. None of them may be reached.
	 */
	function scriptedGrokOperations(): HiddenTurnSpawner[] {
		return [
			vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true }),
			vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true, response: '' } as never),
			vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: false, error: 'exit code 143' }),
			vi.fn<HiddenTurnSpawner>().mockRejectedValue(new Error('grok refused the operation')),
		];
	}

	it('names the gap as a required-feature blocker with its parity rows', () => {
		const blocker = getContextCompactionBlocker('grok');
		expect(blocker).toEqual({
			reason: 'required-feature',
			feature: 'grok-native-compaction',
			parityRows: ['S34', 'B03'],
			detail: expect.stringContaining('Grok has no qualified native compaction operation'),
		});
		// Never a guessed literal: Grok has no compaction command at all.
		expect(getContextCompactCommand('grok')).toBeUndefined();
		// A provider with a verified command is never blocked; an unlisted one is
		// simply unlisted, not a recorded blocker.
		expect(getContextCompactionBlocker('claude-code')).toBeUndefined();
		expect(getContextCompactionBlocker('codex')).toBeUndefined();
		expect(getContextCompactionBlocker(undefined)).toBeUndefined();
	});

	it("reads the blocker off the tab's own provider", () => {
		seedGrok();
		expect(getTabContextCompactionBlocker(SESSION, TAB)?.feature).toBe('grok-native-compaction');
		expect(getTabContextCompactionBlocker(SESSION, 'missing-tab')).toBeNull();
		expect(getTabContextCompactionBlocker('missing-session', TAB)).toBeNull();

		seed();
		expect(getTabContextCompactionBlocker(SESSION, TAB)).toBeNull();
	});

	it('is not compactable even with a spawner wired and a native session to resume', () => {
		registerContextCompactionSpawner(vi.fn<HiddenTurnSpawner>());
		seedGrok();
		expect(canCompactTabContext(SESSION, TAB)).toBe(false);
	});

	it('never runs a scripted Grok operation, whatever it would report', async () => {
		seedGrok();
		const blocker = getContextCompactionBlocker('grok')!;

		for (const operation of scriptedGrokOperations()) {
			registerContextCompactionSpawner(operation);
			await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({
				success: false,
				error: blocker.detail,
			});
			expect(operation).not.toHaveBeenCalled();
		}
	});

	it("leaves the tab's native identity and transcript untouched after the refusal", async () => {
		seedGrok();
		const before = useSessionStore.getState().sessions[0];
		const logCount = before.aiTabs[0].logs.length;
		registerContextCompactionSpawner(
			vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true })
		);

		expect((await compactTabContext(SESSION, TAB)).success).toBe(false);

		const after = useSessionStore.getState().sessions[0];
		expect(after.aiTabs[0].agentSessionId).toBe(GROK_NATIVE_ID);
		expect(after.customEnvVars).toEqual(GROK_ACCOUNT_ENV);
		expect(after.sessionSshRemoteConfig).toEqual(GROK_SSH);
		expect(after.customModel).toBe('grok-4');
		expect(after.toolType).toBe('grok');
		// No pill: nothing claims a compaction happened.
		expect(after.aiTabs[0].logs).toHaveLength(logCount);
		expect(after.aiTabs[0].logs.some((log) => log.contextCompaction)).toBe(false);
	});

	it('refuses the same way with no native session to resume', async () => {
		const operation = vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true });
		registerContextCompactionSpawner(operation);
		seedGrok(null);

		const result = await compactTabContext(SESSION, TAB);
		expect(result).toEqual({ success: false, error: getContextCompactionBlocker('grok')!.detail });
		expect(operation).not.toHaveBeenCalled();
	});

	it('keeps the qualified provider on its own path beside a blocked one', async () => {
		const operation = vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true });
		registerContextCompactionSpawner(operation);

		seedGrok();
		expect((await compactTabContext(SESSION, TAB)).success).toBe(false);
		expect(operation).not.toHaveBeenCalled();

		seed();
		await expect(compactTabContext(SESSION, TAB)).resolves.toEqual({ success: true });
		expect(operation).toHaveBeenCalledTimes(1);
		expect(operation.mock.calls[0].slice(2, 5)).toEqual(['claude-abc', '/compact', 'claude-code']);
	});
});
