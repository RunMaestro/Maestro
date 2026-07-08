import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { LogViewer } from '../../renderer/components/LogViewer';
import { logger } from '../../renderer/utils/logger';
import type { Theme } from '../../renderer/types';

type LogEntry = {
	timestamp: number;
	level: 'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun';
	message: string;
	context?: string;
	data?: unknown;
};

const theme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1f1f1f',
		bgActivity: '#2b2b2b',
		textMain: '#f5f5f5',
		textDim: '#a3a3a3',
		accent: '#38bdf8',
		border: '#404040',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		syntaxComment: '#737373',
		syntaxKeyword: '#c084fc',
	},
};

const baseTimestamp = Date.UTC(2026, 0, 5, 12, 0, 0);

function log(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		timestamp: baseTimestamp,
		level: 'info',
		message: 'Info log message',
		context: 'general',
		...overrides,
	};
}

function loggerBridge() {
	return window.maestro.logger as typeof window.maestro.logger & {
		getLogs: ReturnType<typeof vi.fn>;
		clearLogs: ReturnType<typeof vi.fn>;
		onNewLog: ReturnType<typeof vi.fn>;
		getMaxLogBuffer: ReturnType<typeof vi.fn>;
	};
}

function renderViewer(props: Partial<React.ComponentProps<typeof LogViewer>> = {}) {
	return render(
		<LayerStackProvider>
			<LogViewer theme={theme} onClose={vi.fn()} {...props} />
		</LayerStackProvider>
	);
}

