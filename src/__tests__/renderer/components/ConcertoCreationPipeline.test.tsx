import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcertoCreationPipeline } from '../../../renderer/components/ConcertoCreationPipeline';
import { useConcertoCreationActivityStore } from '../../../renderer/stores/concertoCreationActivityStore';
import type { ThinkingItem } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import type { ConcertoProgressNote } from '../../../shared/movement-types';

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

function addTrack(
	movementId: string,
	title: string,
	phase: 'composing' | 'refining',
	step?: number,
	steps?: number,
	notes?: ConcertoProgressNote[]
) {
	useConcertoCreationActivityStore.getState().upsertTrack({
		sessionId: 'design-session',
		tabId: 'design-tab',
		thinkingStartTime: THINKING_START,
		movementId,
		title,
		phase,
		step,
		steps,
		notes,
	});
}

describe('ConcertoCreationPipeline', () => {
	beforeEach(() => {
		useConcertoCreationActivityStore.setState({ tracks: [] });
	});

	it('turns planned substeps into a live dotted, pitched rhythm', () => {
		addTrack('startup', 'Loopline startup', 'refining', 2, 6, [
			{ value: 'sixteenth' },
			{ value: 'sixteenth' },
			{ value: 'sixteenth', dotted: true },
			{ value: 'sixteenth', triad: true },
			{ value: 'eighth', tie: true },
			{ value: 'eighth' },
		]);
		render(
			<ConcertoCreationPipeline
				thinkingItems={[thinkingItem()]}
				theme={mockTheme}
				activeSessionId="design-session"
				activeTabId="design-tab"
			/>
		);

		const phrase = screen.getByTestId('concerto-note-startup');
		expect(screen.getByRole('list', { name: 'Concerto creation score' })).toHaveStyle({
			width: 'min(360px, calc(100% - 16px))',
		});
		expect(phrase).toHaveAttribute('data-note-value', 'mixed');
		expect(phrase).toHaveAttribute(
			'data-note-pattern',
			'sixteenth,sixteenth,sixteenth+dotted,sixteenth+triad,eighth+tie,eighth'
		);
		expect(phrase).toHaveAttribute('data-concerto-step', '2');
		expect(phrase).toHaveAccessibleName('Loopline startup: Refining, step 2 of 6');
		expect(screen.getByTestId('concerto-beam-startup-1-1')).toBeInTheDocument();
		expect(screen.getByTestId('concerto-beam-startup-1-2')).toBeInTheDocument();
		expect(screen.getAllByTestId(/^concerto-subnote-startup-/)).toHaveLength(6);
		expect(screen.getByTestId('concerto-subnote-startup-1')).toHaveAttribute(
			'data-note-state',
			'complete'
		);
		expect(screen.getByTestId('concerto-subnote-startup-2')).toHaveAttribute(
			'data-note-state',
			'active'
		);
		expect(screen.getByTestId('concerto-subnote-startup-2')).toHaveAttribute(
			'data-flashing',
			'true'
		);
		expect(screen.getByTestId('concerto-subnote-startup-2')).toHaveAttribute(
			'data-dotted',
			'false'
		);
		expect(screen.getByTestId('concerto-subnote-startup-2')).toHaveAttribute('data-pitch', 'G5');
		expect(screen.getByTestId('concerto-subnote-startup-3')).toHaveAttribute('data-dotted', 'true');
		expect(screen.getByTestId('concerto-subnote-startup-4')).toHaveAttribute('data-triad', 'true');
		expect(screen.getByTestId('concerto-subnote-startup-5')).toHaveAttribute('data-tie', 'true');
		expect(screen.getByTestId('concerto-tie-startup-5')).toBeInTheDocument();

		act(() => {
			useConcertoCreationActivityStore.getState().upsertTrack({
				sessionId: 'design-session',
				tabId: 'design-tab',
				thinkingStartTime: THINKING_START,
				movementId: 'startup',
				title: 'Loopline startup',
				phase: 'refining',
				step: 4,
				steps: 6,
			});
		});

		expect(screen.getByTestId('concerto-note-startup')).toHaveAttribute('data-concerto-step', '4');
		expect(screen.getByTestId('concerto-subnote-startup-4')).toHaveAttribute(
			'data-note-state',
			'active'
		);

		act(() => {
			useConcertoCreationActivityStore.getState().upsertTrack({
				sessionId: 'design-session',
				tabId: 'design-tab',
				thinkingStartTime: THINKING_START,
				movementId: 'startup',
				title: 'Loopline startup',
				phase: 'refining',
				step: 2,
				steps: 6,
			});
		});

		expect(screen.getByTestId('concerto-note-startup')).toHaveAttribute('data-concerto-step', '4');
	});

	it('keeps sibling Concerto phrases in separate voice lanes on one staff', () => {
		addTrack('startup', 'Loopline startup', 'composing', 1, 4);
		addTrack('runner', 'Subway runner', 'composing', 1, 4);
		addTrack('console', 'Dispatch console', 'composing', 1, 4);
		render(
			<ConcertoCreationPipeline
				thinkingItems={[thinkingItem()]}
				theme={mockTheme}
				activeSessionId="design-session"
				activeTabId="design-tab"
			/>
		);

		expect(screen.getByTestId('concerto-measure-composing').firstElementChild).toHaveStyle({
			height: '42px',
		});
		expect(screen.getByTestId('concerto-note-startup')).toHaveStyle({
			top: '0px',
			height: '14px',
		});
		expect(screen.getByTestId('concerto-note-runner')).toHaveStyle({
			top: '14px',
			height: '14px',
		});
		expect(screen.getByTestId('concerto-note-console')).toHaveStyle({
			top: '28px',
			height: '14px',
		});
	});

	it('recomposes an immediate quarter-note placeholder in place', () => {
		addTrack('startup', 'Loopline startup', 'composing');
		render(
			<ConcertoCreationPipeline
				thinkingItems={[thinkingItem()]}
				theme={mockTheme}
				activeSessionId="design-session"
				activeTabId="design-tab"
			/>
		);

		expect(screen.getByTestId('concerto-note-startup')).toHaveAttribute(
			'data-note-pattern',
			'quarter'
		);

		act(() => {
			useConcertoCreationActivityStore.getState().upsertTrack({
				sessionId: 'design-session',
				tabId: 'design-tab',
				thinkingStartTime: THINKING_START,
				movementId: 'startup',
				title: 'Loopline startup',
				phase: 'composing',
				step: 1,
				steps: 4,
				notes: [
					{ value: 'sixteenth' },
					{ value: 'sixteenth', dotted: true },
					{ value: 'sixteenth', triad: true },
					{ value: 'eighth' },
				],
			});
		});

		expect(screen.getByTestId('concerto-note-startup')).toHaveAttribute(
			'data-note-pattern',
			'sixteenth,sixteenth+dotted,sixteenth+triad,eighth'
		);
		expect(screen.getAllByTestId(/^concerto-subnote-startup-/)).toHaveLength(4);
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
