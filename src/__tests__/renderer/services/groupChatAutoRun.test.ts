/**
 * A group chat moderator's `!autorun @Agent` starts the participant's Auto Run
 * through `startBatchRun` for a local, an SSH, and a hosted agent alike, and the
 * run's end reaches the chat (`reportAutoRunComplete`).
 *
 * @file src/renderer/services/groupChatAutoRun.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { BatchRunState } from '../../../renderer/types';
import { DEFAULT_BATCH_STATE } from '../../../renderer/hooks/batch/batchReducer';
import { DEFAULT_BATCH_PROMPT } from '../../../renderer/hooks/batch/batchUtils';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	groupChatAutoRunFailure,
	startGroupChatAutoRun,
} from '../../../renderer/services/groupChatAutoRun';
import { useGroupChatAutoRunTrigger } from '../../../renderer/hooks/groupChat/useGroupChatAutoRunTrigger';
import {
	consumeGroupChatAutoRun,
	hasGroupChatAutoRun,
} from '../../../renderer/utils/groupChatAutoRunRegistry';
import { AGENT_MODES, createModeSession } from '../../helpers/mockSession';

const FOLDER = '/repo/.maestro/playbooks';

const reportAutoRunComplete = vi.fn();
const onAutoRunTriggered = vi.fn();
let savedGroupChat: unknown;

function setAgent(mode: (typeof AGENT_MODES)[number], overrides = {}) {
	const session = createModeSession(mode, {
		id: 'agent-1',
		name: 'Client',
		autoRunFolderPath: FOLDER,
		...overrides,
	});
	useSessionStore.setState({ sessions: [session] });
	return session;
}

function mirror(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return { ...DEFAULT_BATCH_STATE, isRunning: true, mirrored: true, ...overrides };
}

const trigger = { groupChatId: 'chat-1', participantName: 'Client' };

beforeEach(() => {
	const maestro = window.maestro as unknown as Record<string, unknown>;
	savedGroupChat = maestro.groupChat;
	maestro.groupChat = { reportAutoRunComplete, onAutoRunTriggered };
	reportAutoRunComplete.mockReset().mockResolvedValue({ success: true });
	onAutoRunTriggered.mockReset().mockReturnValue(() => {});
	vi.mocked(window.maestro.autorun.listDocs)
		.mockReset()
		.mockResolvedValue({ success: true, files: ['plans/phase-01', 'plans/phase-02'] });
	useBatchStore.setState({ batchRunStates: {} });
});

afterEach(() => {
	(window.maestro as unknown as Record<string, unknown>).groupChat = savedGroupChat;
	consumeGroupChatAutoRun('agent-1');
});

describe('startGroupChatAutoRun in every mode', () => {
	it.each(AGENT_MODES)(
		'starts the %s participant run through startBatchRun with the same config',
		async (mode) => {
			setAgent(mode);
			const startBatchRun = vi.fn().mockResolvedValue(undefined);

			await startGroupChatAutoRun(trigger, startBatchRun);

			expect(startBatchRun).toHaveBeenCalledTimes(1);
			const [sessionId, config, folderPath] = startBatchRun.mock.calls[0];
			expect(sessionId).toBe('agent-1');
			expect(folderPath).toBe(FOLDER);
			expect(config).toMatchObject({
				prompt: DEFAULT_BATCH_PROMPT,
				loopEnabled: false,
				maxLoops: null,
			});
			expect(config.documents.map((d: { filename: string }) => d.filename)).toEqual([
				'plans/phase-01',
				'plans/phase-02',
			]);
			// The folder is listed where the agent's files live: this machine, or its SSH remote.
			expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith(
				FOLDER,
				mode === 'local' ? undefined : 'r1'
			);
			expect(hasGroupChatAutoRun('agent-1')).toBe(true);
			expect(reportAutoRunComplete).not.toHaveBeenCalled();
		}
	);

	it.each(AGENT_MODES)('runs only the named document for a %s participant', async (mode) => {
		setAgent(mode);
		const startBatchRun = vi.fn().mockResolvedValue(undefined);

		await startGroupChatAutoRun({ ...trigger, targetFilename: 'phase-02.md' }, startBatchRun);

		const config = startBatchRun.mock.calls[0][1];
		expect(config.documents.map((d: { filename: string }) => d.filename)).toEqual([
			'plans/phase-02',
		]);
	});

	it.each(AGENT_MODES)('finds a renamed %s participant by the agent id main sent', async (mode) => {
		setAgent(mode, { name: 'Client (renamed)' });
		const startBatchRun = vi.fn().mockResolvedValue(undefined);

		await startGroupChatAutoRun({ ...trigger, agentId: 'agent-1' }, startBatchRun);

		expect(startBatchRun).toHaveBeenCalledWith('agent-1', expect.any(Object), FOLDER);
	});
});

describe('startGroupChatAutoRun refusals reach the chat', () => {
	it('reports a participant with no agent', async () => {
		useSessionStore.setState({ sessions: [] });
		const startBatchRun = vi.fn();

		await startGroupChatAutoRun(trigger, startBatchRun);

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(reportAutoRunComplete).toHaveBeenCalledWith(
			'chat-1',
			'Client',
			expect.stringContaining('No Maestro agent named "Client" found')
		);
	});

	it.each(AGENT_MODES)('reports a %s agent with no Auto Run folder', async (mode) => {
		setAgent(mode, { autoRunFolderPath: undefined });
		await startGroupChatAutoRun(trigger, vi.fn());
		expect(reportAutoRunComplete).toHaveBeenCalledWith(
			'chat-1',
			'Client',
			groupChatAutoRunFailure(
				'Client',
				'Agent "Client" has no Auto Run folder configured. Open the agent, go to the Auto Run tab, and configure a folder first.'
			)
		);
	});

	it('reports an empty folder and an unknown document', async () => {
		setAgent('local');
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({ success: true, files: [] });
		await startGroupChatAutoRun(trigger, vi.fn());
		expect(reportAutoRunComplete).toHaveBeenLastCalledWith(
			'chat-1',
			'Client',
			expect.stringContaining('No Auto Run documents found')
		);

		await startGroupChatAutoRun({ ...trigger, targetFilename: 'missing.md' }, vi.fn());
		expect(reportAutoRunComplete).toHaveBeenLastCalledWith(
			'chat-1',
			'Client',
			expect.stringContaining('Specified file "missing.md" not found')
		);
		expect(hasGroupChatAutoRun('agent-1')).toBe(false);
	});

	it('reports a folder that cannot be listed', async () => {
		setAgent('ssh');
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: false,
			files: [],
			error: 'remote unreachable',
		});
		await startGroupChatAutoRun(trigger, vi.fn());
		expect(reportAutoRunComplete).toHaveBeenCalledWith(
			'chat-1',
			'Client',
			expect.stringContaining('remote unreachable')
		);
	});

	it.each(AGENT_MODES)(
		'reports a %s run that startBatchRun refuses and clears its entry',
		async (mode) => {
			setAgent(mode);
			const startBatchRun = vi.fn().mockRejectedValue(new Error('Host rejected Auto Run start'));

			await startGroupChatAutoRun(trigger, startBatchRun);

			expect(hasGroupChatAutoRun('agent-1')).toBe(false);
			expect(reportAutoRunComplete).toHaveBeenCalledWith(
				'chat-1',
				'Client',
				groupChatAutoRunFailure('Client', 'Host rejected Auto Run start')
			);
		}
	);
});

describe('completion of a run another process drives', () => {
	it('reports the end of a mirrored run (a hosted agent run on its host)', async () => {
		setAgent('hosted');
		await startGroupChatAutoRun(trigger, vi.fn().mockResolvedValue(undefined));

		useBatchStore.setState({
			batchRunStates: {
				'agent-1': mirror({
					documents: ['plans/phase-01', 'plans/phase-02'],
					completedTasksAcrossAllDocs: 4,
					totalTasksAcrossAllDocs: 5,
				}),
			},
		});
		expect(reportAutoRunComplete).not.toHaveBeenCalled();

		useBatchStore.setState({ batchRunStates: {} });

		expect(reportAutoRunComplete).toHaveBeenCalledTimes(1);
		expect(reportAutoRunComplete).toHaveBeenCalledWith(
			'chat-1',
			'Client',
			'Auto Run complete: 4/5 tasks finished across 2 document(s).'
		);
		expect(hasGroupChatAutoRun('agent-1')).toBe(false);
	});

	it('leaves a run this window drives to the batch processor completion', async () => {
		setAgent('local');
		await startGroupChatAutoRun(trigger, vi.fn().mockResolvedValue(undefined));

		useBatchStore.setState({
			batchRunStates: { 'agent-1': { ...DEFAULT_BATCH_STATE, isRunning: true } },
		});
		useBatchStore.setState({ batchRunStates: { 'agent-1': { ...DEFAULT_BATCH_STATE } } });

		expect(reportAutoRunComplete).not.toHaveBeenCalled();
		expect(hasGroupChatAutoRun('agent-1')).toBe(true);
	});
});

describe('useGroupChatAutoRunTrigger', () => {
	it('starts the run from the trigger event in the lifecycle owner', async () => {
		setAgent('local');
		const startBatchRun = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useGroupChatAutoRunTrigger({ enabled: true, startBatchRun }));

		expect(onAutoRunTriggered).toHaveBeenCalledTimes(1);
		const handler = onAutoRunTriggered.mock.calls[0][0];
		handler('chat-1', 'Client', undefined, 'agent-1');
		await vi.waitFor(() => expect(startBatchRun).toHaveBeenCalledTimes(1));
		expect(startBatchRun).toHaveBeenCalledWith('agent-1', expect.any(Object), FOLDER);
	});

	it('does not listen in a window that is not the lifecycle owner', () => {
		renderHook(() => useGroupChatAutoRunTrigger({ enabled: false, startBatchRun: vi.fn() }));
		expect(onAutoRunTriggered).not.toHaveBeenCalled();
	});
});
