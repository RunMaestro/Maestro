import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildContextCompactionLogEntry,
	canCompactTabContext,
	compactTabContext,
	recordContextCompaction,
	registerContextCompactionSpawner,
	settleContextCompaction,
	type HiddenTurnSpawner,
} from '../../../renderer/services/contextCompaction';
import { getContextCompactCommand } from '../../../shared/contextCompaction';
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

	it('compacts a pinned or parked Claude slot under its own config without changing selection', async () => {
		const spawner = vi.fn<HiddenTurnSpawner>().mockResolvedValue({ success: true });
		registerContextCompactionSpawner(spawner);
		seed({
			toolType: 'codex',
			customPath: '/bin/codex',
			providerOverrides: {
				'claude-code': { customPath: '/bin/claude-work', customModel: 'sonnet' },
			},
			aiTabs: [
				createMockAITab({
					id: TAB,
					agentSessionId: 'codex-live',
					providerSessions: {
						'claude-code': { agentSessionId: 'claude-parked', customEffort: 'high' },
					},
				}),
			],
		});
		expect(canCompactTabContext(SESSION, TAB)).toBe(false);
		expect(canCompactTabContext(SESSION, TAB, 'claude-code')).toBe(true);
		await compactTabContext(SESSION, TAB, 'claude-code');
		expect(spawner).toHaveBeenCalledWith(
			SESSION,
			'/repo',
			'claude-parked',
			'/compact',
			'claude-code',
			expect.objectContaining({
				customPath: '/bin/claude-work',
				customModel: 'sonnet',
				customEffort: 'high',
			}),
			expect.anything()
		);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].agentSessionId).toBe('codex-live');
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
