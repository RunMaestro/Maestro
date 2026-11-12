import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	fetchHistoryFilePath,
	hasExistingDocuments,
	listExistingDocuments,
	loadDocumentContents,
	resolveAutoRunFolderPath,
} from '../../../../../renderer/hooks/batch/inlineWizard/documents';

describe('inline wizard document helpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window.maestro as any).history = {
			getFilePath: vi.fn(),
		};
	});

	it('prefers configured Auto Run folder path', () => {
		expect(resolveAutoRunFolderPath('/repo', '/custom/playbooks')).toBe('/custom/playbooks');
	});

	it('falls back to the default playbooks path', () => {
		expect(resolveAutoRunFolderPath('/repo')).toBe('/repo/.maestro/playbooks');
	});

	it('detects whether existing documents are present', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['phase-1'],
		});

		await expect(hasExistingDocuments('/repo/.maestro/playbooks')).resolves.toBe(true);
		expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith('/repo/.maestro/playbooks');
	});

	it('treats list errors as no existing documents', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockRejectedValueOnce(new Error('missing'));

		await expect(hasExistingDocuments('/missing')).resolves.toBe(false);
	});

	it('maps existing document names to markdown paths', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['phase-1', 'phase-2'],
		});

		await expect(listExistingDocuments('/docs')).resolves.toEqual([
			{ name: 'phase-1', filename: 'phase-1.md', path: '/docs/phase-1.md' },
			{ name: 'phase-2', filename: 'phase-2.md', path: '/docs/phase-2.md' },
		]);
	});

	it('loads document contents and preserves unreadable docs with placeholder content', async () => {
		vi.mocked(window.maestro.autorun.readDoc)
			.mockResolvedValueOnce({ success: true, content: '# One' })
			.mockRejectedValueOnce(new Error('read failed'));

		await expect(
			loadDocumentContents(
				[
					{ name: 'phase-1', filename: 'phase-1.md', path: '/docs/phase-1.md' },
					{ name: 'phase-2', filename: 'phase-2.md', path: '/docs/phase-2.md' },
				],
				'/docs'
			)
		).resolves.toEqual([
			{ name: 'phase-1', filename: 'phase-1.md', path: '/docs/phase-1.md', content: '# One' },
			{
				name: 'phase-2',
				filename: 'phase-2.md',
				path: '/docs/phase-2.md',
				content: '(Failed to load content)',
			},
		]);
	});

	it('fetches local history file paths', async () => {
		vi.mocked(window.maestro.history.getFilePath).mockResolvedValueOnce('/history/session.jsonl');

		await expect(fetchHistoryFilePath('session-1')).resolves.toBe('/history/session.jsonl');
		expect(window.maestro.history.getFilePath).toHaveBeenCalledWith('session-1');
	});

	it('skips history file lookup for SSH sessions', async () => {
		await expect(
			fetchHistoryFilePath('session-1', { enabled: true, remoteId: 'remote-1' })
		).resolves.toBeUndefined();
		expect(window.maestro.history.getFilePath).not.toHaveBeenCalled();
	});
});