describe('LogViewer integration', () => {
	let liveHandlers: Array<(entry: LogEntry) => void>;
	let anchorClickSpy: ReturnType<typeof vi.fn>;
	let createObjectUrlSpy: ReturnType<typeof vi.fn>;
	let revokeObjectUrlSpy: ReturnType<typeof vi.fn>;
	let scrollBySpy: ReturnType<typeof vi.fn>;
	let scrollToSpy: ReturnType<typeof vi.fn>;
	let originalCreateObjectUrl: PropertyDescriptor | undefined;
	let originalRevokeObjectUrl: PropertyDescriptor | undefined;
	let originalScrollBy: typeof HTMLElement.prototype.scrollBy;
	let originalScrollTo: typeof HTMLElement.prototype.scrollTo;

	beforeEach(() => {
		liveHandlers = [];
		anchorClickSpy = vi.fn();
		createObjectUrlSpy = vi.fn(() => 'blob:maestro-logs');
		revokeObjectUrlSpy = vi.fn();
		scrollBySpy = vi.fn();
		scrollToSpy = vi.fn();
		originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
		originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
		originalScrollBy = HTMLElement.prototype.scrollBy;
		originalScrollTo = HTMLElement.prototype.scrollTo;

		Object.assign(loggerBridge(), {
			getMaxLogBuffer: vi.fn().mockResolvedValue(2),
			getLogs: vi.fn().mockResolvedValue([
				log({ message: 'Older debug detail', level: 'debug', context: 'bootstrap' }),
				log({
					timestamp: baseTimestamp + 1,
					message: 'Build failed loudly',
					level: 'error',
					context: 'builder',
					data: { code: 'E_FAIL', nested: { retryable: false } },
				}),
				log({
					timestamp: baseTimestamp + 2,
					message: 'Auto Run completed',
					level: 'autorun',
					context: 'claude-code',
				}),
			]),
			clearLogs: vi.fn().mockResolvedValue(undefined),
			onNewLog: vi.fn((handler: (entry: LogEntry) => void) => {
				liveHandlers.push(handler);
				return vi.fn();
			}),
		});

		Object.defineProperty(URL, 'createObjectURL', {
			configurable: true,
			value: createObjectUrlSpy,
		});
		Object.defineProperty(URL, 'revokeObjectURL', {
			configurable: true,
			value: revokeObjectUrlSpy,
		});
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClickSpy);
		HTMLElement.prototype.scrollBy = scrollBySpy;
		HTMLElement.prototype.scrollTo = scrollToSpy;
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		if (originalCreateObjectUrl) {
			Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
		} else {
			delete (URL as Partial<typeof URL>).createObjectURL;
		}
		if (originalRevokeObjectUrl) {
			Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
		} else {
			delete (URL as Partial<typeof URL>).revokeObjectURL;
		}
		HTMLElement.prototype.scrollBy = originalScrollBy;
		HTMLElement.prototype.scrollTo = originalScrollTo;
		delete (
			window.maestro.logger as Partial<typeof window.maestro.logger> & Record<string, unknown>
		).getLogs;
		delete (
			window.maestro.logger as Partial<typeof window.maestro.logger> & Record<string, unknown>
		).clearLogs;
		delete (
			window.maestro.logger as Partial<typeof window.maestro.logger> & Record<string, unknown>
		).onNewLog;
	});

	it('loads, reverses, filters, searches, expands, and receives live logs', async () => {
		const onSelectedLevelsChange = vi.fn();
		renderViewer({ logLevel: 'debug', onSelectedLevelsChange });

		await waitFor(() => expect(screen.getByText('Auto Run completed')).toBeInTheDocument());
		expect(loggerBridge().getLogs).toHaveBeenCalledWith({ limit: 2 });
		expect(screen.getByText('3 entries')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'DEBUG' }));
		expect(onSelectedLevelsChange).toHaveBeenLastCalledWith(expect.not.arrayContaining(['debug']));
		expect(screen.queryByText('Older debug detail')).not.toBeInTheDocument();

		fireEvent.keyDown(screen.getByRole('dialog', { name: 'System Log Viewer' }), {
			key: 'f',
			metaKey: true,
		});
		expect(screen.getByPlaceholderText('Search logs...')).toHaveFocus();
		fireEvent.change(screen.getByPlaceholderText('Search logs...'), {
			target: { value: 'Build failed' },
		});
		expect(screen.getByText('Build failed loudly')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search logs...'), {
			target: { value: 'builder' },
		});
		expect(screen.getByText('Build failed loudly')).toBeInTheDocument();
		expect(screen.queryByText('Auto Run completed')).not.toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search logs...'), {
			target: { value: 'E_FAIL' },
		});
		fireEvent.click(screen.getByRole('button', { name: /show details/i }));
		expect(screen.getByText(/retryable/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /hide details/i }));
		expect(screen.queryByText(/retryable/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Expand all'));
		expect(screen.getByText(/retryable/)).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Collapse all'));
		expect(screen.queryByText(/retryable/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'ESC' }));
		expect(screen.queryByPlaceholderText('Search logs...')).not.toBeInTheDocument();

		act(() => {
			liveHandlers.at(-1)?.(
				log({ timestamp: baseTimestamp + 3, level: 'warn', message: 'Newest warning' })
			);
		});
		await waitFor(() => expect(screen.getByText('Newest warning')).toBeInTheDocument());
		expect(screen.queryByText('Auto Run completed')).not.toBeInTheDocument();
	});

	it('clears logs through the real confirmation modal and exports visible logs', async () => {
		renderViewer();
		await waitFor(() => expect(screen.getByText('Build failed loudly')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Export logs'));
		expect(createObjectUrlSpy).toHaveBeenCalled();
		expect(anchorClickSpy).toHaveBeenCalled();
		expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:maestro-logs');

		fireEvent.click(screen.getByTitle('Clear logs'));
		expect(
			screen.getByText(
				'Are you sure you want to clear all Maestro system logs? This action cannot be undone.'
			)
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		await waitFor(() => expect(loggerBridge().clearLogs).toHaveBeenCalled());
		expect(screen.getByText('No logs yet')).toBeInTheDocument();
	});

	it('reports clear failures without removing visible logs', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		loggerBridge().clearLogs.mockRejectedValue(new Error('clear failed'));
		renderViewer();
		await waitFor(() => expect(screen.getByText('Build failed loudly')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Clear logs'));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		await waitFor(() =>
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to clear logs:',
				undefined,
				expect.any(Error)
			)
		);
		expect(screen.getByText('Build failed loudly')).toBeInTheDocument();
	});

	it('handles logger failures and disabled level filters without crashing', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		loggerBridge().getMaxLogBuffer.mockResolvedValue(0);
		loggerBridge().getLogs.mockRejectedValue(new Error('log read failed'));

		renderViewer({ logLevel: 'warn', savedSelectedLevels: ['error', 'toast'] });

		await waitFor(() =>
			expect(loggerError).toHaveBeenCalledWith('Failed to load logs:', undefined, expect.any(Error))
		);
		expect(loggerBridge().getLogs).toHaveBeenCalledWith({ limit: 1000 });
		expect(screen.getByText('No logs yet')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'DEBUG' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'INFO' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'WARN' })).toBeEnabled();
		fireEvent.click(screen.getByRole('button', { name: 'WARN' }));
	});

	it('routes close, search, and scroll keyboard interactions through the focused dialog', async () => {
		const onClose = vi.fn();
		const onShortcutUsed = vi.fn();
		renderViewer({ onClose, onShortcutUsed });
		const dialog = screen.getByRole('dialog', { name: 'System Log Viewer' });

		await waitFor(() => expect(screen.getByText('Build failed loudly')).toBeInTheDocument());
		fireEvent.keyDown(dialog, { key: 'f', ctrlKey: true });
		expect(onShortcutUsed).toHaveBeenCalledWith('searchLogs');
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByPlaceholderText('Search logs...')).not.toBeInTheDocument()
		);
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

		fireEvent.click(screen.getByTitle(/Build failed loudly/));
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'ArrowUp' });
		fireEvent.keyDown(dialog, { key: 'ArrowUp', metaKey: true });
		fireEvent.keyDown(dialog, { key: 'ArrowDown', metaKey: true });
		fireEvent.keyDown(dialog, { key: 'ArrowUp', altKey: true });
		fireEvent.keyDown(dialog, { key: 'ArrowDown', altKey: true });
		expect(scrollBySpy).toHaveBeenCalled();
		expect(scrollToSpy).toHaveBeenCalled();

		fireEvent.click(screen.getByTitle('Close log viewer'));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('toggles all enabled filters, re-adds individual levels, and handles toast/circular data filters', async () => {
		const circularData: Record<string, unknown> = {};
		circularData.self = circularData;
		loggerBridge().getLogs.mockResolvedValue([
			log({
				level: 'toast',
				message: 'Toast with project',
				data: { project: 'Agent Builder' },
			}),
			log({
				level: 'toast',
				message: 'Toast without project',
				data: { other: true },
			}),
			log({
				level: 'info',
				message: 'Circular payload',
				context: 'circular',
				data: circularData,
			}),
		]);
		const onSelectedLevelsChange = vi.fn();
		renderViewer({ logLevel: 'debug', onSelectedLevelsChange });

		await waitFor(() => expect(screen.getByText('Toast with project')).toBeInTheDocument());
		expect(screen.getByText('Agent Builder')).toBeInTheDocument();
		expect(screen.getByText('Toast without project')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
		expect(onSelectedLevelsChange).toHaveBeenLastCalledWith([]);
		expect(screen.getByText('No logs match your filter')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
		expect(onSelectedLevelsChange).toHaveBeenLastCalledWith(
			expect.arrayContaining(['debug', 'info', 'warn', 'error', 'toast', 'autorun'])
		);
		expect(await screen.findByText('Toast with project')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'WARN' }));
		fireEvent.click(screen.getByRole('button', { name: 'WARN' }));
		expect(onSelectedLevelsChange).toHaveBeenLastCalledWith(expect.arrayContaining(['warn']));

		fireEvent.keyDown(screen.getByRole('dialog', { name: 'System Log Viewer' }), {
			key: 'f',
			metaKey: true,
		});
		fireEvent.change(screen.getByPlaceholderText('Search logs...'), {
			target: { value: 'not-present-in-circular-json' },
		});
		expect(screen.getByText('No logs match your filter')).toBeInTheDocument();
	});
});
