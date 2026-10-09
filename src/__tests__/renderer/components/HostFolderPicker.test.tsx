import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HostFolderPicker } from '../../../renderer/components/HostFolderPicker';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';
import {
	finishHostFolderSelection,
	selectHostFolder,
	selectHostSaveFile,
} from '../../../web-desktop/remote-file-dialog';

// This fixture deliberately speaks Windows paths even when the test runner does not.
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
	if (channel === 'fs:directoryInfo') {
		const path = args[0] ?? 'D:\\host-home';
		if (path === 'bad-path') throw new Error('Host directory not found');
		return { path, parent: 'D:\\', roots: ['D:\\'] };
	}
	if (channel === 'fs:readDir')
		return args[0] === 'D:\\host-home'
			? [
					{ name: 'project', path: 'D:\\host-home\\project', isDirectory: true, isFile: false },
					{
						name: 'private.txt',
						path: 'D:\\host-home\\private.txt',
						isDirectory: false,
						isFile: true,
					},
				]
			: [];
	throw new Error(`Unexpected host method ${channel}`);
}
function mount() {
	render(
		<LayerStackProvider>
			<HostFolderPicker theme={mockTheme} />
		</LayerStackProvider>
	);
}
afterEach(() => {
	cleanup();
	finishHostFolderSelection(null);
});

describe('host folder picker', () => {
	it('browses directories and accepts the exact host path rather than client separators', async () => {
		mount();
		let selected!: Promise<string | null>;
		act(() => {
			selected = selectHostFolder(invoke);
		});
		fireEvent.click(await screen.findByRole('button', { name: 'project' }));
		await waitFor(() =>
			expect(screen.getByLabelText('Absolute host directory path')).toHaveValue(
				'D:\\host-home\\project'
			)
		);
		expect(screen.queryByText('private.txt')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Select this host directory' }));
		await expect(selected).resolves.toBe('D:\\host-home\\project');
	});

	it('cancels through Escape without selecting any host path', async () => {
		mount();
		let selected!: Promise<string | null>;
		act(() => {
			selected = selectHostFolder(invoke);
		});
		await screen.findByRole('button', { name: 'project' });
		fireEvent.keyDown(window, { key: 'Escape' });
		await expect(selected).resolves.toBeNull();
	});

	it('rejects a save-name traversal and accepts a valid host file name after correction', async () => {
		mount();
		let selected!: Promise<string | null>;
		act(() => {
			selected = selectHostSaveFile(invoke, { defaultPath: 'report.csv' });
		});
		await screen.findByRole('button', { name: 'project' });
		fireEvent.change(screen.getByLabelText('File name on host'), {
			target: { value: '..\\outside.csv' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save on host' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('not a path');
		fireEvent.change(screen.getByLabelText('File name on host'), {
			target: { value: 'report.csv' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save on host' }));
		await expect(selected).resolves.toBe('D:\\host-home\\report.csv');
	});

	it('does not accept the previously listed directory after a failed navigation', async () => {
		mount();
		act(() => {
			void selectHostFolder(invoke);
		});
		await screen.findByRole('button', { name: 'project' });
		fireEvent.change(screen.getByLabelText('Absolute host directory path'), {
			target: { value: 'bad-path' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Go' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('not found');
		expect(screen.getByRole('button', { name: 'Select this host directory' })).toBeDisabled();
	});
});
