import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcertoCreationPipeline } from '../../../renderer/components/ConcertoCreationPipeline';
import { useConcertoCreationActivityStore } from '../../../renderer/stores/concertoCreationActivityStore';
import type { ThinkingItem } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

const THINKING_START = 10_000;

function pointer(type: string, clientX: number, clientY: number, pointerId = 7): MouseEvent {
	const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
	Object.defineProperty(event, 'pointerId', { value: pointerId });
	return event;
}

function enablePointerCapture(handle: HTMLElement): void {
	Object.defineProperties(handle, {
		setPointerCapture: { configurable: true, value: vi.fn() },
		releasePointerCapture: { configurable: true, value: vi.fn() },
	});
}

function thinkingItem(): ThinkingItem {
	const tab = createMockAITab({
		id: 'design-tab',
		state: 'busy',
		thinkingStartTime: THINKING_START,
	});
	return {
		session: createMockSession({
			id: 'design-session',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [tab],
			activeTabId: tab.id,
		}),
		tab,
	};
}

function addTrack(movementId: string, title: string, phase: 'composing' | 'refining') {
	useConcertoCreationActivityStore.getState().upsertTrack({
		sessionId: 'design-session',
		tabId: 'design-tab',
		thinkingStartTime: THINKING_START,
		movementId,
		title,
		phase,
	});
}

describe('ConcertoCreationPipeline', () => {
	beforeEach(() => {
		useConcertoCreationActivityStore.setState({ tracks: [] });
	});

	it('renders one shared five-measure staff with one note per Concerto', () => {
		addTrack('startup', 'Loopline startup', 'refining');
		addTrack('runner', 'Subway runner', 'composing');
		useConcertoCreationActivityStore.getState().upsertTrack({
			sessionId: 'design-session',
			tabId: 'design-tab',
			thinkingStartTime: THINKING_START - 1,
			movementId: 'stale',
			title: 'Previous turn',
			phase: 'testing',
		});

		render(
			<ConcertoCreationPipeline
				thinkingItems={[thinkingItem()]}
				theme={mockTheme}
				activeSessionId="design-session"
				activeTabId="design-tab"
			/>
		);

		const pipeline = screen.getByTestId('concerto-pipeline');
		expect(pipeline).toHaveStyle({ zIndex: 95000, right: '12px', bottom: '64px' });
		expect(pipeline).toHaveAccessibleName('Concerto creation conductor');
		expect(screen.getByText('Loopline startup')).not.toHaveClass('truncate');
		expect(screen.getByText('Subway runner')).toBeInTheDocument();
		expect(screen.queryByText('Previous turn')).not.toBeInTheDocument();

		const score = within(pipeline).getByRole('list', { name: 'Concerto creation score' });
		expect(score).toHaveStyle({ width: 'min(300px, calc(100% - 16px))' });
		expect(within(score).getAllByRole('listitem')).toHaveLength(5);
		expect(within(score).getAllByTestId(/^concerto-note-/)).toHaveLength(2);
		expect(
			within(screen.getByTestId('concerto-measure-composing')).getByTestId('concerto-note-runner')
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId('concerto-measure-refining')).getByTestId('concerto-note-startup')
		).toBeInTheDocument();
		expect(screen.getByTestId('concerto-measure-composing')).toHaveAttribute(
			'data-phase-state',
			'active'
		);
		expect(screen.getByTestId('concerto-measure-refining')).toHaveAttribute(
			'data-phase-state',
			'active'
		);
		expect(screen.getByTestId('concerto-measure-arranging')).toHaveAttribute(
			'data-phase-state',
			'pending'
		);
	});

	it('advances a single track without changing its siblings', () => {
		addTrack('startup', 'Loopline startup', 'composing');
		addTrack('runner', 'Subway runner', 'composing');
		render(
			<ConcertoCreationPipeline
				thinkingItems={[thinkingItem()]}
				theme={mockTheme}
				activeSessionId="design-session"
				activeTabId="design-tab"
			/>
		);

		act(() => {
			useConcertoCreationActivityStore.getState().upsertTrack({
				sessionId: 'design-session',
				tabId: 'design-tab',
				thinkingStartTime: THINKING_START,
				movementId: 'startup',
				title: 'Loopline startup',
				phase: 'testing',
			});
		});

		expect(screen.getByTestId('concerto-track-startup')).toHaveAttribute(
			'data-concerto-phase',
			'testing'
		);
		expect(screen.getByTestId('concerto-track-runner')).toHaveAttribute(
			'data-concerto-phase',
			'composing'
		);
		expect(
			within(screen.getByTestId('concerto-measure-testing')).getByTestId('concerto-note-startup')
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId('concerto-measure-composing')).getByTestId('concerto-note-runner')
		).toBeInTheDocument();

		act(() => {
			useConcertoCreationActivityStore.getState().upsertTrack({
				sessionId: 'design-session',
				tabId: 'design-tab',
				thinkingStartTime: THINKING_START,
				movementId: 'startup',
				title: 'Loopline startup',
				phase: 'refining',
			});
		});
		expect(screen.getByTestId('concerto-track-startup')).toHaveAttribute(
			'data-concerto-phase',
			'testing'
		);
	});

	it('moves from its bottom-right default and stays within the viewport', () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
			Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
			addTrack('startup', 'Loopline startup', 'composing');
			render(
				<ConcertoCreationPipeline
					thinkingItems={[thinkingItem()]}
					theme={mockTheme}
					activeSessionId="design-session"
					activeTabId="design-tab"
				/>
			);

			const pipeline = screen.getByTestId('concerto-pipeline');
			Object.defineProperties(pipeline, {
				offsetWidth: { configurable: true, value: 430 },
				offsetHeight: { configurable: true, value: 112 },
			});
			vi.spyOn(pipeline, 'getBoundingClientRect').mockReturnValue({
				left: 800,
				top: 600,
				right: 1230,
				bottom: 712,
				width: 430,
				height: 112,
				x: 800,
				y: 600,
				toJSON: () => ({}),
			});
			const handle = screen.getByTestId('concerto-pipeline-drag-handle');
			enablePointerCapture(handle);

			fireEvent(handle, pointer('pointerdown', 810, 610));
			fireEvent(window, pointer('pointermove', 860, 650));
			fireEvent(window, pointer('pointerup', 860, 650));

			expect(pipeline).toHaveStyle({ left: '850px', top: '640px' });
		} finally {
			Object.defineProperty(window, 'innerWidth', {
				configurable: true,
				value: originalWidth,
			});
			Object.defineProperty(window, 'innerHeight', {
				configurable: true,
				value: originalHeight,
			});
		}
	});

	it('stays hidden when no track belongs to the active busy cycle', () => {
		addTrack('startup', 'Loopline startup', 'composing');
		const { container } = render(
			<ConcertoCreationPipeline
				thinkingItems={[thinkingItem()]}
				theme={mockTheme}
				activeSessionId="another-session"
				activeTabId="design-tab"
			/>
		);

		expect(container.firstChild).toBeNull();
	});
});
