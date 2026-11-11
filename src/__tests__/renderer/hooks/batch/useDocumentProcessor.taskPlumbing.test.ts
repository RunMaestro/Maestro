/**
 * A playbook's own prompt still tells the desktop agent which document to work.
 *
 * The desktop never pastes the document into the prompt (DESKTOP_AUTORUN_POLICY), so an Exchange
 * playbook whose manifest `prompt` never names `{{DOCUMENT_PATH}}` spawned every task with no
 * task document and no instruction to check boxes. The processor must append the default prompt's
 * selection and document blocks to such a prompt, and leave one that names the document alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentProcessor } from '../../../../renderer/hooks/batch/useDocumentProcessor';
import { loadBatchUtilsPrompts } from '../../../../renderer/hooks/batch/batchUtils';
import { createMockSession } from '../../../helpers/mockSession';

const DOC_CONTENT = '- [ ] Curate the memory index\n';

const PROMPTS: Record<string, string> = {
	'autorun-default': 'DEFAULT {{TASK_SELECTION_BLOCK}} {{DOCUMENT_PATH}}',
	'autorun-per-task': 'PER-TASK: process the FIRST unchecked task.\n',
	'autorun-per-document': 'PER-DOCUMENT: process ALL unchecked tasks.\n',
	'autorun-document': '## Tasks\n\nProcess tasks from this document:\n\n{{DOCUMENT_PATH}}\n',
};

describe('useDocumentProcessor - custom prompt task plumbing', () => {
	const onSpawnAgent = vi.fn();

	beforeEach(async () => {
		vi.clearAllMocks();
		window.maestro = {
			...window.maestro,
			prompts: {
				...window.maestro?.prompts,
				get: vi.fn(async (id: string) =>
					id in PROMPTS ? { success: true, content: PROMPTS[id] } : { success: false, error: id }
				),
			},
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
		await loadBatchUtilsPrompts(true);
		onSpawnAgent.mockResolvedValue({ success: true, response: 'Curated the index.' });
	});

	const runTask = async (customPrompt: string, taskSelectionMode?: 'task' | 'document') => {
		const session = createMockSession({ cwd: '/test/project' });
		const { result } = renderHook(() => useDocumentProcessor());
		await result.current.processTask(
			{
				folderPath: '/test/project/.maestro/playbooks',
				session,
				loopIteration: 1,
				effectiveCwd: session.cwd,
				customPrompt,
				...(taskSelectionMode && { taskSelectionMode }),
			},
			'Agent-Memory/01-Inventory',
			0,
			1,
			DOC_CONTENT,
			{ onSpawnAgent }
		);
		return onSpawnAgent.mock.calls[0][1] as string;
	};

	it('appends the selection and document blocks to a prompt that never names the document', async () => {
		const prompt = await runTask('You curate agent memory.');
		expect(prompt.startsWith('You curate agent memory.\n\n---\n\n')).toBe(true);
		expect(prompt).toContain('PER-TASK: process the FIRST unchecked task.');
		expect(prompt).toContain('Process tasks from this document:');
		expect(prompt).toMatch(/Agent-Memory[\\/]01-Inventory\.md/);
		expect(prompt).not.toContain('{{');
	});

	it('appends the per-document block when the playbook runs per document', async () => {
		const prompt = await runTask('You curate agent memory.', 'document');
		expect(prompt).toContain('PER-DOCUMENT: process ALL unchecked tasks.');
		expect(prompt).not.toContain('PER-TASK');
	});

	it('leaves a prompt that names the document as written', async () => {
		const prompt = await runTask('Only touch {{DOCUMENT_PATH}}.');
		expect(prompt).toMatch(/^Only touch \S*Agent-Memory[\\/]01-Inventory\.md\.$/);
	});
});
