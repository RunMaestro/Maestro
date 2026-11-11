/**
 * Auto Run steering notes reach the task prompt.
 *
 * The note is the whole point of the feature, so what matters is that it lands
 * in front of the prompt the agent is actually spawned with - and that a
 * `{{VARIABLE}}` the operator typed into a note survives as literal text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentProcessor } from '../../../../renderer/hooks/batch/useDocumentProcessor';
import { STEERING_BLOCK_START, STEERING_BLOCK_END } from '../../../../shared/autorunSteering';
import { createMockSession } from '../../../helpers/mockSession';

const DOC_CONTENT = '- [ ] Do the thing\n';

function mockAutorunIpc(): void {
	window.maestro = {
		...window.maestro,
		autorun: {
			...window.maestro?.autorun,
			readDoc: vi.fn().mockResolvedValue({ success: true, content: DOC_CONTENT }),
			writeDoc: vi.fn().mockResolvedValue({ success: true }),
		},
		agentSessions: {
			...window.maestro?.agentSessions,
			registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
		},
	} as typeof window.maestro;
}

describe('useDocumentProcessor - steering notes', () => {
	const onSpawnAgent = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockAutorunIpc();
		onSpawnAgent.mockResolvedValue({ success: true, response: 'Did the thing.' });
	});

	const runTask = async (steeringNotes?: Parameters<typeof baseConfig>[0]) => {
		const { result } = renderHook(() => useDocumentProcessor());
		await result.current.processTask(baseConfig(steeringNotes), 'phase-1', 0, 1, DOC_CONTENT, {
			onSpawnAgent,
		});
		return onSpawnAgent.mock.calls[0][1] as string;
	};

	function baseConfig(steeringNotes?: { id: string; text: string; timestamp: number }[]) {
		const session = createMockSession({ cwd: '/test/project' });
		return {
			folderPath: '/test/project/.maestro/playbooks',
			session,
			loopIteration: 1,
			effectiveCwd: session.cwd,
			customPrompt: 'Work the document.',
			...(steeringNotes && { steeringNotes }),
		};
	}

	it('sends the prompt unchanged when there are no notes', async () => {
		const prompt = await runTask();
		expect(prompt).toBe('Work the document.');
		expect(prompt).not.toContain(STEERING_BLOCK_START);
	});

	it('prepends the note block ahead of the prompt', async () => {
		const prompt = await runTask([
			{ id: 'n1', text: 'Important notice: Maestro error.', timestamp: Date.now() },
		]);

		expect(prompt.startsWith(STEERING_BLOCK_START)).toBe(true);
		expect(prompt).toContain('Important notice: Maestro error.');
		// The note comes FIRST - the base prompt follows it.
		expect(prompt.indexOf(STEERING_BLOCK_END)).toBeLessThan(prompt.indexOf('Work the document.'));
	});

	it('leaves template syntax inside a note unexpanded', async () => {
		// Notes are prepended AFTER substitution on purpose: `{{GIT_BRANCH}}` the
		// operator typed is their literal text, not a variable to expand.
		const prompt = await runTask([
			{ id: 'n1', text: 'mention {{GIT_BRANCH}} verbatim', timestamp: Date.now() },
		]);
		expect(prompt).toContain('mention {{GIT_BRANCH}} verbatim');
	});
});

/**
 * Grok task turns through the real processTask path. The document
 * lives on a fake disk the spawn callback edits the way an agent does, so the
 * completion counts, the checkbox restore and the synopsis all come from the
 * hook's own re-read, never from a state the test sets.
 */
