import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../web/components/ThemeProvider';
import MobileHistoryPanel from '../../web/mobile/MobileHistoryPanel';
import type { HistoryEntry } from '../../shared/types';

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

const NOW = Date.UTC(2026, 0, 2, 15, 30);

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: 'entry-1',
		type: 'USER',
		timestamp: NOW,
		summary: 'Manual summary',
		fullResponse: 'Manual full response',
		projectPath: '/Users/test/project',
		sessionId: 'session-1',
		...overrides,
	};
}

function autoEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return entry({
		id: 'auto-1',
		type: 'AUTO',
		summary: 'Auto finished successfully',
		fullResponse: '\u001b[31mAuto full response\u001b[0m\nwith details',
		agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
		contextUsage: 95,
		elapsedTimeMs: 65_000,
		success: true,
		usageStats: {
			inputTokens: 1234,
			outputTokens: 5678,
			cacheReadInputTokens: 100,
			cacheCreationInputTokens: 50,
			totalCostUsd: 0.25,
			contextWindow: 128000,
		},
		...overrides,
	});
}

function renderPanel(props: Partial<React.ComponentProps<typeof MobileHistoryPanel>> = {}) {
	return render(
		<ThemeProvider>
			<MobileHistoryPanel onClose={vi.fn()} {...props} />
		</ThemeProvider>
	);
}

function mockHistory(entries: HistoryEntry[], ok = true, statusText = 'OK') {
	vi.mocked(fetch).mockResolvedValueOnce({
		ok,
		statusText,
		json: vi.fn().mockResolvedValue({ entries }),
	} as unknown as Response);
}

function touch(clientX: number, clientY: number) {
	return { clientX, clientY };
}

function getFilterButton(label: 'All' | 'AUTO' | 'USER') {
	const button = screen
		.getAllByRole('button')
		.find((item) => item.hasAttribute('aria-pressed') && item.textContent?.includes(label));
	if (!button) throw new Error(`Missing ${label} filter button`);
	return button;
}

