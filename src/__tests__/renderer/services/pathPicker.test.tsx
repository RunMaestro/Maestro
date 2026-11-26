/**
 * pickDirectory() / pickFile() and the Maestro-drawn PathPickerModal.
 *
 * Parity (docs/parity/agent-ux-parity.md): one Browse entry point for a local, an SSH, and a
 * hosted agent. Local opens the native dialog; SSH and hosted (which keeps its SSH fields)
 * list the remote through `fs.readDir(path, sshRemoteId)`, the Files panel's read.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	fileOpRemoteId,
	pathPickerRemoteId,
	pickDirectory,
	UNRESOLVED_REMOTE_MESSAGE,
	UnresolvedRemoteError,
	pickFile,
	usePathPickerStore,
} from '../../../renderer/services/pathPicker';
import {
	PathPickerHost,
	remoteParentPath,
} from '../../../renderer/components/PathPicker/PathPickerModal';
import { AGENT_MODES, createModeSession } from '../../helpers';
import { getSessionSshRemoteId } from '../../../renderer/utils/sessionHelpers';
import { browseAndPick, resetPathPicker } from '../../helpers/pathPicker';
import { mockTheme } from '../../helpers/mockTheme';
import { notifyToast } from '../../../renderer/stores/notificationStore';

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn().mockReturnValue('layer-1'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

const readDir = vi.fn();
const selectFolder = vi.fn();
const selectFile = vi.fn();

const dir = (path: string, name: string, isDirectory = true) => ({
	name,
	path: `${path === '/' ? '' : path}/${name}`,
	isDirectory,
	isFile: !isDirectory,
});

beforeEach(() => {
	readDir.mockImplementation(async (path: string) => {
		if (path === '/home/me') {
			return [dir(path, 'zeta'), dir(path, 'alpha'), dir(path, 'notes.md', false)];
		}
		if (path === '/home/me/alpha') return [dir(path, 'deep')];
		if (path === '/home') return [dir(path, 'me')];
		throw new Error('Directory not found or not accessible');
	});
	(window as any).maestro = {
		...(window as any).maestro,
		dialog: { selectFolder, selectFile },
		fs: { ...(window as any).maestro?.fs, readDir },
	};
});

afterEach(() => {
	resetPathPicker();
	vi.clearAllMocks();
});

describe('pathPicker service: mode parity (local, SSH, hosted)', () => {
	it.each(AGENT_MODES)('%s: resolves the remote a session browses', (mode) => {
		expect(pathPickerRemoteId(createModeSession(mode))).toBe(mode === 'local' ? undefined : 'r1');
	});

	// An SSH agent with no remote resolved yet keeps the `null` sentinel. `undefined` would read
	// as "this machine" and open the native dialog on the wrong disk.
	it('an SSH agent with no remote resolved yet is null, and Browse says so', async () => {
		const sshRemoteId = pathPickerRemoteId(
			createModeSession('local', { sessionSshRemoteConfig: { enabled: true, remoteId: null } })
		);
		expect(sshRemoteId).toBeNull();

		await expect(pickDirectory({ sshRemoteId })).resolves.toBeNull();
		await expect(pickFile({ sshRemoteId })).resolves.toBeNull();
		expect(selectFolder).not.toHaveBeenCalled();
		expect(selectFile).not.toHaveBeenCalled();
		expect(usePathPickerStore.getState().request).toBeNull();
		expect(notifyToast).toHaveBeenCalledTimes(2);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Nothing to browse yet' })
		);
	});

	it('a remote id left on an agent with SSH off is this machine', () => {
		expect(
			pathPickerRemoteId(
				createModeSession('local', { sessionSshRemoteConfig: { enabled: false, remoteId: 'r1' } })
			)
		).toBeUndefined();
	});

	it.each(AGENT_MODES)('%s: a file operation goes where Browse looks', (mode) => {
		const session = createModeSession(mode);
		expect(fileOpRemoteId(pathPickerRemoteId(session))).toBe(getSessionSshRemoteId(session));
		expect(fileOpRemoteId(pathPickerRemoteId(session))).toBe(mode === 'local' ? undefined : 'r1');
	});

	// The transport for an unresolved remote fails loudly instead of running on this machine.
	it('a file operation for an SSH agent with no remote resolved yet throws the reason', () => {
		expect(() => fileOpRemoteId(null)).toThrow(UnresolvedRemoteError);
		expect(() => fileOpRemoteId(null)).toThrow(UNRESOLVED_REMOTE_MESSAGE);
	});

	it('a stale remote id on an agent with SSH off is never a file operation target', () => {
		const session = createModeSession('local', {
			sessionSshRemoteConfig: { enabled: false, remoteId: 'r1' },
		});
		expect(getSessionSshRemoteId(session)).toBeUndefined();
		expect(fileOpRemoteId(pathPickerRemoteId(session))).toBeUndefined();
	});

	it.each(AGENT_MODES)('%s: pickDirectory returns the picked folder', async (mode) => {
		const sshRemoteId = pathPickerRemoteId(createModeSession(mode));
		let picked: string | null | undefined;
		await browseAndPick(
			mode,
			() => {
				void pickDirectory({ sshRemoteId, title: 'Pick' }).then((p) => (picked = p));
			},
			'/srv/project'
		);
		await waitFor(() => expect(picked).toBe('/srv/project'));
	});

	it.each(AGENT_MODES)('%s: pickFile returns the picked file', async (mode) => {
		const sshRemoteId = pathPickerRemoteId(createModeSession(mode));
		let picked: string | null | undefined;
		await browseAndPick(
			mode,
			() => {
				void pickFile({ sshRemoteId, filters: [{ name: 'Zip', extensions: ['zip'] }] }).then(
					(p) => (picked = p)
				);
			},
			'/srv/bundle.zip',
			{ kind: 'file' }
		);
		await waitFor(() => expect(picked).toBe('/srv/bundle.zip'));
	});

	it.each(AGENT_MODES)('%s: a cancel resolves null', async (mode) => {
		const sshRemoteId = pathPickerRemoteId(createModeSession(mode));
		let picked: string | null | undefined;
		await browseAndPick(
			mode,
			() => {
				void pickDirectory({ sshRemoteId }).then((p) => (picked = p));
			},
			null
		);
		await waitFor(() => expect(picked).toBeNull());
	});

	it('a second remote Browse cancels the first instead of leaving it pending', async () => {
		const first = pickDirectory({ sshRemoteId: 'r1' });
		const second = pickDirectory({ sshRemoteId: 'r1' });
		await expect(first).resolves.toBeNull();
		act(() => usePathPickerStore.getState().settle('/b'));
		await expect(second).resolves.toBe('/b');
	});

	it('the remote picker opens in the remote home when no start path is given', () => {
		void pickDirectory({ sshRemoteId: 'r1' });
		expect(usePathPickerStore.getState().request).toMatchObject({ startPath: '~' });
	});
});

describe('remoteParentPath', () => {
	it('walks up a POSIX path and stops at the root and at the home alias', () => {
		expect(remoteParentPath('/home/me/alpha')).toBe('/home/me');
		expect(remoteParentPath('/home/')).toBe('/');
		expect(remoteParentPath('/home')).toBe('/');
		expect(remoteParentPath('/')).toBeNull();
		expect(remoteParentPath('~/code')).toBe('~');
		expect(remoteParentPath('~')).toBeNull();
	});
});

describe('PathPickerModal', () => {
	const open = (kind: 'directory' | 'file' = 'directory') => {
		let picked: Promise<string | null>;
		act(() => {
			picked =
				kind === 'directory'
					? pickDirectory({ sshRemoteId: 'r1', title: 'Select Folder', startPath: '/home/me' })
					: pickFile({
							sshRemoteId: 'r1',
							title: 'Select File',
							startPath: '/home/me',
							filters: [{ name: 'Markdown', extensions: ['md'] }],
						});
		});
		render(<PathPickerHost theme={mockTheme} />);
		return () => picked;
	};

	it('lists the remote folders, sorted, through fs.readDir with the remote id', async () => {
		open();
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(2));
		expect(readDir).toHaveBeenCalledWith('/home/me', 'r1');
		expect(screen.getAllByTestId('path-picker-row').map((row) => row.textContent)).toEqual([
			'alpha',
			'zeta',
		]);
		// The copy never names the transport.
		expect(screen.getByTestId('path-picker').textContent).not.toMatch(/remote|ssh|host/i);
	});

	it('Enter opens the highlighted folder, Backspace goes up, Select Folder returns it', async () => {
		const picked = open();
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(2));
		const list = screen.getByTestId('path-picker-list');
		fireEvent.keyDown(list, { key: 'Enter' });
		await waitFor(() =>
			expect(screen.getByTestId('path-picker-path')).toHaveValue('/home/me/alpha')
		);
		fireEvent.keyDown(list, { key: 'Backspace' });
		await waitFor(() => expect(screen.getByTestId('path-picker-path')).toHaveValue('/home/me'));
		fireEvent.keyDown(list, { key: 'ArrowDown' });
		fireEvent.keyDown(list, { key: 'Enter' });
		await waitFor(() => expect(readDir).toHaveBeenLastCalledWith('/home/me/zeta', 'r1'));
		await waitFor(() => expect(screen.getByTestId('path-picker-error')).toBeInTheDocument());
		fireEvent.click(screen.getByTestId('path-picker-up'));
		await waitFor(() => expect(screen.getByTestId('path-picker-path')).toHaveValue('/home'));
		fireEvent.click(screen.getByRole('button', { name: 'Select Folder' }));
		await expect(picked()).resolves.toBe('/home');
		expect(usePathPickerStore.getState().request).toBeNull();
	});

	it('a typed path is listed on Enter', async () => {
		open();
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(2));
		const input = screen.getByTestId('path-picker-path');
		fireEvent.change(input, { target: { value: '/home/me/alpha' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(1));
		expect(screen.getByTestId('path-picker-row').textContent).toBe('deep');
	});

	it('file mode lists matching files and picks one', async () => {
		const picked = open('file');
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(3));
		const confirm = screen.getByRole('button', { name: 'Select File' });
		expect(confirm).toBeDisabled();
		fireEvent.click(screen.getByText('notes.md'));
		expect(confirm).not.toBeDisabled();
		fireEvent.click(confirm);
		await expect(picked()).resolves.toBe('/home/me/notes.md');
	});

	// The previous listing stays in memory while the next one loads or after it fails, but it is
	// not drawn. Enter must not pick a file from it.
	it('Enter does not pick a row from the previous listing while loading or after a failure', async () => {
		open('file');
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(3));
		const list = screen.getByTestId('path-picker-list');
		// Highlight the file (alpha, zeta, notes.md).
		fireEvent.keyDown(list, { key: 'ArrowDown' });
		fireEvent.keyDown(list, { key: 'ArrowDown' });
		expect(screen.getByRole('option', { selected: true }).textContent).toBe('notes.md');

		// Loading: the parent listing has not answered yet.
		let answer!: (entries: ReturnType<typeof dir>[]) => void;
		readDir.mockImplementationOnce(
			() => new Promise((resolve) => (answer = resolve as typeof answer))
		);
		fireEvent.keyDown(list, { key: 'Backspace' });
		await waitFor(() => expect(screen.queryAllByTestId('path-picker-row')).toHaveLength(0));
		fireEvent.keyDown(list, { key: 'Enter' });
		expect(usePathPickerStore.getState().request).not.toBeNull();
		await act(async () => answer([dir('/home', 'me')]));
		await waitFor(() => expect(screen.getByTestId('path-picker-path')).toHaveValue('/home'));

		// Failed: the typed folder does not exist, and the list shows the error.
		const input = screen.getByTestId('path-picker-path');
		fireEvent.change(input, { target: { value: '/nope' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() => expect(screen.getByTestId('path-picker-error')).toBeInTheDocument());
		readDir.mockClear();
		fireEvent.keyDown(list, { key: 'Enter' });
		expect(readDir).not.toHaveBeenCalled();
		expect(usePathPickerStore.getState().request).not.toBeNull();
	});

	it('Cancel resolves null', async () => {
		const picked = open();
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(2));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await expect(picked()).resolves.toBeNull();
	});
});