describe('useDocumentProcessor - Grok task turns', () => {
	const disk = { content: '' };
	const onSpawnAgent = vi.fn();
	const readDoc = vi.fn();
	const writeDoc = vi.fn();
	const registerSessionOrigin = vi.fn();
	const TWO_TASKS = '# Phase\n\n- [ ] First task\n- [ ] Second task\n';

	beforeEach(() => {
		vi.clearAllMocks();
		disk.content = TWO_TASKS;
		readDoc.mockImplementation(async () => ({ success: true, content: disk.content }));
		writeDoc.mockImplementation(async (_folder: string, _file: string, content: string) => {
			disk.content = content;
			return { success: true };
		});
		registerSessionOrigin.mockResolvedValue(undefined);
		window.maestro = {
			...window.maestro,
			autorun: { ...window.maestro?.autorun, readDoc, writeDoc },
			agentSessions: { ...window.maestro?.agentSessions, registerSessionOrigin },
		} as typeof window.maestro;
	});

	/** The agent's edit to the document, made while its turn runs. */
	const agentTicks = (from: string, to: string) => {
		disk.content = disk.content.replace(from, to);
	};

	const grokConfig = (overrides: Record<string, unknown> = {}, session = {}) => {
		const grok = createMockSession({ cwd: '/test/project', toolType: 'grok', ...session });
		return {
			folderPath: '/test/project/.maestro/playbooks',
			session: grok,
			loopIteration: 1,
			effectiveCwd: grok.cwd,
			customPrompt: 'Work the document.',
			...overrides,
		};
	};

	const run = async (config: ReturnType<typeof grokConfig>, checked = 0, remaining = 2) => {
		const { result } = renderHook(() => useDocumentProcessor());
		return result.current.processTask(config, 'phase-1', checked, remaining, disk.content, {
			onSpawnAgent,
		});
	};

	it('completes one task in task mode and registers the session id the turn ended with', async () => {
		onSpawnAgent.mockImplementation(async () => {
			agentTicks('- [ ] First task', '- [x] First task');
			// Grok reports its native session id only at the end of the turn.
			return {
				success: true,
				response: 'Finished the first task.\n\nDetails follow.',
				agentSessionId: 'grok-native-1',
			};
		});

		const result = await run(grokConfig({ taskSelectionMode: 'task' }));

		expect(result.success).toBe(true);
		expect(result.tasksCompletedThisRun).toBe(1);
		expect(result.newRemainingTasks).toBe(1);
		expect(result.agentSessionId).toBe('grok-native-1');
		expect(result.shortSummary).toContain('Finished the first task.');
		expect(registerSessionOrigin).toHaveBeenCalledWith('/test/project', 'grok-native-1', 'auto');
		expect(disk.content).toContain('- [x] First task');
		expect(writeDoc).not.toHaveBeenCalled();
	});

	it('counts every task a document-mode turn completes', async () => {
		onSpawnAgent.mockImplementation(async () => {
			agentTicks('- [ ] First task', '- [x] First task');
			agentTicks('- [ ] Second task', '- [x] Second task - done with a note');
			return { success: true, response: 'Worked the whole document.' };
		});

		const result = await run(grokConfig({ taskSelectionMode: 'document' }));

		expect(result.success).toBe(true);
		expect(result.tasksCompletedThisRun).toBe(2);
		expect(result.newRemainingTasks).toBe(0);
		expect(result.agentSessionId).toBeUndefined();
		expect(registerSessionOrigin).not.toHaveBeenCalled();
	});

	it('keeps the run model and effort over an unqualified document hint, behind the New Session Message', async () => {
		disk.content = `<!-- MAESTRO:MODEL tier="low" effort="low" -->\n\n${TWO_TASKS}`;
		onSpawnAgent.mockResolvedValue({ success: true, response: 'ok' });

		await run(
			grokConfig(
				{ runOverrides: { modelOverride: 'grok-run-model', effortOverride: 'high' } },
				{
					customModel: 'grok-agent-model',
					customEffort: 'medium',
					newSessionMessage: 'Standing instructions.',
				}
			)
		);

		const [sessionId, prompt, cwdOverride, settings] = onSpawnAgent.mock.calls[0];
		expect(sessionId).toBe(createMockSession().id);
		// Grok has no tier catalog and no qualified effort menu here, so the
		// hint cannot replace the run's own choice.
		expect(settings).toMatchObject({ modelOverride: 'grok-run-model', effortOverride: 'high' });
		expect(cwdOverride).toBeUndefined();
		expect(prompt).toBe('Standing instructions.\n\n---\n\nWork the document.');
	});

	it("falls back to the agent's model and effort when the run sets none", async () => {
		onSpawnAgent.mockResolvedValue({ success: true, response: 'ok' });

		await run(grokConfig({}, { customModel: 'grok-agent-model', customEffort: 'medium' }));

		expect(onSpawnAgent.mock.calls[0][3]).toMatchObject({
			modelOverride: 'grok-agent-model',
			effortOverride: 'medium',
		});
	});

	it('unticks what a rate-limited turn ticked, on the remote target, and reports the failure', async () => {
		onSpawnAgent.mockImplementation(async () => {
			agentTicks('- [ ] First task', '- [x] First task (started, see notes)');
			return {
				success: false,
				response: 'I ticked the first box and began the work',
				error: 'Grok rate limit reached. Try again later.',
				errorKind: 'process-exit',
				agentSessionId: 'grok-native-2',
			};
		});

		const result = await run(
			grokConfig({ sshRemoteId: 'ssh-remote-1', effectiveCwd: '/remote/worktree' })
		);

		expect(result.success).toBe(false);
		expect(result.tasksCompletedThisRun).toBe(0);
		expect(result.newRemainingTasks).toBe(2);
		expect(result.newCheckedCount).toBe(0);
		expect(result.errorKind).toBe('process-exit');
		expect(result.shortSummary).toBe('[phase-1] Task failed');
		expect(result.fullSynopsis).toBe('Grok rate limit reached. Try again later.');
		expect(result.fullSynopsis).not.toContain('ticked the first box');
		// The box goes back; the note the agent wrote stays.
		expect(disk.content).toContain('- [ ] First task (started, see notes)');
		expect(writeDoc).toHaveBeenCalledTimes(1);
		for (const call of [...readDoc.mock.calls, ...writeDoc.mock.calls]) {
			expect(call.at(-1)).toBe('ssh-remote-1');
		}
		expect(onSpawnAgent.mock.calls[0][2]).toBe('/remote/worktree');
		expect(registerSessionOrigin).toHaveBeenCalledWith('/remote/worktree', 'grok-native-2', 'auto');
	});

	it('treats an explicit stop as unfinished and leaves boxes checked before dispatch alone', async () => {
		disk.content = '- [x] Earlier task\n- [ ] First task\n- [ ] Second task\n';
		onSpawnAgent.mockImplementation(async () => {
			agentTicks('- [ ] First task', '- [x] First task');
			return { success: false, response: 'Partial preamble before the stop' };
		});

		const result = await run(grokConfig(), 1, 2);

		expect(result.success).toBe(false);
		expect(result.tasksCompletedThisRun).toBe(0);
		expect(result.fullSynopsis).toBe('[phase-1] Task failed');
		expect(disk.content).toBe('- [x] Earlier task\n- [ ] First task\n- [ ] Second task\n');
	});

	it('completes nothing on a failed turn even when a tick cannot be matched to a dispatch task', async () => {
		onSpawnAgent.mockImplementation(async () => {
			agentTicks('- [ ] First task', '- [x] Reworded by the agent');
			return { success: false, error: 'Grok authentication required' };
		});

		const result = await run(grokConfig());

		expect(result.tasksCompletedThisRun).toBe(0);
		expect(result.fullSynopsis).toBe('Grok authentication required');
		// Nothing to put back, so the document is not rewritten.
		expect(writeDoc).not.toHaveBeenCalled();
		expect(disk.content).toContain('- [x] Reworded by the agent');
	});

	it('leaves another provider failed turn exactly as before', async () => {
		onSpawnAgent.mockImplementation(async () => {
			agentTicks('- [ ] First task', '- [x] First task');
			return { success: false, response: 'Claude partial', error: 'Claude failed' };
		});

		const result = await run(grokConfig({}, { toolType: 'claude-code' }));

		expect(result.tasksCompletedThisRun).toBe(1);
		expect(disk.content).toContain('- [x] First task');
		expect(writeDoc).not.toHaveBeenCalled();
	});
});