describe('MobileHistoryPanel integration', () => {
	let originalFetch: typeof fetch;
	let originalConfig: typeof window.__MAESTRO_CONFIG__;
	let originalVibrate: PropertyDescriptor | undefined;
	let vibrateSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		originalFetch = globalThis.fetch;
		originalConfig = window.__MAESTRO_CONFIG__;
		originalVibrate = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
		vibrateSpy = vi.fn();
		globalThis.fetch = vi.fn();
		window.__MAESTRO_CONFIG__ = {
			securityToken: 'token-123',
			sessionId: null,
			tabId: null,
			apiBase: '/token-123/api',
			wsUrl: '/token-123/ws',
		};
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vibrateSpy,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.fetch = originalFetch;
		window.__MAESTRO_CONFIG__ = originalConfig;
		if (originalVibrate) {
			Object.defineProperty(navigator, 'vibrate', originalVibrate);
		} else {
			delete (navigator as Partial<Navigator>).vibrate;
		}
	});

	it('loads through real config URLs and filters/searches the history list', async () => {
		const onFilterChange = vi.fn();
		const onSearchChange = vi.fn();
		const entries = [
			autoEntry(),
			entry({
				id: 'user-1',
				timestamp: Date.now(),
				summary: 'Manual deploy note',
				fullResponse: 'manual details',
			}),
			autoEntry({
				id: 'auto-fail',
				summary: 'Auto failed validation',
				fullResponse: 'failure details',
				success: false,
				usageStats: { totalCostUsd: 0, inputTokens: 10, outputTokens: 5 },
			}),
		];
		mockHistory(entries);

		renderPanel({
			projectPath: '/Users/test/project',
			sessionId: 'session-1',
			onFilterChange,
			onSearchChange,
		});

		expect(screen.getByText('Loading history...')).toBeInTheDocument();
		expect(await screen.findByText('Auto finished successfully')).toBeInTheDocument();
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(
				/\/token-123\/api\/history\?projectPath=%2FUsers%2Ftest%2Fproject&sessionId=session-1$/
			)
		);
		expect(screen.getByTitle('Task completed successfully')).toBeInTheDocument();
		expect(screen.getByTitle('Task failed')).toBeInTheDocument();
		expect(screen.getAllByText('ABC12345')).toHaveLength(2);
		expect(screen.getByText('$0.25')).toBeInTheDocument();

		fireEvent.click(getFilterButton('AUTO'));
		expect(onFilterChange).toHaveBeenLastCalledWith('AUTO');
		expect(screen.queryByText('Manual deploy note')).not.toBeInTheDocument();
		expect(screen.getByText('Auto failed validation')).toBeInTheDocument();

		fireEvent.click(getFilterButton('USER'));
		expect(onFilterChange).toHaveBeenLastCalledWith('USER');
		expect(screen.getByText('Manual deploy note')).toBeInTheDocument();
		expect(screen.queryByText('Auto finished successfully')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Search history' }));
		const search = screen.getByPlaceholderText('Search history...');
		fireEvent.change(search, { target: { value: 'manual' } });
		expect(onSearchChange).toHaveBeenLastCalledWith('manual', true);
		expect(screen.getByText('1 found')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(onSearchChange).toHaveBeenLastCalledWith('', true);
		fireEvent.click(screen.getByRole('button', { name: 'Search history' }));
		expect(onSearchChange).toHaveBeenLastCalledWith('', false);
		expect(vibrateSpy).toHaveBeenCalledWith(10);
	});

	it('opens details, strips ANSI output, and navigates with buttons, keyboard, and swipe gestures', async () => {
		mockHistory([
			autoEntry(),
			entry({ id: 'user-1', summary: 'Manual deploy note', fullResponse: 'Manual full details' }),
			autoEntry({ id: 'auto-2', summary: 'Second auto', fullResponse: 'Second response' }),
		]);
		renderPanel();

		const autoCards = await screen.findAllByRole('button', { name: /AUTO entry from/i });
		fireEvent.click(autoCards[0]);
		expect(screen.getByText(/Auto full response/)).toBeInTheDocument();
		expect(screen.queryByText(/\u001b/)).not.toBeInTheDocument();
		expect(screen.getByText('95%')).toBeInTheDocument();
		expect(screen.getAllByText('1m 5s').length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText(/In:/)).toHaveTextContent(/In:\s*1,384/);
		expect(screen.getByText(/Out:/)).toHaveTextContent(/Out:\s*5,678/);
		expect(screen.getByText('1 / 3')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Previous entry' })).toBeDisabled();

		fireEvent.click(screen.getByRole('button', { name: 'Next entry' }));
		expect(screen.getByText('Manual full details')).toBeInTheDocument();
		expect(screen.getByText('2 / 3')).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'ArrowLeft' });
		expect(screen.getByText(/Auto full response/)).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'ArrowRight' });
		expect(screen.getByText('Manual full details')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Previous entry' }));
		expect(screen.getByText(/Auto full response/)).toBeInTheDocument();

		const content = screen.getByText(/Auto full response/).parentElement as HTMLElement;
		fireEvent.touchStart(content, { touches: [touch(240, 20)] });
		fireEvent.touchMove(content, {
			touches: [touch(120, 20)],
			preventDefault: vi.fn(),
		});
		fireEvent.touchEnd(content, { changedTouches: [touch(40, 20)] });
		expect(screen.getByText('Manual full details')).toBeInTheDocument();

		fireEvent.touchStart(content, { touches: [touch(40, 20)] });
		fireEvent.touchMove(content, {
			touches: [touch(140, 20)],
			preventDefault: vi.fn(),
		});
		fireEvent.touchEnd(content, { changedTouches: [touch(240, 20)] });
		expect(screen.getByText(/Auto full response/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Close detail view' }));
		expect(screen.queryByText(/Auto full response/)).not.toBeInTheDocument();
	});

	it('handles empty, no-match, and fetch-error states with real search/filter UI', async () => {
		mockHistory([entry({ id: 'user-only', summary: 'Only user entry' })]);
		const emptyView = renderPanel({
			initialFilter: 'AUTO',
		});

		expect(await screen.findByText('No history entries')).toBeInTheDocument();
		expect(screen.getByText('No AUTO entries found. Try changing the filter.')).toBeInTheDocument();
		emptyView.unmount();

		mockHistory([entry({ id: 'search-only', summary: 'Needle text' })]);
		const searchView = renderPanel({
			initialSearchOpen: true,
			initialSearchQuery: 'missing',
			onSearchChange: vi.fn(),
		});
		expect(await screen.findByText('No matching entries')).toBeInTheDocument();
		expect(screen.getByText('No entries found matching "missing".')).toBeInTheDocument();
		searchView.unmount();

		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			statusText: 'Internal Server Error',
			json: vi.fn(),
		} as unknown as Response);
		renderPanel();
		expect(
			await screen.findByText(/Failed to fetch history: Internal Server Error/)
		).toBeInTheDocument();
		expect(screen.getByText('Make sure the desktop app is running')).toBeInTheDocument();
	});

	it('closes the list and detail view through their separate Escape/Done paths', async () => {
		const onClose = vi.fn();
		mockHistory([entry({ id: 'user-1', summary: 'Closeable entry' })]);
		renderPanel({ onClose });

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(await screen.findByRole('button', { name: /USER entry from/i }));
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByText('Manual full response')).not.toBeInTheDocument();
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Close history' }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
