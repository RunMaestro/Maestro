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
	pathPickerRemoteId,
	pickDirectory,
	pickFile,
	usePathPickerStore,
} from '../../../renderer/services/pathPicker';
import {
	PathPickerHost,
	remoteParentPath,
} from '../../../renderer/components/PathPicker/PathPickerModal';
import { AGENT_MODES, createModeSession } from '../../helpers';
import { browseAndPick, resetPathPicker } from '../../helpers/pathPicker';
import { mockTheme } from '../../helpers/mockTheme';

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

	it('Cancel resolves null', async () => {
		const picked = open();
		await waitFor(() => expect(screen.getAllByTestId('path-picker-row')).toHaveLength(2));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await expect(picked()).resolves.toBeNull();
	});
});
