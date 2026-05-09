import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	buildSynopsisPrompt,
	runExitSynopsis,
	shouldRunSynopsisOnExit,
	type SynopsisData,
	type RunExitSynopsisDeps,
} from '../../../../../../renderer/hooks/agent/internal/helpers/exitSynopsis';
import { notifyToast } from '../../../../../../renderer/stores/notificationStore';
import { parseSynopsis } from '../../../../../../shared/synopsis';

vi.mock('../../../../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

vi.mock('../../../../../../shared/synopsis', () => ({
	parseSynopsis: vi.fn(),
}));

vi.mock('../../../../../../renderer/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

function makeDeps(): RunExitSynopsisDeps & {
	spawn: ReturnType<typeof vi.fn>;
	addHistory: ReturnType<typeof vi.fn>;
	updateLastSynopsisTime: ReturnType<typeof vi.fn>;
	refresh: ReturnType<typeof vi.fn>;
} {
	const spawn = vi.fn();
	const addHistory = vi.fn();
	const updateLastSynopsisTime = vi.fn();
	const refresh = vi.fn();
	return {
		spawn,
		addHistory,
		updateLastSynopsisTime,
		refresh,
		spawnBackgroundSynopsisRef: { current: spawn } as any,
		addHistoryEntryRef: { current: addHistory } as any,
		rightPanelRef: { current: { refreshHistoryPanel: refresh } } as any,
		getAutorunSynopsisPrompt: () => 'BASE_PROMPT',
	};
}

function makeSynopsisData(overrides: Partial<SynopsisData> = {}): SynopsisData {
	return {
		sessionId: 'sess-1',
		cwd: '/cwd',
		projectRoot: '/cwd',
		agentSessionId: 'agent-1',
		command: '/commit',
		groupName: 'Group',
		projectName: 'Project',
		tabName: 'tab name',
		tabId: 'tab-1',
		taskDuration: 1000,
		toolType: 'claude-code',
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		claude: { updateSessionName: vi.fn().mockResolvedValue(undefined) },
		agentSessions: { setSessionName: vi.fn().mockResolvedValue(undefined) },
	};
});

describe('shouldRunSynopsisOnExit', () => {
	it('returns false when execution queue is non-empty', () => {
		expect(
			shouldRunSynopsisOnExit(
				{ executionQueue: [{} as any], agentSessionId: 'a', pendingAICommandForSynopsis: '/c' },
				{ agentSessionId: 'a', saveToHistory: true }
			)
		).toBe(false);
	});

	it('returns false when no agentSessionId on tab or session', () => {
		expect(
			shouldRunSynopsisOnExit(
				{ executionQueue: [], agentSessionId: undefined, pendingAICommandForSynopsis: '/c' },
				{ agentSessionId: null, saveToHistory: true }
			)
		).toBe(false);
	});

	it('returns true when tab has saveToHistory and agentSessionId', () => {
		expect(
			shouldRunSynopsisOnExit(
				{ executionQueue: [], agentSessionId: undefined },
				{ agentSessionId: 'a', saveToHistory: true }
			)
		).toBe(true);
	});

	it('returns true when session has pendingAICommandForSynopsis and agentSessionId', () => {
		expect(
			shouldRunSynopsisOnExit(
				{ executionQueue: [], agentSessionId: 'a', pendingAICommandForSynopsis: '/c' },
				{ agentSessionId: null, saveToHistory: false }
			)
		).toBe(true);
	});

	it('returns false when neither saveToHistory nor pendingAICommandForSynopsis is set', () => {
		expect(
			shouldRunSynopsisOnExit(
				{ executionQueue: [], agentSessionId: 'a' },
				{ agentSessionId: null, saveToHistory: false }
			)
		).toBe(false);
	});
});

describe('buildSynopsisPrompt', () => {
	it('returns the base prompt when no lastSynopsisTime', () => {
		expect(buildSynopsisPrompt({}, () => 'BASE')).toBe('BASE');
	});

	it('appends a since-last-synopsis instruction when lastSynopsisTime is set', () => {
		const out = buildSynopsisPrompt({ lastSynopsisTime: Date.now() - 5 * 60 * 1000 }, () => 'BASE');
		expect(out).toContain('BASE');
		expect(out).toMatch(/Only synopsize work done since the last synopsis/);
	});
});

describe('runExitSynopsis', () => {
	it('records a history entry and fires the synopsis toast on success', async () => {
		const deps = makeDeps();
		deps.spawn.mockResolvedValue({
			success: true,
			response: 'response text',
			usageStats: { inputTokens: 1 },
			contextUsage: 0.5,
		});
		vi.mocked(parseSynopsis).mockReturnValue({
			shortSummary: 'short',
			fullSynopsis: 'full',
			nothingToReport: false,
		} as any);

		await runExitSynopsis(makeSynopsisData(), deps);

		expect(deps.addHistory).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'USER', summary: 'short', fullResponse: 'full' })
		);
		expect(deps.updateLastSynopsisTime).toHaveBeenCalledWith('sess-1', 'tab-1', expect.any(Number));
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'info', title: 'Synopsis', message: 'short' })
		);
		expect(deps.refresh).toHaveBeenCalled();
	});

	it('skips history when nothingToReport is set', async () => {
		const deps = makeDeps();
		deps.spawn.mockResolvedValue({ success: true, response: 'r' });
		vi.mocked(parseSynopsis).mockReturnValue({
			shortSummary: '',
			fullSynopsis: '',
			nothingToReport: true,
		} as any);

		await runExitSynopsis(makeSynopsisData(), deps);

		expect(deps.addHistory).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('does nothing when spawn returns no success', async () => {
		const deps = makeDeps();
		deps.spawn.mockResolvedValue({ success: false });

		await runExitSynopsis(makeSynopsisData(), deps);

		expect(deps.addHistory).not.toHaveBeenCalled();
		expect(deps.updateLastSynopsisTime).not.toHaveBeenCalled();
	});

	it('returns silently when spawn ref is null', async () => {
		const deps = makeDeps();
		(deps as any).spawnBackgroundSynopsisRef = { current: null };
		await runExitSynopsis(makeSynopsisData(), deps);
		// No-op; nothing crashes.
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('persists tab name via claude IPC for claude-code agents', async () => {
		const deps = makeDeps();
		deps.spawn.mockResolvedValue({ success: true, response: 'r' });
		vi.mocked(parseSynopsis).mockReturnValue({
			shortSummary: 's',
			fullSynopsis: 'f',
			nothingToReport: false,
		} as any);

		await runExitSynopsis(makeSynopsisData({ tabName: 'My Custom Name' }), deps);

		expect((window as any).maestro.claude.updateSessionName).toHaveBeenCalledWith(
			'/cwd',
			'agent-1',
			'My Custom Name'
		);
	});

	it('persists tab name via agentSessions IPC for non-claude-code agents', async () => {
		const deps = makeDeps();
		deps.spawn.mockResolvedValue({ success: true, response: 'r' });
		vi.mocked(parseSynopsis).mockReturnValue({
			shortSummary: 's',
			fullSynopsis: 'f',
			nothingToReport: false,
		} as any);

		await runExitSynopsis(
			makeSynopsisData({ tabName: 'My Custom Name', toolType: 'codex' as any }),
			deps
		);

		expect((window as any).maestro.agentSessions.setSessionName).toHaveBeenCalledWith(
			'codex',
			'/cwd',
			'agent-1',
			'My Custom Name'
		);
	});

	it('skips tab name persistence for UPPERCASE UUID-prefix names (the auto-generated fallback)', async () => {
		const deps = makeDeps();
		deps.spawn.mockResolvedValue({ success: true, response: 'r' });
		vi.mocked(parseSynopsis).mockReturnValue({
			shortSummary: 's',
			fullSynopsis: 'f',
			nothingToReport: false,
		} as any);

		await runExitSynopsis(makeSynopsisData({ tabName: 'AB12CD34' }), deps);

		expect((window as any).maestro.claude.updateSessionName).not.toHaveBeenCalled();
	});

	it('PERSISTS lowercase 8-hex tab names (real user-typed names, not the fallback)', async () => {
		// Pins the case-sensitive regex: the fallback is always uppercase
		// (`agentSessionId.substring(0, 8).toUpperCase()` in useAgentExitListener),
		// so a lowercase 8-hex tabName can only have come from the user typing it
		// and must be persisted as a real custom name.
		const deps = makeDeps();
		deps.spawn.mockResolvedValue({ success: true, response: 'r' });
		vi.mocked(parseSynopsis).mockReturnValue({
			shortSummary: 's',
			fullSynopsis: 'f',
			nothingToReport: false,
		} as any);

		await runExitSynopsis(makeSynopsisData({ tabName: 'ab12cd34' }), deps);

		expect((window as any).maestro.claude.updateSessionName).toHaveBeenCalledWith(
			'/cwd',
			'agent-1',
			'ab12cd34'
		);
	});

	it('swallows errors thrown by spawn', async () => {
		const deps = makeDeps();
		deps.spawn.mockRejectedValue(new Error('boom'));
		await expect(runExitSynopsis(makeSynopsisData(), deps)).resolves.toBeUndefined();
	});
});
