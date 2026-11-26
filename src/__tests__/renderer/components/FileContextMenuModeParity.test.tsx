/**
 * @fileoverview The right-click menu on a file link in the chat is the same for a
 * local, an SSH, and a hosted agent. Markdown passes the agent's `sshRemoteId`,
 * which changes only the transport: Open in Default App and Reveal act on a copy
 * fetched to this machine.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileContextMenu } from '../../../renderer/components/FileContextMenu';
import { __resetFileActionsForTests } from '../../../renderer/services/fileActions';
import { mockTheme } from '../../helpers/mockTheme';
import { AGENT_MODES, type AgentMode } from '../../helpers';

const LOCAL_COPY = '/tmp/maestro-remote-downloads/k/notes.md';
const remoteIdFor = (mode: AgentMode) => (mode === 'local' ? undefined : 'r1');
const original = (window as any).maestro;
let openPath: ReturnType<typeof vi.fn>;
let showItemInFolder: ReturnType<typeof vi.fn>;
let downloadRemoteFile: ReturnType<typeof vi.fn>;

const menu = { x: 10, y: 10, filePath: '/work/notes.md', fileName: 'notes.md' };

function drawMenu(mode: AgentMode, onDismiss = vi.fn()) {
	return render(
		<FileContextMenu
			menu={menu}
			theme={mockTheme}
			onDismiss={onDismiss}
			onPreview={vi.fn()}
			projectRoot="/work"
			sshRemoteId={remoteIdFor(mode)}
		/>
	);
}

beforeEach(() => {
	__resetFileActionsForTests();
	openPath = vi.fn().mockResolvedValue(undefined);
	showItemInFolder = vi.fn().mockResolvedValue(undefined);
	downloadRemoteFile = vi.fn().mockResolvedValue({ success: true, path: LOCAL_COPY });
	(window as any).maestro = {
		...original,
		platform: 'darwin',
		shell: { ...original?.shell, openPath, showItemInFolder },
		fs: { ...original?.fs, downloadRemoteFile },
	};
});

afterEach(() => {
	cleanup();
	(window as any).maestro = original;
});

describe('FileContextMenu mode parity', () => {
	it('draws the same rows, divider included, in every mode', () => {
		const rows = AGENT_MODES.map((mode) => {
			drawMenu(mode);
			const html = document.body.innerHTML;
			cleanup();
			return html;
		});
		expect(rows[0]).toContain('Open in Default App');
		expect(rows[0]).toMatch(/Reveal in (Finder|Explorer|File Manager)/);
		expect(rows[1]).toBe(rows[0]);
		expect(rows[2]).toBe(rows[0]);
	});

	it.each(AGENT_MODES)('%s: Open in Default App and Reveal act on this machine', async (mode) => {
		const expected = mode === 'local' ? '/work/notes.md' : LOCAL_COPY;
		drawMenu(mode);
		fireEvent.click(screen.getByText('Open in Default App'));
		await vi.waitFor(() => expect(openPath).toHaveBeenCalledWith(expected));
		cleanup();

		drawMenu(mode);
		fireEvent.click(screen.getByText(/Reveal in (Finder|Explorer|File Manager)/));
		await vi.waitFor(() => expect(showItemInFolder).toHaveBeenCalledWith(expected));
		expect(downloadRemoteFile).toHaveBeenCalledTimes(mode === 'local' ? 0 : 2);
	});
});
