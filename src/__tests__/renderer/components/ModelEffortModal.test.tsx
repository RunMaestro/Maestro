/**
 * Tests for ModelEffortModal - the keyboard-only per-tab model/effort picker.
 *
 * The whole point of this surface is that both axes are live at once and
 * nothing is written until Enter, so these tests pin exactly that: Up/Down
 * moves the model, Left/Right moves the effort, Enter commits both to the tab,
 * and Escape-equivalent (unmount without Enter) leaves the tab untouched.
 *
 * The presentation is a wheel, not a list, so only the rows near the selection
 * are in the DOM at any moment. Tests assert on what the wheel currently shows
 * rather than on the whole catalog being present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelEffortModal } from '../../../renderer/components/ModelEffortModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useTabStore } from '../../../renderer/stores/tabStore';
import { createMockSession, createMockAITab } from '../../helpers';
import { mockTheme } from '../../helpers/mockTheme';

const MODELS = ['claude-sonnet-4.5', 'gpt-5', 'gemini-2.5-pro'];
const EFFORTS = ['', 'low', 'medium', 'high'];

function seedStore(tabOverrides: Record<string, unknown> = {}) {
	const tab = createMockAITab({ id: 'tab-1', name: 'Refactor', ...tabOverrides });
	const session = createMockSession({
		id: 'session-1',
		toolType: 'claude-code',
		aiTabs: [tab],
		activeTabId: 'tab-1',
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
	return session;
}

function renderModal(onClose = vi.fn()) {
	const result = render(
		<LayerStackProvider>
			<ModelEffortModal theme={mockTheme} tabId="tab-1" onClose={onClose} />
		</LayerStackProvider>
	);
	return { ...result, onClose };
}

/**
 * The focusable container that owns the arrow-key handling. Addressed by test
 * id rather than by label text: 'Model' now names both the wheel's axis label
 * and its keycap hint, so a text lookup is ambiguous.
 */
function keyTarget(): HTMLElement {
	return screen.getByTestId('model-effort-surface');
}

