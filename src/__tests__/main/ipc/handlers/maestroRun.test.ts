/**
 * `maestroRun:*` IPC. Installing and granting act for the user who turned the
 * feature on, so both refuse while MaestroRun is off, the same rule the CLI's
 * `maestro_run_command` WS verbs follow. Status reads stay open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	enabled: true,
	service: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/maestro-run', () => ({
	getMaestroRunService: () => h.service,
}));

import { registerMaestroRunHandlers } from '../../../../main/ipc/handlers/maestroRun';

beforeEach(() => {
	h.handlers.clear();
	h.enabled = true;
	h.service = {
		status: vi.fn(() => ({ enabled: h.enabled })),
		install: vi.fn(async () => ({ enabled: true, installed: true })),
		requestAccess: vi.fn(async () => ({ enabled: true })),
	};
	registerMaestroRunHandlers();
});

describe('maestroRun IPC', () => {
	it('installs and requests access while the feature is on', async () => {
		await h.handlers.get('maestroRun:install')!({});
		expect(h.service!.install).toHaveBeenCalledOnce();
		await h.handlers.get('maestroRun:requestAccess')!({}, { reveal: true });
		expect(h.service!.requestAccess).toHaveBeenCalledWith({ reveal: true });
	});

	it('refuses install and requestAccess while the feature is off, but still reports status', async () => {
		h.enabled = false;
		await expect(h.handlers.get('maestroRun:install')!({})).rejects.toThrow('MaestroRunDisabled');
		await expect(h.handlers.get('maestroRun:requestAccess')!({}, {})).rejects.toThrow(
			'MaestroRunDisabled'
		);
		expect(h.service!.install).not.toHaveBeenCalled();
		expect(h.service!.requestAccess).not.toHaveBeenCalled();
		await expect(h.handlers.get('maestroRun:status')!({})).resolves.toEqual({ enabled: false });
	});
});
