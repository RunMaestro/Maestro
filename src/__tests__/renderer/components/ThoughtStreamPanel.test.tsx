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
import { ThoughtStreamPanel } from '../../../renderer/components/ThoughtStreamPanel';
import { LayerStackProvider, useLayerStack } from '../../../renderer/contexts/LayerStackContext';
import { useThoughtStreamStore } from '../../../renderer/stores/thoughtStreamStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { mockTheme } from '../../helpers/mockTheme';

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
