/**
 * Delegated results reach the next Auto Run task.
 *
 * Work an earlier task handed to another agent comes back as a block in front of
 * the next task's prompt, and the spawn carries the run id so a dispatch the
 * task makes reports back to the same run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentProcessor } from '../../../../renderer/hooks/batch/useDocumentProcessor';
import type { AutoRunDelegation } from '../../../../shared/autoRunDelegation';
import { createMockSession } from '../../../helpers/mockSession';

const DOC_CONTENT = '- [ ] Integrate the parser\n';

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

const delegation: AutoRunDelegation = {
	callbackId: 'cb_1',
	autoRunId: 'autorun-1',
	targetAgentId: 'worker',
	targetTabId: 'tab-7',
	targetName: 'Worker',
	prompt: 'Build the parser',
	startedAt: 1,
	status: 'completed',
	output: 'Parser built for {{GIT_BRANCH}}.',
	durationMs: 90_000,
};

describe('useDocumentProcessor - delegation results', () => {
	const onSpawnAgent = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockAutorunIpc();
		onSpawnAgent.mockResolvedValue({ success: true, response: 'Integrated.' });
	});

	const runTask = async (extra: Record<string, unknown>) => {
		const session = createMockSession({ cwd: '/test/project' });
		const { result } = renderHook(() => useDocumentProcessor());
		await result.current.processTask(
			{
				folderPath: '/test/project/.maestro/playbooks',
				session,
				loopIteration: 1,
				effectiveCwd: session.cwd,
				customPrompt: 'Work the document on {{GIT_BRANCH}}.',
				gitBranch: 'main',
				...extra,
			},
			'phase-1',
			0,
			1,
			DOC_CONTENT,
			{ onSpawnAgent }
		);
		return onSpawnAgent.mock.calls[0];
	};

	it('prepends the results ahead of the prompt, leaving their template syntax literal', async () => {
		const [, prompt] = await runTask({ delegationResults: [delegation] });
		expect(prompt.startsWith('## Results From Agents You Delegated To')).toBe(true);
		expect(prompt).toContain('Parser built for {{GIT_BRANCH}}.');
		expect(prompt).toContain('--tab tab-7');
		// The task's own prompt is still substituted.
		expect(prompt).toContain('Work the document on main.');
	});

	it('stamps the run id on the spawn', async () => {
		const [, , , turnSettings] = await runTask({ autoRunId: 'autorun-1' });
		expect(turnSettings).toMatchObject({ autoRunId: 'autorun-1' });
	});

	it('sends the prompt unchanged when nothing came back', async () => {
		const [, prompt, , turnSettings] = await runTask({});
		expect(prompt).toBe('Work the document on main.');
		expect(turnSettings.autoRunId).toBeUndefined();
	});
});
