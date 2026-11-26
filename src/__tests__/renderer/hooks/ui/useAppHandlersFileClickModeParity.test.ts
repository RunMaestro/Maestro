/**
 * @fileoverview Opening a file from the tree behaves the same for a local, an
 * SSH, and a hosted agent. A file Maestro cannot preview asks the same question
 * and opens in this machine's default app; media plays in the one floating
 * player. A remote file is fetched to this machine first; a remote text file
 * still previews over SSH.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppHandlers } from '../../../../renderer/hooks/ui/useAppHandlers';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { __resetFileActionsForTests } from '../../../../renderer/services/fileActions';
import type { FileNode } from '../../../../renderer/types/fileTree';
import { AGENT_MODES, createModeSession } from '../../../helpers';

const LOCAL_COPY = '/tmp/maestro-remote-downloads/k/file';
const original = (window as any).maestro;
let downloadRemoteFile: ReturnType<typeof vi.fn>;
let readFile: ReturnType<typeof vi.fn>;
let openPath: ReturnType<typeof vi.fn>;

function renderHandlers() {
	const onOpenFileTab = vi.fn();
	const { result } = renderHook(() =>
		useAppHandlers({
			setSessions: vi.fn(),
			setActiveFocus: vi.fn(),
			setConfirmModalMessage: vi.fn(),
			setConfirmModalOnConfirm: vi.fn(),
			setConfirmModalOpen: vi.fn(),
			onOpenFileTab,
		})
	);
	return { handleFileClick: result.current.handleFileClick, onOpenFileTab };
}

beforeEach(() => {
	__resetFileActionsForTests();
	downloadRemoteFile = vi.fn().mockResolvedValue({ success: true, path: LOCAL_COPY });
	readFile = vi.fn().mockResolvedValue('maestro-media://stream');
	openPath = vi.fn().mockResolvedValue(undefined);
	(window as any).maestro = {
		...original,
		shell: { ...original.shell, openPath },
		fs: {
			...original.fs,
			downloadRemoteFile,
			readFile,
			stat: vi.fn().mockResolvedValue({ modifiedAt: '2026-01-01T00:00:00Z' }),
		},
	};
	useModalStore.getState().closeModal('confirm');
});

afterEach(() => {
	(window as any).maestro = original;
});

describe.each(AGENT_MODES)('handleFileClick in %s mode', (mode) => {
	const remote = mode !== 'local';

	beforeEach(() => {
		const session = createModeSession(mode, {
			id: 'a1',
			fullPath: '/work',
			projectRoot: '/work',
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: 'a1' });
	});

	it('asks the same question for a file it cannot preview, then opens it here', async () => {
		const { handleFileClick, onOpenFileTab } = renderHandlers();
		const node: FileNode = { name: 'report.pdf', type: 'file' };

		await act(async () => {
			await handleFileClick(node, 'docs/report.pdf');
		});

		const confirm = useModalStore.getState().getData('confirm') as
			| { message: string; onConfirm: () => Promise<void> }
			| undefined;
		expect(confirm?.message).toBe('Open "report.pdf" in external application?');
		expect(onOpenFileTab).not.toHaveBeenCalled();

		await act(async () => {
			await confirm!.onConfirm();
		});
		expect(openPath).toHaveBeenCalledWith(remote ? LOCAL_COPY : '/work/docs/report.pdf');
	});

	it('plays media from a copy on this machine, with no loading tab', async () => {
		const { handleFileClick, onOpenFileTab } = renderHandlers();
		const node: FileNode = { name: 'song.mp3', type: 'file' };

		await act(async () => {
			await handleFileClick(node, 'audio/song.mp3', { mediaMode: 'queue' });
		});

		const readPath = remote ? LOCAL_COPY : '/work/audio/song.mp3';
		expect(readFile).toHaveBeenCalledWith(readPath, undefined, undefined);
		expect(onOpenFileTab).toHaveBeenCalledTimes(1);
		expect(onOpenFileTab).toHaveBeenCalledWith(
			expect.objectContaining({ path: readPath, sshRemoteId: undefined }),
			expect.objectContaining({ mediaMode: 'queue' })
		);
	});

	it('previews a text file where it lives', async () => {
		readFile.mockResolvedValue('# notes');
		const { handleFileClick, onOpenFileTab } = renderHandlers();

		await act(async () => {
			await handleFileClick({ name: 'notes.md', type: 'file' }, 'notes.md');
		});

		expect(downloadRemoteFile).not.toHaveBeenCalled();
		expect(readFile).toHaveBeenCalledWith(
			'/work/notes.md',
			remote ? 'r1' : undefined,
			remote ? expect.any(String) : undefined
		);
		expect(onOpenFileTab).toHaveBeenLastCalledWith(
			expect.objectContaining({ path: '/work/notes.md', content: '# notes' }),
			expect.anything()
		);
	});
});
