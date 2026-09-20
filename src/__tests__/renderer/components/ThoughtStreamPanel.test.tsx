/**
 * ThoughtStreamPanel tests
 *
 * The panel is a PASSIVE viewer over an ambient buffer, and both halves of that
 * matter to the user:
 * - It must not own the keyboard. It registers a layer purely so Escape closes
 *   it, and a layer that counts as "open" makes every app shortcut (Cmd+K,
 *   Opt+Cmd+T) go dead until the panel is closed. That was a real bug.
 * - Closing must not destroy anything, which is why there is no minimize: the
 *   two controls would have done the same thing.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
	ThoughtStreamPanel,
	SHOW_TOOL_ACTIVITY_KEY,
} from '../../../renderer/components/ThoughtStreamPanel';
import { LayerStackProvider, useLayerStack } from '../../../renderer/contexts/LayerStackContext';
import { useThoughtStreamStore } from '../../../renderer/stores/thoughtStreamStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useAutoRunSteeringStore } from '../../../renderer/stores/autoRunSteeringStore';
import { mockTheme } from '../../helpers/mockTheme';
import type { BatchRunState } from '../../../renderer/types';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';

// The markdown pipeline is irrelevant here and pulls in a large plugin chain.
vi.mock('../../../renderer/components/Markdown', () => ({
	Markdown: ({ content }: { content: string }) => <div data-testid="thought-md">{content}</div>,
}));

const SID = 'session-1';

/** Exposes the live layer-stack answers the keyboard handler reads. */
function LayerProbe() {
	const { hasOpenLayers, hasOpenModal, layerCount } = useLayerStack();
	return (
		<div
			data-testid="probe"
			data-blocking={String(hasOpenLayers())}
			data-modal={String(hasOpenModal())}
			data-count={String(layerCount)}
		/>
	);
}

function renderPanel() {
	return render(
		<LayerStackProvider>
			<LayerProbe />
			<ThoughtStreamPanel theme={mockTheme} />
		</LayerStackProvider>
	);
}

/**
 * Find a tool row by the whole line it reads as ("Ran npm test").
 *
 * The line is deliberately NOT one text node: the verb is prose and the target
 * is an inline-code chip, so `getByText` on the joined string finds nothing.
 * Matching on the row element's textContent keeps these assertions about what
 * the user reads rather than about how it is marked up.
 *
 * Rows are found by `data-testid`, not by their layout classes: the row was a
 * single flex line until the timestamp moved onto its own line above the
 * content, and a selector written against that layout turned a pure styling
 * change into five failures that said nothing about behaviour.
 */
function toolRow(line: string): HTMLElement | null {
	const rows = Array.from(
		document.querySelectorAll<HTMLElement>('[data-testid="thought-stream-tool-row"]')
	);
	return rows.find((row) => (row.textContent ?? '').includes(line)) ?? null;
}

beforeEach(() => {
	cleanup();
	// The tool-call toggle persists through localStorage, which jsdom does not
	// provide here. A fresh install per test doubles as the reset.
	installLocalStorageMock();
	useThoughtStreamStore.setState({ panelSessionId: null, buffers: {} });
	useUIStore.setState({ rightPanelOpen: true });
	useBatchStore.setState({ batchRunStates: {} } as never);
	useAutoRunSteeringStore.setState({ notes: {}, delivered: {} });
});

/** A run state for SID: the Steer button only exists while one is in flight. */
function runFor(sessionId: string, overrides: Partial<BatchRunState> = {}): void {
	useBatchStore.setState({
		batchRunStates: {
			[sessionId]: {
				isRunning: true,
				isStopping: false,
				documents: [],
				lockedDocuments: [],
				currentDocumentIndex: 0,
				currentDocTasksTotal: 0,
				currentDocTasksCompleted: 0,
				totalTasksAcrossAllDocs: 0,
				completedTasksAcrossAllDocs: 0,
				loopEnabled: false,
				loopIteration: 0,
				folderPath: '',
				worktreeActive: false,
				...overrides,
			},
		},
	} as never);
}

const steerButton = () => screen.queryByTestId('thought-stream-steer-toggle');

