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
