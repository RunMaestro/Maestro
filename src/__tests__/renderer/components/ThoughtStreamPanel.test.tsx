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
import { mockTheme } from '../../helpers/mockTheme';
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

beforeEach(() => {
	cleanup();
	// The tool-call toggle persists through localStorage, which jsdom does not
	// provide here. A fresh install per test doubles as the reset.
	installLocalStorageMock();
	useThoughtStreamStore.setState({ panelSessionId: null, buffers: {} });
	useUIStore.setState({ rightPanelOpen: true });
});

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
			label: { verb: 'Ran', target: 'npm test' },
			status: 'completed',
			toolCallId: 'c1',
		});
		store.appendThought(SID, TAB, 'They passed.');
		store.openPanel(SID);
	}

	it('renders a tool call as one plain-language line', () => {
		seed();
		renderPanel();
		expect(screen.getByText('Ran npm test')).toBeInTheDocument();
	});

	it('shows a running call with a spinner and a failed one with a warning', () => {
		const store = useThoughtStreamStore.getState();
		store.appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm run build' },
			status: 'running',
			toolCallId: 'r1',
		});
		store.appendToolActivity(SID, TAB, {
			toolName: 'Edit',
			label: { verb: 'Edited', target: 'themes.ts' },
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

	it('search also matches the raw provider tool name', () => {
		// The feed renders "Ran npm test", so searching the tool the user knows
		// they configured ("Bash") has to find it anyway.
		seed();
		renderPanel();
		fireEvent.change(screen.getByPlaceholderText('Search activity...'), {
			target: { value: 'Bash' },
		});
		expect(screen.getByText('Ran npm test')).toBeInTheDocument();
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
			label: { verb: 'Ran', target: 'npm test' },
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
		expect(screen.getByText('Ran npm test')).toBeInTheDocument();
		expect(toggle()).toHaveAttribute('aria-pressed', 'true');
	});

	it('hides the tool rows when switched off, keeping the reasoning', () => {
		seedMixed();
		renderPanel();

		fireEvent.click(toggle());

		expect(screen.queryByText('Ran npm test')).not.toBeInTheDocument();
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
			label: { verb: 'Edited', target: 'themes.ts' },
			status: 'completed',
			toolCallId: 'c2',
		});
		expect(screen.queryByText('Edited themes.ts')).not.toBeInTheDocument();

		fireEvent.click(toggle());

		expect(screen.getByText('Edited themes.ts')).toBeInTheDocument();
		expect(screen.getByText('Ran npm test')).toBeInTheDocument();
	});

	it('persists the choice, so a reopened panel does not forget it', () => {
		seedMixed();
		const first = renderPanel();
		fireEvent.click(toggle());
		expect(window.localStorage.getItem(SHOW_TOOL_ACTIVITY_KEY)).toBe('false');
		first.unmount();

		renderPanel();
		expect(toggle()).toHaveAttribute('aria-pressed', 'false');
		expect(screen.queryByText('Ran npm test')).not.toBeInTheDocument();
	});

	it('says the actions are hidden rather than claiming nothing was captured', () => {
		// A run that only acted and never narrated renders an empty feed with the
		// toggle off. "Nothing captured yet" there is a flat lie about a working
		// agent, and the user has no way to tell that from an idle one.
		useThoughtStreamStore.getState().appendToolActivity(SID, TAB, {
			toolName: 'Bash',
			label: { verb: 'Ran', target: 'npm test' },
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
