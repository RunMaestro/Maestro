/**
 * @file updatesHandler.test.ts
 * @description Tests for the list_rollback_targets / rollback_update WebSocket
 * handlers behind `maestro-cli rollback`. They must call the same functions as
 * the Check for Updates modal, and refuse every socket that is not the CLI: a
 * browser must never be able to downgrade the host.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.4' } }));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/update-checker', () => ({
	listRollbackTargets: vi.fn(),
}));

vi.mock('../../../../main/auto-updater', () => ({
	downloadRollback: vi.fn(),
}));

const settingsGet = vi.fn();
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: settingsGet }),
}));

import {
	handleListRollbackTargets,
	handleRollbackUpdate,
} from '../../../../main/web-server/handlers/messageHandlers/updates';
import { listRollbackTargets } from '../../../../main/update-checker';
import { downloadRollback } from '../../../../main/auto-updater';

function makeCtx() {
	return { send: vi.fn(), sendError: vi.fn(), reportHandlerError: vi.fn(), callbacks: {} };
}

const cliClient = { id: 'c1', connectedAt: 0, cli: true } as never;
const browserClient = { id: 'b1', connectedAt: 0 } as never;

describe('updates WebSocket handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		settingsGet.mockReturnValue(false);
		vi.mocked(listRollbackTargets).mockResolvedValue({
			currentVersion: '1.0.4',
			releases: [],
			releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
		});
		vi.mocked(downloadRollback).mockResolvedValue({ success: true, version: '1.0.3' });
	});

	describe('list_rollback_targets', () => {
		it('uses the "Include pre-release updates" setting when no flag is given', async () => {
			settingsGet.mockReturnValue(true);
			const ctx = makeCtx();

			await handleListRollbackTargets(ctx as never, cliClient, {
				type: 'list_rollback_targets',
				requestId: 'r1',
			});

			expect(listRollbackTargets).toHaveBeenCalledWith('1.0.4', true);
			expect(ctx.send).toHaveBeenCalledWith(
				cliClient,
				expect.objectContaining({
					type: 'list_rollback_targets_result',
					success: true,
					currentVersion: '1.0.4',
					requestId: 'r1',
				})
			);
		});

		it('lets an explicit flag override the setting', async () => {
			settingsGet.mockReturnValue(true);

			await handleListRollbackTargets(makeCtx() as never, cliClient, {
				type: 'list_rollback_targets',
				includePrerelease: false,
			});

			expect(listRollbackTargets).toHaveBeenCalledWith('1.0.4', false);
		});

		it('reports a failed listing as unsuccessful', async () => {
			vi.mocked(listRollbackTargets).mockResolvedValue({
				currentVersion: '1.0.4',
				releases: [],
				releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
				error: 'GitHub API error: 503',
			});
			const ctx = makeCtx();

			await handleListRollbackTargets(ctx as never, cliClient, { type: 'list_rollback_targets' });

			expect(ctx.send).toHaveBeenCalledWith(
				cliClient,
				expect.objectContaining({ success: false, error: 'GitHub API error: 503' })
			);
		});
	});

	describe('rollback_update', () => {
		it("downloads the named version through the modal's own function", async () => {
			const ctx = makeCtx();

			await handleRollbackUpdate(ctx as never, cliClient, {
				type: 'rollback_update',
				version: '1.0.3',
				requestId: 'r2',
			});

			expect(downloadRollback).toHaveBeenCalledWith('1.0.3');
			expect(ctx.send).toHaveBeenCalledWith(cliClient, {
				type: 'rollback_update_result',
				success: true,
				version: '1.0.3',
				currentVersion: '1.0.4',
				requestId: 'r2',
			});
		});
	});

	it.each([
		['list_rollback_targets', handleListRollbackTargets, 'list_rollback_targets_result'],
		['rollback_update', handleRollbackUpdate, 'rollback_update_result'],
	] as const)('refuses %s from a browser socket', async (type, handler, resultType) => {
		const ctx = makeCtx();

		await handler(ctx as never, browserClient, { type, version: '1.0.3', requestId: 'r3' });

		expect(listRollbackTargets).not.toHaveBeenCalled();
		expect(downloadRollback).not.toHaveBeenCalled();
		expect(ctx.send).toHaveBeenCalledWith(
			browserClient,
			expect.objectContaining({ type: resultType, success: false, requestId: 'r3' })
		);
	});
});