describe('ThoughtStreamPanel', () => {
	it('renders nothing until a session is focused', () => {
		renderPanel();
		expect(screen.queryByText('Thought Stream')).not.toBeInTheDocument();
	});

	it('shows the buffered thoughts an ambient capture collected before it opened', () => {
		useThoughtStreamStore.getState().appendThought(SID, 'tab-a', 'reasoning nobody watched');
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.getByText('Thought Stream')).toBeInTheDocument();
		expect(screen.getByTestId('thought-md')).toHaveTextContent('reasoning nobody watched');
	});

	// The regression: a registered layer is what the main keyboard handler reads
	// to decide whether to suppress app shortcuts. A read-only floating log has
	// no business doing that.
	it('registers a layer that does NOT block app shortcuts', () => {
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		const probe = screen.getByTestId('probe');
		// It IS stacked, so Escape still reaches it at the right priority...
		expect(probe.dataset.count).toBe('1');
		// ...but neither keyboard gate trips, so Opt+Cmd+T and Cmd+K keep working.
		expect(probe.dataset.blocking).toBe('false');
		expect(probe.dataset.modal).toBe('false');
	});

	it('has no minimize control - closing is the only dismiss', () => {
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.queryByTitle('Minimize')).not.toBeInTheDocument();
		expect(screen.getByTitle('Close (thoughts keep buffering)')).toBeInTheDocument();
	});

	it('closing hides the panel and unregisters the layer without touching the buffer', () => {
		useThoughtStreamStore.getState().appendThought(SID, 'tab-a', 'survives');
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		fireEvent.click(screen.getByTitle('Close (thoughts keep buffering)'));

		expect(screen.queryByText('Thought Stream')).not.toBeInTheDocument();
		expect(screen.getByTestId('probe').dataset.count).toBe('0');
		expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(1);
	});

	it('the trash button is the one control that discards', () => {
		useThoughtStreamStore.getState().appendThought(SID, 'tab-a', 'gone');
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		fireEvent.click(screen.getByTitle('Discard buffered thoughts'));

		expect(useThoughtStreamStore.getState().buffers[SID].entries).toHaveLength(0);
		// Still open - discarding is not dismissing.
		expect(screen.getByText('Thought Stream')).toBeInTheDocument();
	});
});

/**
 * The action feed. A tool call renders as ONE plain-language line, and it
 * renders in timeline position relative to the reasoning around it - which is
 * the whole point of the feature (spot a loop, interrupt it before it burns
 * more tokens).
 */
describe('ThoughtStreamPanel tool activity', () => {
	const TAB = 'tab-a';

	function seed() {
		const store = useThoughtStreamStore.getState();
		store.appendThought(SID, TAB, 'I should check the tests. ');
		store.appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm test', targetIsCode: true },
			status: 'completed',
			toolCallId: 'c1',
		});
		store.appendThought(SID, TAB, 'They passed.');
		store.openPanel(SID);
	}

	it('renders a tool call as one plain-language line', () => {
		seed();
		renderPanel();
		expect(toolRow('Ran npm test')).not.toBeNull();
	});

	it('shows a running call with a spinner and a failed one with a warning', () => {
		const store = useThoughtStreamStore.getState();
		store.appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm run build', targetIsCode: true },
			status: 'running',
			toolCallId: 'r1',
		});
		store.appendToolActivity(SID, TAB, {
			toolName: 'Edit',
			label: { verb: 'Edited', target: 'themes.ts', targetIsCode: true },
			status: 'failed',
			toolCallId: 'f1',
		});
		store.openPanel(SID);
		renderPanel();

		expect(screen.getByLabelText('running')).toBeInTheDocument();
		expect(screen.getByLabelText('failed')).toBeInTheDocument();
	});

	it('counts thoughts and actions separately in the header', () => {
		seed();
		renderPanel();
		// Two blocks of reasoning (the tool call split them) and one action.
		expect(screen.getByText(/2 thoughts · 1 action/)).toBeInTheDocument();
	});

	it('renders the tool call BETWEEN the reasoning it interrupted', () => {
		seed();
		const { container } = renderPanel();
		const text = container.textContent ?? '';
		// Newest-on-top display, so the later reasoning comes first.
		expect(text.indexOf('They passed.')).toBeLessThan(text.indexOf('Ran npm test'));
		expect(text.indexOf('Ran npm test')).toBeLessThan(text.indexOf('I should check the tests.'));
	});

	it('search matches the rendered line', () => {
		seed();
		renderPanel();
		fireEvent.change(screen.getByPlaceholderText('Search activity...'), {
			target: { value: 'npm test' },
		});
		expect(screen.getByText('npm test')).toBeInTheDocument();
		expect(screen.queryByText('They passed.')).not.toBeInTheDocument();
	});

	/**
	 * A command, a path, or a glob is a literal: the user reads it as code and
	 * often wants to copy it out of a wedged run. It renders in the same inline
	 * chip a markdown backtick gets in the reasoning blocks right above it. The
	 * verb is our own prose and stays out of the chip - "Ran" is not runnable.
	 */
	describe('literal targets render as inline code', () => {
		it('wraps the command in a <code> chip and leaves the verb as prose', () => {
			seed();
			renderPanel();

			const code = screen.getByText('npm test');
			expect(code.tagName).toBe('CODE');
			// The verb sits outside the chip, and the row still reads as one line.
			expect(code.textContent).toBe('npm test');
			expect(toolRow('Ran npm test')?.textContent).toContain('Ran npm test');
		});

		it('leaves a prose target unchipped', () => {
			// "Doing two (1/3)" is a sentence about progress, not something to run.
			const store = useThoughtStreamStore.getState();
			store.appendToolActivity(SID, TAB, {
				toolName: 'TodoWrite',
				label: { verb: 'Updated the task list', target: 'Doing two (1/3)', targetIsCode: false },
				status: 'completed',
				toolCallId: 't1',
			});
			store.openPanel(SID);
			renderPanel();

			// No chip anywhere, and the sentence still reads as one plain line.
			expect(document.querySelector('code')).toBeNull();
			expect(toolRow('Updated the task list Doing two (1/3)')).not.toBeNull();
		});

		it('draws no empty chip for a call with no target', () => {
			const store = useThoughtStreamStore.getState();
			store.appendToolActivity(SID, TAB, {
				toolName: 'BashOutput',
				label: { verb: 'Checked background output', target: '', targetIsCode: true },
				status: 'completed',
				toolCallId: 'b1',
			});
			store.openPanel(SID);
			renderPanel();

			expect(toolRow('Checked background output')).not.toBeNull();
			expect(document.querySelector('code')).toBeNull();
		});
	});

	it('search also matches the raw provider tool name', () => {
		// The feed renders "Ran npm test", so searching the tool the user knows
		// they configured ("Bash") has to find it anyway.
		seed();
		renderPanel();
		fireEvent.change(screen.getByPlaceholderText('Search activity...'), {
			target: { value: 'Bash' },
		});
		expect(toolRow('Ran npm test')).not.toBeNull();
	});
});

