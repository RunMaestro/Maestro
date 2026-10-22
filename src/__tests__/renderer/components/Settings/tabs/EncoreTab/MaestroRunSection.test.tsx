import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaestroRunSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import type { MaestroRunStatus } from '../../../../../../shared/maestro-run/status';
import { mockTheme } from '../../../../../helpers/mockTheme';

const APP = '/Users/me/Applications/MaestroRun.app';

function status(overrides: Partial<MaestroRunStatus> = {}): MaestroRunStatus {
	return {
		supported: true,
		enabled: true,
		phase: 'not-installed',
		appPath: APP,
		binaryPath: `${APP}/Contents/MacOS/maestro-run`,
		installedVersion: null,
		fullDiskAccess: 'unknown',
		latestVersion: null,
		updateAvailable: false,
		installing: false,
		watchingForAccess: false,
		detail: null,
		checkedAt: 1,
		...overrides,
	};
}

function makeApi(initial: MaestroRunStatus) {
	let push: ((next: MaestroRunStatus) => void) | null = null;
	return {
		status: vi.fn(async () => initial),
		refresh: vi.fn(async () => initial),
		install: vi.fn(async () => initial),
		requestAccess: vi.fn(async () => initial),
		readyPath: vi.fn(async () => null),
		onStatusChanged: vi.fn((handler: (next: MaestroRunStatus) => void) => {
			push = handler;
			return () => {
				push = null;
			};
		}),
		push: (next: MaestroRunStatus) => act(() => push?.(next)),
	};
}

let original: unknown;
const setEnabled = (maestroRun: boolean) =>
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, maestroRun },
	});

beforeEach(() => {
	original = (window.maestro as unknown as Record<string, unknown>).maestroRun;
	setEnabled(true);
});
afterEach(() => {
	(window.maestro as unknown as Record<string, unknown>).maestroRun = original;
	setEnabled(false);
});

function install(api: ReturnType<typeof makeApi>) {
	(window.maestro as unknown as Record<string, unknown>).maestroRun = api;
}

describe('MaestroRunSection', () => {
	it('offers the install and runs it through the service', async () => {
		const api = makeApi(status());
		install(api);
		render(<MaestroRunSection theme={mockTheme} />);

		fireEvent.click(await screen.findByRole('button', { name: 'Install MaestroRun' }));
		await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
		// The release check runs on mount for a tile that is on.
		expect(api.refresh).toHaveBeenCalledWith({ checkLatest: true });
		// Nothing to grant until the launcher exists.
		expect(screen.queryByRole('button', { name: 'Open Full Disk Access' })).toBeNull();
		expect(
			screen.getByText(/Agents are told nothing about MaestroRun until it is installed/)
		).toBeTruthy();
	});

	it('walks the grant once installed, with a reveal fallback', async () => {
		const api = makeApi(
			status({ phase: 'needs-access', installedVersion: '0.2.0', fullDiskAccess: 'not-granted' })
		);
		install(api);
		render(<MaestroRunSection theme={mockTheme} />);

		expect(await screen.findByText(/MaestroRun 0\.2\.0 is installed/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Install MaestroRun' })).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Open Full Disk Access' }));
		await waitFor(() => expect(api.requestAccess).toHaveBeenCalledWith());

		fireEvent.click(screen.getByRole('button', { name: /Not in the list\? Reveal in/ }));
		await waitFor(() => expect(api.requestAccess).toHaveBeenLastCalledWith({ reveal: true }));
	});

	it('turns ready by itself when main reports the grant', async () => {
		const waiting = status({
			phase: 'needs-access',
			installedVersion: '0.2.0',
			fullDiskAccess: 'not-granted',
			watchingForAccess: true,
		});
		const api = makeApi(waiting);
		install(api);
		render(<MaestroRunSection theme={mockTheme} />);
		expect(await screen.findByText('Watching for the switch.')).toBeTruthy();

		await api.push({
			...waiting,
			phase: 'ready',
			fullDiskAccess: 'granted',
			watchingForAccess: false,
		});

		expect(screen.getByText('MaestroRun holds Full Disk Access.')).toBeTruthy();
		expect(screen.getByText(/Every local agent Maestro starts is now told/)).toBeTruthy();
		expect(screen.getByText(`${APP}/Contents/MacOS/maestro-run`)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Open Full Disk Access' })).toBeNull();
	});

	it('offers the update when a newer release exists', async () => {
		const api = makeApi(
			status({
				phase: 'ready',
				installedVersion: '0.2.0',
				fullDiskAccess: 'granted',
				latestVersion: '0.3.0',
				updateAvailable: true,
			})
		);
		install(api);
		render(<MaestroRunSection theme={mockTheme} />);
		fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.3.0' }));
		await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
	});

	it('warns about a bundle that is not MaestroRun and offers to replace it', async () => {
		const api = makeApi(status({ phase: 'invalid', detail: 'code failed to satisfy requirement' }));
		install(api);
		render(<MaestroRunSection theme={mockTheme} />);
		expect(await screen.findByText('code failed to satisfy requirement')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Install MaestroRun' })).toBeTruthy();
	});

	it('shows no actions while the feature is off, and skips the release check', async () => {
		setEnabled(false);
		const api = makeApi(status({ enabled: false }));
		install(api);
		render(<MaestroRunSection theme={mockTheme} />);
		expect(await screen.findByText(/Turn MaestroRun on from the tile header/)).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
		expect(api.refresh).toHaveBeenCalledWith({ checkLatest: false });
	});

	it('offers Install again after an install fails', async () => {
		const api = makeApi(status());
		api.install.mockRejectedValue(
			new Error('MaestroRun has not published a release for this Mac yet.')
		);
		install(api);
		render(<MaestroRunSection theme={mockTheme} />);
		fireEvent.click(await screen.findByRole('button', { name: 'Install MaestroRun' }));
		await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(
				(screen.getByRole('button', { name: 'Install MaestroRun' }) as HTMLButtonElement).disabled
			).toBe(false)
		);
	});
});
