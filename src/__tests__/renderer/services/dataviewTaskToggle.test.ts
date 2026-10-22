/**
 * Ticking a task from a Dataview TASK result in a file other than the note on
 * screen (DV-8): the one-line rewrite lands in that file, and every guard that
 * could fork or corrupt it refuses instead.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	toggleDataviewResultTask,
	toggleDataviewTaskInFile,
} from '../../../renderer/services/dataviewTaskToggle';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockFileTab } from '../../helpers/mockTab';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

const FILE = '/vault/Projects/Alpha.md';
const CONTENT = '# Alpha\n\n- [ ] ship it\n- [x] plan it\n';

function seedTabs(tabs: ReturnType<typeof createMockFileTab>[] = []) {
	useSessionStore.setState({
		sessions: [createMockSession({ id: 'agent-1', filePreviewTabs: tabs })],
	} as never);
}

describe('toggleDataviewTaskInFile', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		seedTabs();
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue(CONTENT);
		vi.mocked(window.maestro.fs.writeFile).mockResolvedValue({ success: true });
	});

	it('rewrites the task line in its own file', async () => {
		await expect(
			toggleDataviewTaskInFile({ filePath: FILE, line: 3, text: 'ship it', sshRemoteId: null })
		).resolves.toBe(true);

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(FILE, undefined);
		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			FILE,
			'# Alpha\n\n- [x] ship it\n- [x] plan it\n',
			undefined
		);
	});

	it('reads and writes through the SSH remote the result came from', async () => {
		await toggleDataviewTaskInFile({
			filePath: FILE,
			line: 4,
			text: 'plan it',
			sshRemoteId: 'remote-1',
		});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(FILE, 'remote-1');
		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			FILE,
			'# Alpha\n\n- [ ] ship it\n- [ ] plan it\n',
			'remote-1'
		);
	});

	it('compares only the first line of a multi-line task', async () => {
		await expect(
			toggleDataviewTaskInFile({ filePath: FILE, line: 3, text: 'ship it\nwith notes' })
		).resolves.toBe(true);
	});

	it('refuses when the line no longer holds the reported task', async () => {
		await expect(
			toggleDataviewTaskInFile({ filePath: FILE, line: 3, text: 'plan it' })
		).resolves.toBe(false);
		await expect(
			toggleDataviewTaskInFile({ filePath: FILE, line: 1, text: 'Alpha' })
		).resolves.toBe(false);
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it('refuses while an open tab holds unsaved edits to the file', async () => {
		seedTabs([createMockFileTab({ path: FILE, content: CONTENT, editContent: `${CONTENT}more` })]);

		await expect(
			toggleDataviewTaskInFile({ filePath: FILE, line: 3, text: 'ship it' })
		).resolves.toBe(false);
		expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unsaved Changes' }));
	});

	it('ignores a tab of the file whose buffer matches the disk', async () => {
		seedTabs([createMockFileTab({ path: FILE, content: CONTENT, editContent: CONTENT })]);

		await expect(
			toggleDataviewTaskInFile({ filePath: FILE, line: 3, text: 'ship it' })
		).resolves.toBe(true);
	});

	it('reports a failed write and resolves false', async () => {
		vi.mocked(window.maestro.fs.writeFile).mockRejectedValue(
			new Error("Error invoking remote method 'fs:writeFile': Error: EACCES")
		);

		await expect(
			toggleDataviewTaskInFile({ filePath: FILE, line: 3, text: 'ship it' })
		).resolves.toBe(false);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Save Failed', message: 'EACCES' })
		);
	});

	it('serializes two toggles of one file so the second sees the first', async () => {
		let disk = CONTENT;
		vi.mocked(window.maestro.fs.readFile).mockImplementation(async () => disk);
		vi.mocked(window.maestro.fs.writeFile).mockImplementation(async (_path, content) => {
			disk = content;
			return { success: true };
		});

		await Promise.all([
			toggleDataviewTaskInFile({ filePath: FILE, line: 3, text: 'ship it' }),
			toggleDataviewTaskInFile({ filePath: FILE, line: 4, text: 'plan it' }),
		]);

		expect(disk).toBe('# Alpha\n\n- [x] ship it\n- [ ] plan it\n');
	});
});

describe('toggleDataviewResultTask', () => {
	const origin = { root: '/vault', sshRemoteId: 'remote-1', path: 'Notes/Today.md' };

	beforeEach(() => {
		vi.clearAllMocks();
		seedTabs();
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue(CONTENT);
		vi.mocked(window.maestro.fs.writeFile).mockResolvedValue({ success: true });
	});

	it('toggles a task of the note on screen through the surface, never through the file system', async () => {
		const toggleOwnTask = vi.fn(async () => true);
		await expect(
			toggleDataviewResultTask(toggleOwnTask, origin, {
				path: 'Notes/Today.md',
				line: 7,
				text: 'x',
			})
		).resolves.toBe(true);
		expect(toggleOwnTask).toHaveBeenCalledWith(7);
		expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
	});

	it('refuses a task of the note on screen when the surface has no toggle', async () => {
		await expect(
			toggleDataviewResultTask(undefined, origin, { path: 'Notes/Today.md', line: 7, text: 'x' })
		).resolves.toBe(false);
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it("toggles a task of any other file in that file, under the result's root and host", async () => {
		const toggleOwnTask = vi.fn(async () => true);
		await expect(
			toggleDataviewResultTask(toggleOwnTask, origin, {
				path: 'Projects/Alpha.md',
				line: 3,
				text: 'ship it',
			})
		).resolves.toBe(true);
		expect(toggleOwnTask).not.toHaveBeenCalled();
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(FILE, 'remote-1');
		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			FILE,
			'# Alpha\n\n- [x] ship it\n- [x] plan it\n',
			'remote-1'
		);
	});
});