/**
 * The tool-call display toggle.
 *
 * It is a VIEW filter and nothing else - the panel's whole contract is that
 * capture is ambient, so a control that quietly stopped recording would hand
 * the user an empty history at the exact moment they went looking for it.
 */
describe('ThoughtStreamPanel tool-call toggle', () => {
	const TAB = 'tab-a';

	function seedMixed() {
		const store = useThoughtStreamStore.getState();
		store.appendThought(SID, TAB, 'I should check the tests. ');
		store.appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm test', targetIsCode: true },
			status: 'completed',
			toolCallId: 'c1',
		});
		store.appendThought(SID, TAB, 'They passed.');
		store.openPanel(SID);
	}

	const toggle = () => screen.getByTestId('thought-stream-tool-toggle');

	it('shows tool calls by default', () => {
		seedMixed();
		renderPanel();
		expect(toolRow('Ran npm test')).not.toBeNull();
		expect(toggle()).toHaveAttribute('aria-pressed', 'true');
	});

	it('hides the tool rows when switched off, keeping the reasoning', () => {
		seedMixed();
		renderPanel();

		fireEvent.click(toggle());

		expect(toolRow('Ran npm test')).toBeNull();
		expect(toggle()).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getAllByTestId('thought-md').length).toBeGreaterThan(0);
	});

	it('re-coalesces the reasoning a hidden tool call had split', () => {
		// Hiding the ROW alone would leave two mystery blocks split by an event
		// the user can no longer see. Both halves are inside the gap window, so
		// with the call filtered out they are one continuous thought again.
		seedMixed();
		renderPanel();
		expect(screen.getAllByTestId('thought-md')).toHaveLength(2);

		fireEvent.click(toggle());

		const blocks = screen.getAllByTestId('thought-md');
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toHaveTextContent('I should check the tests. They passed.');
	});

	it('keeps counting the hidden actions, and says they are hidden', () => {
		// The climbing action count is the loop signal. Turning the rows off must
		// not turn that off too.
		seedMixed();
		renderPanel();

		fireEvent.click(toggle());

		expect(screen.getByText(/1 action hidden/)).toBeInTheDocument();
	});

	it('does not stop capture: actions buffered while hidden appear on switching back', () => {
		seedMixed();
		renderPanel();
		fireEvent.click(toggle());

		useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
			toolName: 'Edit',
			label: { verb: 'Edited', target: 'themes.ts', targetIsCode: true },
			status: 'completed',
			toolCallId: 'c2',
		});
		expect(toolRow('Edited themes.ts')).toBeNull();

		fireEvent.click(toggle());

		expect(toolRow('Edited themes.ts')).not.toBeNull();
		expect(toolRow('Ran npm test')).not.toBeNull();
	});

	it('persists the choice, so a reopened panel does not forget it', () => {
		seedMixed();
		const first = renderPanel();
		fireEvent.click(toggle());
		expect(window.localStorage.getItem(SHOW_TOOL_ACTIVITY_KEY)).toBe('false');
		first.unmount();

		renderPanel();
		expect(toggle()).toHaveAttribute('aria-pressed', 'false');
		expect(toolRow('Ran npm test')).toBeNull();
	});

	it('says the actions are hidden rather than claiming nothing was captured', () => {
		// A run that only acted and never narrated renders an empty feed with the
		// toggle off. "Nothing captured yet" there is a flat lie about a working
		// agent, and the user has no way to tell that from an idle one.
		useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm test', targetIsCode: true },
			status: 'completed',
			toolCallId: 'c1',
		});
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		fireEvent.click(toggle());

		expect(screen.getByText(/1 tool call captured and hidden/)).toBeInTheDocument();
		expect(screen.queryByText(/Nothing captured yet/)).not.toBeInTheDocument();
	});
});

