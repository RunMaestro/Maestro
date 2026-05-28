import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupChatHistoryPanel } from '../../renderer/components/GroupChatHistoryPanel';
import { useUIStore } from '../../renderer/stores/uiStore';
import type { Theme } from '../../renderer/types';
import type { GroupChatHistoryEntry } from '../../shared/group-chat-types';

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

const now = Date.UTC(2026, 0, 10, 18, 0, 0);

function entry(overrides: Partial<GroupChatHistoryEntry> = {}): GroupChatHistoryEntry {
	return {
		id: 'entry-1',
		timestamp: now - 30 * 60 * 1000,
		summary: 'Implemented **API** endpoint',
		participantName: 'Builder',
		participantColor: '#38bdf8',
		type: 'response',
		cost: 0.42,
		fullResponse: 'Detailed response mentions database migrations',
		...overrides,
	};
}

function entries(): GroupChatHistoryEntry[] {
	return [
		entry(),
		entry({
			id: 'entry-2',
			timestamp: now - 90 * 60 * 1000,
			summary: 'Delegated worker task',
			participantName: 'Moderator',
			participantColor: '#f59e0b',
			type: 'delegation',
			cost: undefined,
			fullResponse: 'Ask Builder to wire the route',
		}),
		entry({
			id: 'entry-3',
			timestamp: now - 2 * 60 * 60 * 1000,
			summary: 'Synthesized final answer',
			participantName: 'Moderator',
			participantColor: '#f59e0b',
			type: 'synthesis',
			cost: undefined,
			fullResponse: 'Final answer ready',
		}),
		entry({
			id: 'entry-4',
			timestamp: now - 3 * 60 * 60 * 1000,
			summary: 'Agent failed with timeout',
			participantName: 'Reviewer',
			participantColor: '#ef4444',
			type: 'error',
			cost: undefined,
			fullResponse: 'Timeout while checking logs',
		}),
	];
}

function renderPanel(props: Partial<React.ComponentProps<typeof GroupChatHistoryPanel>> = {}) {
	return render(
		<GroupChatHistoryPanel
			theme={theme}
			groupChatId="group-1"
			entries={entries()}
			isLoading={false}
			participantColors={{ Builder: '#22c55e', Moderator: '#f59e0b' }}
			{...props}
		/>
	);
}

