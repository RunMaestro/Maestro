/**
 * Drive a Browse button through `pickDirectory()` / `pickFile()` in any agent mode.
 *
 * A local agent's Browse opens the native dialog (`window.maestro.dialog.selectFolder` or
 * `selectFile`); an SSH or hosted agent's opens the Maestro-drawn picker
 * (`usePathPickerStore`). Parity tests click the same button in every mode and answer
 * whichever picker opened, so the assertion after the pick is identical for all three.
 *
 * Not in the helpers barrel: it imports a renderer store.
 */

import { act } from '@testing-library/react';
import { expect, type Mock } from 'vitest';
import { usePathPickerStore } from '../../renderer/services/pathPicker';
import type { AgentMode } from './mockSession';

/** The remote id `agentModeFields()` gives an SSH or hosted agent. */
export const MODE_REMOTE_ID = 'r1';

/**
 * Click Browse and pick `path` in whichever picker the mode opens. Asserts the right picker
 * opened: the native dialog for `local`, the remote picker on `remoteId` otherwise.
 */
export async function browseAndPick(
	mode: AgentMode,
	click: () => void,
	path: string | null,
	{ kind = 'directory', remoteId = MODE_REMOTE_ID } = {} as {
		kind?: 'directory' | 'file';
		remoteId?: string;
	}
): Promise<void> {
	const dialog = (window as unknown as { maestro: { dialog: Record<string, Mock> } }).maestro
		.dialog;
	const native = kind === 'directory' ? dialog.selectFolder : dialog.selectFile;
	native.mockClear();
	if (mode === 'local') native.mockResolvedValueOnce(path);
	await act(async () => {
		click();
	});
	if (mode === 'local') {
		expect(native).toHaveBeenCalledTimes(1);
		expect(usePathPickerStore.getState().request).toBeNull();
		return;
	}
	expect(native).not.toHaveBeenCalled();
	const request = usePathPickerStore.getState().request;
	expect(request).toMatchObject({ kind, sshRemoteId: remoteId });
	await act(async () => {
		usePathPickerStore.getState().settle(path);
	});
}

/** Close any picker a test left open, so the next test starts clean. */
export function resetPathPicker(): void {
	usePathPickerStore.getState().settle(null);
}