describe('ModelEffortModal', () => {
	let setTabModel: ReturnType<typeof vi.fn>;
	let setTabEffort: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		(window.maestro.agents.getModels as ReturnType<typeof vi.fn>).mockResolvedValue(MODELS);
		(window.maestro.agents.getConfigOptions as ReturnType<typeof vi.fn>).mockImplementation(
			async (_agentId: string, key: string) => (key === 'effort' ? EFFORTS : [])
		);
		(window.maestro.agents.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});

		setTabModel = vi.fn();
		setTabEffort = vi.fn();
		useTabStore.setState({ setTabModel, setTabEffort } as never);
		seedStore();
	});

	it('opens on the value the tab is currently running', async () => {
		seedStore({ customModel: 'gpt-5', customEffort: 'high' });
		const { onClose } = renderModal();

		await screen.findByText('gpt-5');
		// Committing without moving must re-apply exactly what was already set.
		fireEvent.keyDown(keyTarget(), { key: 'Enter' });

		expect(setTabModel).toHaveBeenCalledWith('tab-1', 'gpt-5');
		expect(setTabEffort).toHaveBeenCalledWith('tab-1', 'high');
		expect(onClose).toHaveBeenCalled();
	});

	it('moves the model with Up/Down and the effort with Left/Right, committing both on Enter', async () => {
		renderModal();
		await screen.findByText('claude-sonnet-4.5');

		// Selection starts on '(default)' (index 0); one Down lands on the first model.
		fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowRight' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowRight' });
		fireEvent.keyDown(keyTarget(), { key: 'Enter' });

		expect(setTabModel).toHaveBeenCalledWith('tab-1', 'gpt-5');
		expect(setTabEffort).toHaveBeenCalledWith('tab-1', 'medium');
	});

	it('writes nothing until Enter', async () => {
		renderModal();
		await screen.findByText('claude-sonnet-4.5');

		fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowRight' });

		expect(setTabModel).not.toHaveBeenCalled();
		expect(setTabEffort).not.toHaveBeenCalled();
	});

	it('wraps at both ends of each axis', async () => {
		renderModal();
		await screen.findByText('claude-sonnet-4.5');

		// Up from '(default)' wraps to the last model; Left from '(default)' wraps
		// to the highest effort.
		fireEvent.keyDown(keyTarget(), { key: 'ArrowUp' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowLeft' });
		fireEvent.keyDown(keyTarget(), { key: 'Enter' });

		expect(setTabModel).toHaveBeenCalledWith('tab-1', 'gemini-2.5-pro');
		expect(setTabEffort).toHaveBeenCalledWith('tab-1', 'high');
	});

	it('clears the override when the (default) row is committed', async () => {
		seedStore({ customModel: 'gpt-5', customEffort: 'high' });
		renderModal();
		await screen.findByText('gpt-5');

		// gpt-5 sits at index 2; two Ups return to '(default)'.
		fireEvent.keyDown(keyTarget(), { key: 'ArrowUp' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowUp' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowLeft' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowLeft' });
		fireEvent.keyDown(keyTarget(), { key: 'ArrowLeft' });
		fireEvent.keyDown(keyTarget(), { key: 'Enter' });

		expect(setTabModel).toHaveBeenCalledWith('tab-1', undefined);
		expect(setTabEffort).toHaveBeenCalledWith('tab-1', undefined);
	});

	it('names the vendor of whichever model the wheel is on', async () => {
		// A wheel has no room for group headers, so the family travels with the
		// selection instead. Walking the catalog must re-label as it goes.
		renderModal();
		await screen.findByText('claude-sonnet-4.5');

		fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
		expect(screen.getByText('Claude')).toBeInTheDocument();

		fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
		expect(screen.getByText('OpenAI')).toBeInTheDocument();

		fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
		expect(screen.getByText('Gemini')).toBeInTheDocument();
	});

	it('spells out what the (default) row resolves to', async () => {
		// '(default)' alone says nothing about what will actually run; the caption
		// is the only place the agent-level model is named.
		(window.maestro.agents.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
			model: 'claude-sonnet-4.5',
		});
		renderModal();
		// With an agent-level default set, the wheel opens on the resolved model,
		// so reaching the '(default)' row takes one step up.
		await screen.findByText('claude-sonnet-4.5');
		fireEvent.keyDown(keyTarget(), { key: 'ArrowUp' });

		expect(screen.getByText('Agent default - claude-sonnet-4.5')).toBeInTheDocument();
	});

	it('keeps the wrapped-around neighbour on the wheel', async () => {
		// The row above '(default)' is the LAST model, not empty space - that is
		// what makes Up-from-the-top feel continuous rather than blocked.
		renderModal();
		await screen.findByText('claude-sonnet-4.5');

		expect(screen.getByText('gemini-2.5-pro')).toBeInTheDocument();
	});

	it('says so when the agent exposes neither knob, but not before the lookups settle', async () => {
		let releaseModels: (models: string[]) => void = () => {};
		(window.maestro.agents.getModels as ReturnType<typeof vi.fn>).mockReturnValue(
			new Promise<string[]>((resolve) => {
				releaseModels = resolve;
			})
		);
		(window.maestro.agents.getConfigOptions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		renderModal();

		// An empty list mid-flight must not be reported as "no options" - that
		// would flash a wrong answer at every open.
		expect(screen.queryByText(/no model or effort options/i)).not.toBeInTheDocument();
		expect(screen.getByText(/loading options/i)).toBeInTheDocument();

		releaseModels([]);
		await waitFor(() => {
			expect(screen.getByText(/no model or effort options/i)).toBeInTheDocument();
		});
	});

	it('re-applies the current value when Enter lands before the lists load', async () => {
		let releaseModels: (models: string[]) => void = () => {};
		(window.maestro.agents.getModels as ReturnType<typeof vi.fn>).mockReturnValue(
			new Promise<string[]>((resolve) => {
				releaseModels = resolve;
			})
		);
		seedStore({ customModel: 'gpt-5', customEffort: 'high' });
		renderModal();

		// The selection is derived from the tab, not seeded by an effect, so an
		// Enter this early re-applies what the tab already runs rather than
		// clearing the override.
		fireEvent.keyDown(screen.getByText(/loading options/i).closest('[tabindex]') as HTMLElement, {
			key: 'Enter',
		});

		expect(setTabModel).toHaveBeenCalledWith('tab-1', 'gpt-5');
		releaseModels(MODELS);
		await waitFor(() => expect(screen.getByText('gpt-5')).toBeInTheDocument());
	});

	it('applies and cancels from the keycap hints, for pointer-only users', async () => {
		// Escape and Enter are unavailable over remote desktop and on tablets, so
		// the legend has to be the control rather than a caption describing one.
		seedStore({ customModel: 'gpt-5', customEffort: 'high' });
		const { onClose } = renderModal();
		await screen.findByText('gpt-5');

		fireEvent.click(screen.getByTestId('model-effort-apply'));
		expect(setTabModel).toHaveBeenCalledWith('tab-1', 'gpt-5');
		expect(onClose).toHaveBeenCalled();
	});

	it('cancels without writing when the cancel hint is clicked', async () => {
		const { onClose } = renderModal();
		await screen.findByText('claude-sonnet-4.5');

		fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
		fireEvent.click(screen.getByTestId('model-effort-cancel'));

		expect(setTabModel).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it('sinks the matching keycap while a key is firing, then releases it', async () => {
		vi.useFakeTimers();
		try {
			renderModal();
			// findBy* needs real timers; the list is already resolved by the time
			// the arrow fires, so pump the microtask queue instead.
			await vi.advanceTimersByTimeAsync(0);

			fireEvent.keyDown(keyTarget(), { key: 'ArrowDown' });
			expect(screen.getByText('↓')).toHaveAttribute('data-pressed', 'true');

			// A held key repeats without ever sending keyup, so the cap has to
			// release on a timer or it stays stuck down.
			await vi.advanceTimersByTimeAsync(200);
			expect(screen.getByText('↓')).not.toHaveAttribute('data-pressed');
		} finally {
			vi.useRealTimers();
		}
	});

	it('closes when the scrim behind the composition is clicked', async () => {
		const { onClose } = renderModal();
		await screen.findByText('claude-sonnet-4.5');

		fireEvent.mouseDown(screen.getByTestId('model-effort-modal'));
		expect(onClose).toHaveBeenCalled();
	});

	it('does not close when the composition itself is clicked', async () => {
		const { onClose } = renderModal();
		await screen.findByText('claude-sonnet-4.5');

		fireEvent.mouseDown(keyTarget());
		expect(onClose).not.toHaveBeenCalled();
	});
});