describe('GroupChatHistoryPanel integration', () => {
	let originalDateNow: typeof Date.now;
	let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

	beforeEach(() => {
		originalDateNow = Date.now;
		originalScrollIntoView = Element.prototype.scrollIntoView;
		Date.now = vi.fn(() => now);
		Element.prototype.scrollIntoView = vi.fn();
		useUIStore.setState({ groupChatHistorySearchFilterOpen: false });
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		Date.now = originalDateNow;
		Element.prototype.scrollIntoView = originalScrollIntoView;
		useUIStore.setState({ groupChatHistorySearchFilterOpen: false });
		vi.clearAllMocks();
	});

	it('renders loading, empty, and markdown-stripped entry states', () => {
		const { rerender } = renderPanel({ isLoading: true });
		expect(screen.getByText('Loading history...')).toBeInTheDocument();

		rerender(
			<GroupChatHistoryPanel
				theme={theme}
				groupChatId="group-1"
				entries={[]}
				isLoading={false}
				participantColors={{}}
			/>
		);
		expect(screen.getByText(/No task history yet/)).toBeInTheDocument();
		expect(screen.getByText(/Entries will appear when agents complete tasks/)).toBeInTheDocument();

		rerender(
			<GroupChatHistoryPanel
				theme={theme}
				groupChatId="group-1"
				entries={entries()}
				isLoading={false}
				participantColors={{ Builder: '#22c55e' }}
			/>
		);
		expect(screen.getByText('Implemented API endpoint')).toBeInTheDocument();
		expect(screen.getByText('$0.42')).toBeInTheDocument();
	});

	it('persists graph lookback choices and jumps to clicked entries', async () => {
		const onJumpToMessage = vi.fn();
		renderPanel({ onJumpToMessage });

		await waitFor(() =>
			expect(window.maestro.settings.get).toHaveBeenCalledWith('groupChatHistoryLookback:group-1')
		);

		fireEvent.contextMenu(screen.getByTitle(/24 hours/), { clientX: 120, clientY: 90 });
		expect(screen.getByText('Lookback Period')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /72 hours/ }));
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'groupChatHistoryLookback:group-1',
			72
		);

		fireEvent.click(screen.getByText('Implemented API endpoint'));
		expect(onJumpToMessage).toHaveBeenCalledWith(entries()[0].timestamp);
	});

	it('combines type filters with the real UI-store search state', async () => {
		useUIStore.setState({ groupChatHistorySearchFilterOpen: true });
		renderPanel();

		await waitFor(() =>
			expect(window.maestro.settings.get).toHaveBeenCalledWith('groupChatHistoryLookback:group-1')
		);

		fireEvent.click(screen.getByRole('button', { name: /Response/ }));
		expect(screen.queryByText('Implemented API endpoint')).not.toBeInTheDocument();
		expect(screen.getByText('Delegated worker task')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Response/ }));
		fireEvent.change(screen.getByPlaceholderText('Filter group chat history...'), {
			target: { value: 'database' },
		});
		expect(screen.getByText('1 result')).toBeInTheDocument();
		expect(screen.getByText('Implemented API endpoint')).toBeInTheDocument();
		expect(screen.queryByText('Delegated worker task')).not.toBeInTheDocument();

		fireEvent.keyDown(screen.getByPlaceholderText('Filter group chat history...'), {
			key: 'Escape',
		});
		expect(screen.queryByPlaceholderText('Filter group chat history...')).not.toBeInTheDocument();
		expect(screen.getByText('Delegated worker task')).toBeInTheDocument();
	});

	it('opens search from Cmd+F and renders plural, no-result, and no-filter states', async () => {
		const { container } = renderPanel();

		await waitFor(() =>
			expect(window.maestro.settings.get).toHaveBeenCalledWith('groupChatHistoryLookback:group-1')
		);

		fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'f', metaKey: true });
		const input = await screen.findByPlaceholderText('Filter group chat history...');

		fireEvent.change(input, { target: { value: 'moderator' } });
		expect(screen.getByText('2 results')).toBeInTheDocument();
		expect(screen.getByText('Delegated worker task')).toBeInTheDocument();
		expect(screen.getByText('Synthesized final answer')).toBeInTheDocument();

		fireEvent.change(input, { target: { value: 'zzzz' } });
		expect(screen.getByText('No entries match "zzzz"')).toBeInTheDocument();

		fireEvent.keyDown(input, { key: 'Escape' });
		expect(screen.queryByPlaceholderText('Filter group chat history...')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Response/ }));
		fireEvent.click(screen.getByRole('button', { name: /Delegation/ }));
		fireEvent.click(screen.getByRole('button', { name: /Synthesis/ }));
		fireEvent.click(screen.getByRole('button', { name: /Error/ }));
		expect(screen.getByText('No entries match the selected filters.')).toBeInTheDocument();
	});

	it('covers graph hover, empty buckets, context-menu dismissal, and all-time lookback', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(null);
		const graphEntries = [
			entry({
				id: 'entry-old',
				timestamp: now - 10 * 24 * 60 * 60 * 1000,
				summary: 'Ancient response',
				participantName: 'NoColor',
				participantColor: undefined,
				type: 'response',
			}),
			...entries(),
		];
		const { container } = renderPanel({
			entries: graphEntries,
			participantColors: { Builder: '#22c55e' },
		});

		const graph = await screen.findByTitle(/All time/);
		const bars = Array.from(graph.querySelectorAll('.cursor-pointer')) as HTMLElement[];
		expect(bars.length).toBeGreaterThan(0);

		let foundEmptyBucket = false;
		for (const bar of bars) {
			fireEvent.mouseEnter(bar);
			if (screen.queryByText('No activity')) {
				foundEmptyBucket = true;
				break;
			}
			fireEvent.mouseLeave(bar);
		}
		expect(foundEmptyBucket).toBe(true);

		for (const bar of bars) {
			fireEvent.click(bar);
		}
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

		fireEvent.contextMenu(graph, { clientX: 160, clientY: 110 });
		expect(screen.getByText('Lookback Period')).toBeInTheDocument();
		fireEvent.click(document.body);
		await waitFor(() => expect(screen.queryByText('Lookback Period')).not.toBeInTheDocument());

		expect(container.textContent).toContain('Ancient response');
	});

	it('covers graph hour, week, and long-range labels with historical entries', async () => {
		const oldEntry = entry({
			id: 'entry-yesterday',
			timestamp: now - 48 * 60 * 60 * 1000,
			summary: 'Yesterday response',
			participantName: 'Builder',
			type: 'response',
		});
		renderPanel({ entries: [oldEntry, ...entries()] });

		const dayGraph = await screen.findByTitle(/24 hours/);
		const dayBars = Array.from(dayGraph.querySelectorAll('.cursor-pointer')) as HTMLElement[];
		for (const bar of dayBars) {
			fireEvent.mouseEnter(bar);
			fireEvent.mouseLeave(bar);
		}
		fireEvent.mouseEnter(dayBars[0]);
		fireEvent.mouseLeave(dayBars[0]);
		fireEvent.mouseEnter(dayBars[Math.floor(dayBars.length / 2)]);
		fireEvent.mouseLeave(dayBars[Math.floor(dayBars.length / 2)]);
		fireEvent.mouseEnter(dayBars[dayBars.length - 1]);
		expect(screen.getAllByText(/AM|PM/).length).toBeGreaterThan(0);
		expect(screen.getByText('Yesterday response')).toBeInTheDocument();

		fireEvent.contextMenu(dayGraph, { clientX: 100, clientY: 80 });
		fireEvent.click(screen.getByRole('button', { name: /1 week/ }));
		expect(screen.getByTitle(/1 week/)).toBeInTheDocument();
		expect(screen.getByText('7d')).toBeInTheDocument();

		fireEvent.contextMenu(screen.getByTitle(/1 week/), { clientX: 100, clientY: 80 });
		fireEvent.click(screen.getByRole('button', { name: /2 weeks/ }));
		expect(screen.getByTitle(/2 weeks/)).toBeInTheDocument();
	});

	it('covers saved lookback fallbacks, today timestamps, and search key guards', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(999);
		const invalidLookbackView = renderPanel();
		expect(await screen.findByTitle(/24 hours/)).toBeInTheDocument();
		invalidLookbackView.unmount();

		vi.mocked(window.maestro.settings.get).mockResolvedValue(null);
		const emptyAllTimeView = renderPanel({ entries: [] });
		const emptyAllTimeGraph = await screen.findByTitle(/All time/);
		const emptyBars = Array.from(
			emptyAllTimeGraph.querySelectorAll('.cursor-pointer')
		) as HTMLElement[];
		fireEvent.mouseEnter(emptyBars[0]);
		expect(screen.getByText('No activity')).toBeInTheDocument();
		emptyAllTimeView.unmount();

		vi.mocked(window.maestro.settings.get).mockResolvedValue(null);
		const zeroSpanView = renderPanel({
			entries: [entry({ id: 'entry-now', timestamp: now, summary: 'Zero span response' })],
		});
		expect(await screen.findByTitle(/All time/)).toBeInTheDocument();
		expect(screen.getByText('Zero span response')).toBeInTheDocument();
		zeroSpanView.unmount();

		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		const todayEntry = entry({
			id: 'entry-today',
			timestamp: new Date().getTime(),
			summary: 'Today response',
			type: 'response',
		});
		const { container } = renderPanel({ entries: [todayEntry, ...entries()] });
		expect(await screen.findByText('Today response')).toBeInTheDocument();

		fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'f', ctrlKey: true });
		const input = await screen.findByPlaceholderText('Filter group chat history...');
		fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'f', ctrlKey: true });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(screen.getByPlaceholderText('Filter group chat history...')).toBeInTheDocument();

		const graph = screen.getByTitle(/24 hours/);
		const bars = Array.from(graph.querySelectorAll('.cursor-pointer')) as HTMLElement[];
		const originalQuerySelector = Element.prototype.querySelector;
		const querySelectorSpy = vi
			.spyOn(Element.prototype, 'querySelector')
			.mockImplementation(function (selector: string) {
				if (selector.startsWith('[data-entry-id=')) return null;
				return originalQuerySelector.call(this, selector);
			});
		try {
			vi.mocked(Element.prototype.scrollIntoView).mockClear();
			for (const bar of bars) {
				fireEvent.click(bar);
			}
			expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
		} finally {
			querySelectorSpy.mockRestore();
		}
	});
});
