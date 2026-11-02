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
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
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
	useSettingsStore.setState({ rightPanelWidth: 480 } as never);
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
		fireEvent.change(screen.getByPlaceholderText('Search thought stream...'), {
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
		fireEvent.change(screen.getByPlaceholderText('Search thought stream...'), {
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

	/** Park a note, hand it to a task, and return the ids that task took. */
	const deliver = (...texts: string[]): string[] => {
		for (const text of texts) useAutoRunSteeringStore.getState().addNote(SID, text);
		return useAutoRunSteeringStore
			.getState()
			.takeNotes(SID)
			.map((note) => note.id);
	};

	it('says the task is still working while a delivered note has no reply yet', () => {
		runFor(SID);
		deliver('already read');
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.getByTestId('steering-reply-waiting')).toHaveTextContent('still working');
		expect(screen.queryByTestId('steering-reply')).not.toBeInTheDocument();
	});

	// A spinner over a run that no longer exists would spin forever.
	it('stops claiming the task is working once the run is over', () => {
		deliver('already read');
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.getByTestId('steering-reply-waiting')).toHaveTextContent(
			'The run ended before this task replied'
		);
	});

	it('shows what the task said back, and opens to the whole reply', () => {
		runFor(SID);
		const ids = deliver('use the v3 endpoint');
		useAutoRunSteeringStore.getState().recordResponse(SID, ids, {
			summary: '[steered] Switched to v3.',
			text: '[steered] Switched to v3.\n\nSet aside the v2 instruction.',
			success: true,
		});
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		const reply = screen.getByTestId('steering-reply');
		expect(reply).toHaveTextContent('[steered] Switched to v3.');
		expect(screen.queryByTestId('steering-reply-full')).not.toBeInTheDocument();

		fireEvent.click(reply.querySelector('button')!);
		expect(screen.getByTestId('steering-reply-full')).toHaveTextContent(
			'Set aside the v2 instruction.'
		);

		fireEvent.click(reply.querySelector('button')!);
		expect(screen.queryByTestId('steering-reply-full')).not.toBeInTheDocument();
	});

	it('draws one reply under the notes a task took together', () => {
		runFor(SID);
		const ids = deliver('first', 'second');
		useAutoRunSteeringStore.getState().recordResponse(SID, ids, {
			summary: '[steered] did both',
			text: '[steered] did both',
			success: true,
		});
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.getAllByTestId('steering-note-delivered')).toHaveLength(2);
		expect(screen.getAllByTestId('steering-reply')).toHaveLength(1);
	});

	it('marks the reply of a task that failed, and offers nothing to open when there is no more', () => {
		runFor(SID);
		const ids = deliver('use the v3 endpoint');
		useAutoRunSteeringStore.getState().recordResponse(SID, ids, {
			summary: 'context limit reached',
			text: 'context limit reached',
			success: false,
		});
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		const reply = screen.getByTestId('steering-reply');
		expect(reply).toHaveTextContent('context limit reached');
		expect(screen.getByLabelText('failed')).toBeInTheDocument();
		expect(reply.querySelector('button')).toBeDisabled();
	});

	it('keeps the reply on screen after the run ends', () => {
		const ids = deliver('stop after this doc');
		useAutoRunSteeringStore.getState().recordResponse(SID, ids, {
			summary: '[steered] Halting after this document.',
			text: '[steered] Halting after this document.',
			success: true,
		});
		useThoughtStreamStore.getState().openPanel(SID);
		renderPanel();

		expect(screen.getByTestId('steering-reply')).toHaveTextContent(
			'[steered] Halting after this document.'
		);
	});

	/**
	 * The bar under the header. While a run can be steered it rests as two
	 * labelled buttons, because steering as a fourth dim icon in the header was
	 * not being found.
	 */
	describe('search / steer bar', () => {
		const SEARCH = 'Search thought stream...';
		const searchButton = () => screen.queryByTestId('thought-stream-search-open');
		const open = () => {
			useThoughtStreamStore.getState().openPanel(SID);
			return renderPanel();
		};

		it('is just the search box between runs, since there is nothing to steer', () => {
			open();

			expect(screen.getByPlaceholderText(SEARCH)).toBeInTheDocument();
			expect(searchButton()).toBeNull();
			expect(steerButton()).toBeNull();
		});

		it('rests as two labelled buttons while a run can be steered', () => {
			runFor(SID);
			open();

			expect(searchButton()).toHaveTextContent('Search thought stream');
			expect(steerButton()).toHaveTextContent('Steer Auto Run');
			expect(screen.queryByPlaceholderText(SEARCH)).not.toBeInTheDocument();
			expect(screen.queryByPlaceholderText(/Steer the Auto Run/)).not.toBeInTheDocument();
		});

		it('draws Steer at rest as a peer of Search, not highlighted', () => {
			runFor(SID);
			open();

			// A warning-filled border at rest read as an already-active control.
			expect(steerButton()).toHaveStyle({
				backgroundColor: mockTheme.colors.bgActivity,
				borderColor: mockTheme.colors.border,
				color: mockTheme.colors.textMain,
			});
		});

		it('swaps the whole bar for the search box, focused, when Search is clicked', () => {
			runFor(SID);
			open();

			fireEvent.click(searchButton()!);

			expect(screen.getByPlaceholderText(SEARCH)).toHaveFocus();
			expect(searchButton()).toBeNull();
			expect(steerButton()).toBeNull();
		});

		it('swaps the whole bar for the note box, focused, when Steer is clicked', () => {
			runFor(SID);
			open();

			fireEvent.click(steerButton()!);

			expect(screen.getByPlaceholderText(/Steer the Auto Run/)).toHaveFocus();
			expect(searchButton()).toBeNull();
		});

		it('goes back to the buttons once a note is sent', () => {
			runFor(SID);
			open();

			fireEvent.click(steerButton()!);
			fireEvent.change(screen.getByPlaceholderText(/Steer the Auto Run/), {
				target: { value: 'use the v3 endpoint' },
			});
			fireEvent.click(screen.getByTestId('thought-stream-steer-send'));

			expect(searchButton()).toBeInTheDocument();
			expect(steerButton()).toBeInTheDocument();
		});

		it('counts the notes still waiting on the Steer button', () => {
			runFor(SID);
			useAutoRunSteeringStore.getState().addNote(SID, 'first');
			useAutoRunSteeringStore.getState().addNote(SID, 'second');
			open();

			expect(screen.getByTestId('thought-stream-steer-pending-count')).toHaveTextContent('2');
		});

		// An input holding nothing must not squat on the bar and hide the other
		// button behind it.
		it('puts an empty input away when it loses focus, and keeps one holding text', () => {
			runFor(SID);
			open();

			fireEvent.click(searchButton()!);
			fireEvent.blur(screen.getByPlaceholderText(SEARCH));
			expect(searchButton()).toBeInTheDocument();

			fireEvent.click(steerButton()!);
			fireEvent.blur(screen.getByPlaceholderText(/Steer the Auto Run/));
			expect(steerButton()).toBeInTheDocument();

			fireEvent.click(steerButton()!);
			const box = screen.getByPlaceholderText(/Steer the Auto Run/);
			fireEvent.change(box, { target: { value: 'half a thought' } });
			fireEvent.blur(box);
			expect(screen.getByPlaceholderText(/Steer the Auto Run/)).toHaveValue('half a thought');
		});

		it('holds the bar in search while a filter is narrowing the feed', () => {
			runFor(SID);
			useThoughtStreamStore.getState().appendThought(SID, 'tab-a', 'reasoning about endpoints');
			open();

			fireEvent.click(searchButton()!);
			const input = screen.getByPlaceholderText(SEARCH);
			fireEvent.change(input, { target: { value: 'endpoints' } });
			fireEvent.blur(input);

			expect(screen.getByPlaceholderText(SEARCH)).toHaveValue('endpoints');
			expect(searchButton()).toBeNull();
		});

		it('Escape in the search box drops the filter and returns to the buttons', () => {
			runFor(SID);
			open();

			fireEvent.click(searchButton()!);
			const input = screen.getByPlaceholderText(SEARCH);
			fireEvent.change(input, { target: { value: 'endpoints' } });
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(searchButton()).toBeInTheDocument();
			expect(screen.getByText('Thought Stream')).toBeInTheDocument();

			// The filter went with it: reopening search starts clean.
			fireEvent.click(searchButton()!);
			expect(screen.getByPlaceholderText(SEARCH)).toHaveValue('');
		});

		it('clearing the search returns to the buttons', () => {
			runFor(SID);
			open();

			fireEvent.click(searchButton()!);
			fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value: 'endpoints' } });
			fireEvent.click(screen.getByLabelText('Clear search'));

			expect(searchButton()).toBeInTheDocument();
		});

		it('the search box offers no steer control of its own', () => {
			runFor(SID);
			open();

			fireEvent.click(searchButton()!);

			expect(screen.getByPlaceholderText(SEARCH)).toBeInTheDocument();
			expect(screen.queryByLabelText('Steer the Auto Run')).not.toBeInTheDocument();
			expect(screen.queryByTestId('thought-stream-steer-toggle')).not.toBeInTheDocument();
		});

		it('keeps a note draft across an Escape', () => {
			runFor(SID);
			open();

			fireEvent.click(steerButton()!);
			const box = screen.getByPlaceholderText(/Steer the Auto Run/);
			fireEvent.change(box, { target: { value: 'half a thought' } });
			fireEvent.keyDown(box, { key: 'Escape' });
			fireEvent.click(steerButton()!);

			expect(screen.getByPlaceholderText(/Steer the Auto Run/)).toHaveValue('half a thought');
		});

		it('shortens both labels in a narrow panel rather than truncating them', () => {
			useSettingsStore.setState({ rightPanelWidth: 320 } as never);
			runFor(SID);
			open();

			expect(searchButton()!.textContent).toBe('Search');
			expect(steerButton()!.textContent).toBe('Steer');
		});
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