/**
 * Auto Run steering lives here and nowhere else.
 *
 * It used to hijack the agent's chat composer: a write-mode message typed during
 * a run silently became a note for the next task instead of a turn. A note is a
 * property of the RUN, so the gesture belongs on the run's own surface, which is
 * this panel.
 */
describe('ThoughtStreamPanel steering', () => {
	it('offers no Steer button when no run is in flight', () => {
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(steerButton()).toBeNull();
	});

	it('offers no Steer button for a run owned by another client', () => {
		// The notes are renderer state, so a mirrored run's loop would never read
		// them. A button that quietly did nothing is worse than no button.
		runFor(SID, { mirrored: true });
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(steerButton()).toBeNull();
	});

	it('parks what the operator typed and shows it as pending', () => {
		runFor(SID);
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		fireEvent.click(steerButton()!);
		const box = screen.getByPlaceholderText(/Steer the Auto Run/);
		fireEvent.change(box, { target: { value: 'use the v3 endpoint' } });
		fireEvent.click(screen.getByTestId('thought-stream-steer-send'));

		expect(useAutoRunSteeringStore.getState().notes[SID]).toHaveLength(1);
		expect(screen.getByTestId('steering-note-pending')).toHaveTextContent('use the v3 endpoint');
		// The composer closes on a successful send, so the next Enter is not a
		// second copy of the note the operator just watched land.
		expect(screen.queryByPlaceholderText(/Steer the Auto Run/)).not.toBeInTheDocument();
	});

	it('sends on Enter and keeps typing on Shift+Enter', () => {
		runFor(SID);
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		fireEvent.click(steerButton()!);
		const box = screen.getByPlaceholderText(/Steer the Auto Run/);

		fireEvent.change(box, { target: { value: 'still typing' } });
		fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
		expect(useAutoRunSteeringStore.getState().notes[SID]).toBeUndefined();

		fireEvent.keyDown(box, { key: 'Enter' });
		expect(useAutoRunSteeringStore.getState().notes[SID]).toHaveLength(1);
	});

	it('cancels a pending note from its row', () => {
		runFor(SID);
		useAutoRunSteeringStore.getState().addNote(SID, 'never mind');
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		fireEvent.click(screen.getByLabelText('Cancel steering note'));

		expect(useAutoRunSteeringStore.getState().notes[SID]).toBeUndefined();
		expect(screen.queryByTestId('steering-note-pending')).not.toBeInTheDocument();
	});

	it('keeps a delivered note visible but no longer cancellable', () => {
		runFor(SID);
		useAutoRunSteeringStore.getState().addNote(SID, 'already read');
		useAutoRunSteeringStore.getState().takeNotes(SID);
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.getByTestId('steering-note-delivered')).toHaveTextContent('already read');
		expect(screen.queryByLabelText('Cancel steering note')).not.toBeInTheDocument();
	});

	it('puts the note box away when the run ends rather than leaving a dead Send', () => {
		runFor(SID);
		useThoughtStreamStore.getState().openPanel(SID);
		const view = renderPanel();

		fireEvent.click(steerButton()!);
		expect(screen.getByPlaceholderText(/Steer the Auto Run/)).toBeInTheDocument();

		useBatchStore.setState({ batchRunStates: {} } as never);
		view.rerender(
			<LayerStackProvider>
				<LayerProbe />
				<ThoughtStreamPanel theme={mockTheme} />
			</LayerStackProvider>
		);

		expect(screen.queryByPlaceholderText(/Steer the Auto Run/)).not.toBeInTheDocument();
		expect(steerButton()).toBeNull();
	});

	it('Escape closes the note box before it closes the panel', () => {
		runFor(SID);
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		fireEvent.click(steerButton()!);
		const box = screen.getByPlaceholderText(/Steer the Auto Run/);
		fireEvent.keyDown(box, { key: 'Escape' });

		expect(screen.queryByPlaceholderText(/Steer the Auto Run/)).not.toBeInTheDocument();
		// The panel is still up: a reflex Escape while typing must not put away
		// the whole surface and the run's activity with it.
		expect(screen.getByText('Thought Stream')).toBeInTheDocument();
	});
});
