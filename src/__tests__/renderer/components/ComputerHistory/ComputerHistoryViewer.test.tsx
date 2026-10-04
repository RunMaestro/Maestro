import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerHistoryViewer } from '../../../../renderer/components/ComputerHistory';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { defaultComputerHistoryConfig } from '../../../../shared/computer-history/config';
import { mockTheme } from '../../../helpers/mockTheme';

const now = Date.now();
const slack = { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 1 };

function makeApi() {
	return {
		status: vi.fn(async () => ({
			enabled: true,
			running: true,
			state: 'recording',
			storeDir: '/data/computer-history',
			platform: 'macos',
			pausedUntil: null,
			helper: { state: 'running', restarts: 0, binaryPath: '/x', recentStderr: [] },
			helperStatus: null,
			eventsStored: 3,
			eventsDropped: 0,
			lastEventAt: null,
			currentSegment: null,
		})),
		onStatusChanged: vi.fn(() => () => {}),
		pause: vi.fn(async () => ({})),
		resume: vi.fn(async () => ({})),
		activity: vi.fn(async () => ({
			buckets: [
				{
					startMs: now - 60_000,
					events: 2,
					apps: { [slack.id]: 2 },
					activeMs: { [slack.id]: 90_000 },
				},
			],
			apps: [{ ...slack, events: 2, activeMs: 90_000, lastWindowMs: now - 60_000 }],
			totalEvents: 2,
		})),
		query: vi.fn(async () => ({
			events: [
				{
					v: 1,
					seq: 0,
					ts: new Date(now - 30_000).toISOString(),
					kind: 'text.committed',
					app: slack,
					window: { title: 'general - Acme' },
					element: { role: 'text_area', label: 'Message' },
					text: 'ship the viewer',
				},
			],
			limited: false,
			segmentsScanned: 1,
		})),
		digests: vi.fn(async () => []),
		getConfig: vi.fn(async () => defaultComputerHistoryConfig()),
		knownApps: vi.fn(async () => []),
		listRules: vi.fn(async () => ({ rules: [], builtIn: [] })),
	};
}

let original: unknown;
let api: ReturnType<typeof makeApi>;

beforeEach(() => {
	original = (window.maestro as unknown as Record<string, unknown>).computerHistory;
	api = makeApi();
	(window.maestro as unknown as Record<string, unknown>).computerHistory = api;
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, computerHistory: true },
	});
});
afterEach(() => {
	(window.maestro as unknown as Record<string, unknown>).computerHistory = original;
});

describe('ComputerHistoryViewer', () => {
	it('renders visits with what was typed, and the recorder state', async () => {
		render(<ComputerHistoryViewer theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('ship the viewer')).toBeTruthy();
		expect(screen.getByText('general - Acme')).toBeTruthy();
		expect((await screen.findByTestId('computer-history-state')).textContent).toContain(
			'Recording'
		);
	});

	it('clicking an app filters the event query to it', async () => {
		render(<ComputerHistoryViewer theme={mockTheme} onClose={vi.fn()} />);
		const apps = await screen.findByTestId('computer-history-apps');
		fireEvent.click(await within(apps).findByText('Slack'));
		await waitFor(() =>
			expect(api.query).toHaveBeenLastCalledWith(expect.objectContaining({ apps: [slack.id] }))
		);
	});

	it('the ESC pill clears an active search before it closes', async () => {
		const onClose = vi.fn();
		render(<ComputerHistoryViewer theme={mockTheme} onClose={onClose} />);
		const search = await screen.findByPlaceholderText('Search text, titles, URLs');
		fireEvent.change(search, { target: { value: 'viewer' } });
		fireEvent.click(screen.getByTestId('computer-history-esc'));
		expect(onClose).not.toHaveBeenCalled();
		expect((search as HTMLInputElement).value).toBe('');
		fireEvent.click(screen.getByTestId('computer-history-esc'));
		expect(onClose).toHaveBeenCalled();
	});

	it('pauses from the header', async () => {
		render(<ComputerHistoryViewer theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByTestId('computer-history-pause'));
		await waitFor(() => expect(api.pause).toHaveBeenCalledWith(null));
	});
});
