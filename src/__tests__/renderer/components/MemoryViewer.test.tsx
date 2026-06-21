import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryViewer } from '../../../renderer/components/MemoryViewer';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Session, Theme } from '../../../renderer/types';
import { THEMES } from '../../../shared/themes';

const theme = THEMES.dracula as Theme;

const activeSession = {
	id: 'session-1',
	name: 'Claude Workbench',
	cwd: '/repo',
	projectRoot: '/repo',
	toolType: 'claude-code',
	status: 'idle',
} as Session;

function memoryEntry(name: string, size = 128) {
	return {
		name,
		size,
		createdAt: '2026-06-18T10:00:00.000Z',
		modifiedAt: '2026-06-18T10:05:00.000Z',
	};
}

function installMemoryMocks(
	initialEntries = [memoryEntry('MEMORY.md'), memoryEntry('details.md')]
) {
	let entries = [...initialEntries];
	const contents = new Map<string, string>([
		['MEMORY.md', '# Memory index\n\n- [Details](details.md)'],
		['details.md', '---\nname: details\n---\n\nRemember this.'],
	]);

	const list = vi.fn().mockImplementation(async () => ({
		success: true,
		directoryPath: '/repo/.claude/memories',
		entries,
		stats: {
			fileCount: entries.length,
			firstCreatedAt: entries[0]?.createdAt ?? null,
			lastModifiedAt: entries.at(-1)?.modifiedAt ?? null,
			totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
		},
	}));
	const read = vi.fn().mockImplementation(async (_projectPath: string, filename: string) => ({
		success: true,
		content: contents.get(filename) ?? '',
	}));
	const write = vi
		.fn()
		.mockImplementation(async (_projectPath, filename: string, content: string) => {
			contents.set(filename, content);
			entries = entries.map((entry) =>
				entry.name === filename ? { ...entry, size: content.length } : entry
			);
			return { success: true };
		});
	const create = vi
		.fn()
		.mockImplementation(async (_projectPath, filename: string, content: string) => {
			contents.set(filename, content);
			entries = [...entries, memoryEntry(filename, content.length)];
			return { success: true };
		});
	const remove = vi.fn().mockImplementation(async (_projectPath, filename: string) => {
		entries = entries.filter((entry) => entry.name !== filename);
		contents.delete(filename);
		return { success: true };
	});

	(window as any).maestro.memory = {
		list,
		read,
		write,
		create,
		delete: remove,
		getPath: vi.fn(),
	};

	return { list, read, write, create, remove, contents };
}

function renderViewer(onClose = vi.fn(), session: Session | null = activeSession) {
	return render(
		<LayerStackProvider>
			<MemoryViewer theme={theme} activeSession={session ?? undefined} onClose={onClose} />
		</LayerStackProvider>
	);
}

describe('MemoryViewer', () => {
	beforeEach(() => {
		(window as any).maestro.shell.openPath = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		delete (window as any).maestro.memory;
	});

	it('loads the memory index, edits it, saves through IPC, and opens the memory folder', async () => {
		const { list, read, write } = installMemoryMocks();
		const onClose = vi.fn();

		renderViewer(onClose);

		expect((await screen.findAllByText('MEMORY.md')).length).toBeGreaterThan(0);
		expect(screen.getByText('Claude Code Memories for Claude Workbench')).toBeInTheDocument();
		expect(screen.getByText('2 files')).toBeInTheDocument();
		expect(screen.getByDisplayValue(/# Memory index/)).toBeInTheDocument();
		expect(list).toHaveBeenCalledWith('/repo', 'claude-code');
		expect(read).toHaveBeenCalledWith('/repo', 'MEMORY.md', 'claude-code');

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: '# Changed memory index' } });

		expect(screen.getByText('Modified')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(write).toHaveBeenCalledWith(
				'/repo',
				'MEMORY.md',
				'# Changed memory index',
				'claude-code'
			)
		);
		expect(await screen.findByText('Changes saved')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /open in/i }));
		expect((window as any).maestro.shell.openPath).toHaveBeenCalledWith('/repo/.claude/memories');

		fireEvent.click(screen.getByTitle('Close memory viewer'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('guards unsaved selection changes and deletes non-index memory files', async () => {
		const { read, remove } = installMemoryMocks();
		renderViewer();

		await screen.findByDisplayValue(/# Memory index/);
		fireEvent.change(screen.getByRole('textbox'), { target: { value: '# Unsaved' } });

		vi.mocked(window.confirm).mockReturnValueOnce(false);
		fireEvent.click(screen.getByRole('button', { name: 'details.md' }));
		expect(read).not.toHaveBeenCalledWith('/repo', 'details.md', 'claude-code');

		vi.mocked(window.confirm).mockReturnValueOnce(true);
		fireEvent.click(screen.getByRole('button', { name: 'details.md' }));
		expect(await screen.findByDisplayValue(/Remember this/)).toBeInTheDocument();

		vi.mocked(window.confirm).mockReturnValueOnce(false);
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(remove).not.toHaveBeenCalled();

		vi.mocked(window.confirm).mockReturnValueOnce(true);
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		await waitFor(() => expect(remove).toHaveBeenCalledWith('/repo', 'details.md', 'claude-code'));
		expect((await screen.findAllByText('MEMORY.md')).length).toBeGreaterThan(0);
	});

	it('creates the first memory file and reports missing active sessions', async () => {
		const { create } = installMemoryMocks([]);
		renderViewer();

		expect(await screen.findByText('No memory files yet for this project.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Create first memory' }));

		const filenameInput = screen.getByLabelText('Filename');
		expect(filenameInput).toHaveValue('MEMORY.md');
		fireEvent.change(filenameInput, { target: { value: 'new-memory' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() =>
			expect(create).toHaveBeenCalledWith(
				'/repo',
				'new-memory.md',
				expect.stringContaining('description: one-line description'),
				'claude-code'
			)
		);
		expect((await screen.findAllByText('new-memory.md')).length).toBeGreaterThan(0);

		cleanup();
		installMemoryMocks();
		renderViewer(vi.fn(), null);

		expect(await screen.findByText('No active agent session')).toBeInTheDocument();
	});
});
