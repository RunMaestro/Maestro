/**
 * The renderer side of playbook update detection: when the check runs, what
 * the store holds, and the update action with its guards and toasts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	checkPlaybookUpdates,
	updateInstalledPlaybook,
} from '../../../renderer/services/playbookUpdates';
import { usePlaybookUpdatesStore } from '../../../renderer/stores/playbookUpdatesStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { PlaybookUpdateStatus } from '../../../shared/playbookUpdates';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));

const target = { sessionId: 'agent-1', autoRunFolderPath: '/autorun', sshRemoteId: 'remote-1' };

function status(overrides: Partial<PlaybookUpdateStatus> = {}): PlaybookUpdateStatus {
	return {
		playbookId: 'record-1',
		marketplaceId: 'dev-security',
		name: 'Dev Security',
		targetFolderName: 'Dev Security',
		state: 'update-available',
		updateAvailable: true,
		installedVersion: '2026-08-01',
		latestVersion: '2026-09-01',
		modifiedDocuments: [],
		...overrides,
	};
}

const marketplace = () =>
	window.maestro.marketplace as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('checkPlaybookUpdates', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usePlaybookUpdatesStore.setState({
			statusesBySession: {},
			checkedSessionIds: {},
			updatingPlaybookIds: {},
		});
		marketplace().checkUpdates.mockResolvedValue({
			success: true,
			updates: { 'record-1': status() },
		});
	});

	it('asks main for the agent and stores the answer', async () => {
		const updates = await checkPlaybookUpdates(target);

		expect(marketplace().checkUpdates).toHaveBeenCalledWith('agent-1', '/autorun', 'remote-1');
		expect(updates).toEqual({ 'record-1': status() });
		expect(usePlaybookUpdatesStore.getState().statusesBySession['agent-1']).toEqual(updates);
	});

	it('checks an agent once per app start unless forced', async () => {
		await checkPlaybookUpdates(target);
		await checkPlaybookUpdates(target);
		expect(marketplace().checkUpdates).toHaveBeenCalledTimes(1);

		await checkPlaybookUpdates(target, { force: true });
		expect(marketplace().checkUpdates).toHaveBeenCalledTimes(2);
	});

	it('shares one call between concurrent checks of an agent', async () => {
		await Promise.all([
			checkPlaybookUpdates(target, { force: true }),
			checkPlaybookUpdates(target, { force: true }),
		]);
		expect(marketplace().checkUpdates).toHaveBeenCalledTimes(1);
	});

	it('does nothing for an agent without an Auto Run folder', async () => {
		expect(await checkPlaybookUpdates({ sessionId: 'agent-1', autoRunFolderPath: undefined })).toBe(
			null
		);
		expect(marketplace().checkUpdates).not.toHaveBeenCalled();
	});

	it('keeps the previous answer when a check fails', async () => {
		await checkPlaybookUpdates(target);
		marketplace().checkUpdates.mockResolvedValueOnce({ success: false, error: 'offline' });

		expect(await checkPlaybookUpdates(target, { force: true })).toBeNull();
		expect(usePlaybookUpdatesStore.getState().statusesBySession['agent-1']).toEqual({
			'record-1': status(),
		});
	});
});

describe('updateInstalledPlaybook', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usePlaybookUpdatesStore.setState({
			statusesBySession: { 'agent-1': { 'record-1': status() } },
			checkedSessionIds: { 'agent-1': true },
			updatingPlaybookIds: {},
		});
		useBatchStore.setState({ batchRunStates: {} });
		marketplace().checkUpdates.mockResolvedValue({
			success: true,
			updates: { 'record-1': status({ state: 'up-to-date', updateAvailable: false }) },
		});
	});

	it('updates through main, says so, and re-checks', async () => {
		marketplace().updatePlaybook.mockResolvedValue({
			success: true,
			playbook: {
				id: 'record-1',
				name: 'Dev Security',
				provenance: { sourceVersion: '2026-09-01' },
			},
			importedDocs: ['phase-1'],
			importedAssets: [],
			failedDocs: [],
			failedAssets: [],
		});

		const result = await updateInstalledPlaybook(target, 'dev-security');

		expect(result.success).toBe(true);
		expect(marketplace().updatePlaybook).toHaveBeenCalledWith(
			'dev-security',
			'/autorun',
			'agent-1',
			'remote-1'
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'green',
				title: 'Playbook updated',
				message: 'Dev Security is now at 2026-09-01. Your parameter answers were kept.',
			})
		);
		expect(marketplace().checkUpdates).toHaveBeenCalledTimes(1);
		expect(
			usePlaybookUpdatesStore.getState().statusesBySession['agent-1']['record-1'].updateAvailable
		).toBe(false);
		expect(usePlaybookUpdatesStore.getState().updatingPlaybookIds).toEqual({});
	});

	it('marks the record as updating while main works', async () => {
		let seenUpdating = false;
		marketplace().updatePlaybook.mockImplementation(async () => {
			seenUpdating = usePlaybookUpdatesStore.getState().updatingPlaybookIds['record-1'] === true;
			return { success: true, playbook: { name: 'Dev Security' } };
		});

		await updateInstalledPlaybook(target, 'dev-security');

		expect(seenUpdating).toBe(true);
		expect(usePlaybookUpdatesStore.getState().updatingPlaybookIds).toEqual({});
	});

	it('reports a failed update in a red toast', async () => {
		marketplace().updatePlaybook.mockResolvedValue({ success: false, error: 'GitHub is down' });

		const result = await updateInstalledPlaybook(target, 'dev-security');

		expect(result.success).toBe(false);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: 'GitHub is down' })
		);
	});

	it('reports a partial update in a yellow toast', async () => {
		marketplace().updatePlaybook.mockResolvedValue({
			success: true,
			playbook: { name: 'Dev Security' },
			failedDocs: ['phase-2'],
			failedAssets: [],
		});

		await updateInstalledPlaybook(target, 'dev-security');

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'yellow', title: 'Playbook updated partially' })
		);
	});

	it('refuses while the agent runs an Auto Run, since the update rewrites its documents', async () => {
		useBatchStore.setState({ batchRunStates: { 'agent-1': { isRunning: true } as any } });

		const result = await updateInstalledPlaybook(target, 'dev-security');

		expect(result.success).toBe(false);
		expect(marketplace().updatePlaybook).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Playbook not updated' })
		);
	});
});
