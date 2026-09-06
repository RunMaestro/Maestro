/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Tests for QueuedItemEditModal keyboard handling.
 *
 * Cmd/Ctrl+Enter saves and closes from anywhere in the modal body, including
 * the textarea where plain Enter must stay a newline.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueuedItemEditModal } from '../../../renderer/components/QueuedItemEditModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';
import type { QueuedItem } from '../../../renderer/types';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

function setup(overrides: Partial<QueuedItem> = {}) {
	const item: QueuedItem = {
		id: 'q1',
		timestamp: 0,
		tabId: 'tab-1',
		type: 'message',
		text: 'a queued message',
		...overrides,
	};
	const onSave = vi.fn();
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<QueuedItemEditModal item={item} theme={mockTheme} onClose={onClose} onSave={onSave} />
		</LayerStackProvider>
	);
	return { onSave, onClose, textarea: screen.getByPlaceholderText('Message to send…') };
}

describe('QueuedItemEditModal keyboard', () => {
	it('saves and closes on Cmd+Enter from the textarea', () => {
		const { onSave, onClose, textarea } = setup();
		fireEvent.change(textarea, { target: { value: 'edited text' } });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		expect(onSave).toHaveBeenCalledWith({ text: 'edited text', images: [], turnSettings: {} });
		expect(onClose).toHaveBeenCalled();
	});

	it('saves on Ctrl+Enter for Windows and Linux', () => {
		const { onSave, textarea } = setup();
		fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(onSave).toHaveBeenCalledWith({
			text: 'a queued message',
			images: [],
			turnSettings: {},
		});
	});

	it('leaves plain Enter alone so it inserts a newline', () => {
		const { onSave, onClose, textarea } = setup();
		fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not save an empty message on Cmd+Enter', () => {
		const { onSave, onClose, textarea } = setup({ text: '' });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe('QueuedItemEditModal focus', () => {
	// Regression: Modal auto-focuses on mount inside a requestAnimationFrame, and
	// with no initialFocusRef it focuses its own overlay container. That frame
	// lands AFTER the modal body's own effect, so a locally-focused textarea was
	// silently handed back to a div one frame later and Cmd+Shift+E dropped the
	// user on a surface that swallowed every keystroke.
	it('lands focus in the textarea with the caret at the end', async () => {
		const { textarea } = setup();
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect((textarea as HTMLTextAreaElement).selectionStart).toBe('a queued message'.length);
		expect((textarea as HTMLTextAreaElement).selectionEnd).toBe('a queued message'.length);
	});
});

/**
 * Per-message model + effort override.
 *
 * Effort is provider-shaped - Claude Code exposes `effort` (thinking levels),
 * Codex exposes `reasoningEffort` - so these assert the modal offers the
 * options belonging to THAT agent's provider rather than a hardcoded list.
 */
describe('QueuedItemEditModal model + effort override', () => {
	const AGENT_OPTIONS: Record<string, { models: string[]; effort: string[]; reasoning: string[] }> =
		{
			'claude-code': {
				models: ['opus', 'sonnet'],
				effort: ['think', 'ultrathink'],
				reasoning: [],
			},
			codex: {
				models: ['gpt-5-codex'],
				effort: [],
				reasoning: ['low', 'high'],
			},
		};

	function mockAgentsApi() {
		(window as unknown as { maestro: unknown }).maestro = {
			agents: {
				getModels: vi.fn((id: string) => Promise.resolve(AGENT_OPTIONS[id]?.models ?? [])),
				getConfigOptions: vi.fn((id: string, key: string) =>
					Promise.resolve(
						key === 'effort'
							? (AGENT_OPTIONS[id]?.effort ?? [])
							: (AGENT_OPTIONS[id]?.reasoning ?? [])
					)
				),
				getConfig: vi.fn(() => Promise.resolve({})),
			},
		};
	}

	function renderWithSession(
		toolType: string,
		item: Partial<QueuedItem> = {}
	): { onSave: ReturnType<typeof vi.fn> } {
		mockAgentsApi();
		useSessionStore.setState({
			sessions: [
				{
					...createMockSession({ id: 'agent-1', toolType: toolType as never }),
					aiTabs: [{ ...createMockAITab({ id: 'tab-1' }) }],
					executionQueue: [],
				} as never,
			],
			activeSessionId: 'agent-1',
		} as never);

		const queued: QueuedItem = {
			id: 'q1',
			timestamp: 0,
			tabId: 'tab-1',
			type: 'message',
			text: 'a queued message',
			...item,
		};
		const onSave = vi.fn();
		render(
			<LayerStackProvider>
				<QueuedItemEditModal
					item={queued}
					theme={mockTheme}
					sessionId="agent-1"
					onClose={vi.fn()}
					onSave={onSave}
				/>
			</LayerStackProvider>
		);
		return { onSave };
	}

	it('offers Claude Code models and thinking levels for a claude-code agent', async () => {
		renderWithSession('claude-code');
		// The pills render once the provider probe resolves.
		await waitFor(() => expect(screen.getByTitle('Change model')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Change model'));
		expect(screen.getByText('opus')).toBeInTheDocument();
		expect(screen.getByText('sonnet')).toBeInTheDocument();
		// Codex's model must not be offered on a Claude agent.
		expect(screen.queryByText('gpt-5-codex')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Change effort level'));
		expect(screen.getByText('think')).toBeInTheDocument();
		expect(screen.getByText('ultrathink')).toBeInTheDocument();
		// Codex's reasoning efforts must not appear on a Claude agent.
		expect(screen.queryByText('high')).not.toBeInTheDocument();
	});

	it('offers Codex models and reasoning efforts for a codex agent', async () => {
		renderWithSession('codex');
		await waitFor(() => expect(screen.getByTitle('Change model')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Change model'));
		expect(screen.getByText('gpt-5-codex')).toBeInTheDocument();
		expect(screen.queryByText('opus')).not.toBeInTheDocument();

		// Codex exposes `reasoningEffort`, not `effort` - the probe has to fall
		// through to the second key or this pill would not render at all.
		fireEvent.click(screen.getByTitle('Change effort level'));
		expect(screen.getByText('high')).toBeInTheDocument();
		expect(screen.getByText('low')).toBeInTheDocument();
		// Claude's thinking levels must not appear on a Codex agent.
		expect(screen.queryByText('ultrathink')).not.toBeInTheDocument();
	});

	it('writes the picked model and effort into the saved patch', async () => {
		const { onSave } = renderWithSession('claude-code');
		await waitFor(() => expect(screen.getByTitle('Change model')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Change model'));
		fireEvent.click(screen.getByText('opus'));
		fireEvent.click(screen.getByTitle('Change effort level'));
		fireEvent.click(screen.getByText('ultrathink'));

		fireEvent.keyDown(screen.getByPlaceholderText('Message to send…'), {
			key: 'Enter',
			metaKey: true,
		});
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ turnSettings: { model: 'opus', effort: 'ultrathink' } })
		);
	});

	it('clears an override back to the agent default', async () => {
		const { onSave } = renderWithSession('claude-code', {
			turnSettings: { model: 'sonnet', effort: 'think' },
		});
		await waitFor(() => expect(screen.getByTitle('Change model')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Change model'));
		fireEvent.click(screen.getByText('(default)'));

		fireEvent.keyDown(screen.getByPlaceholderText('Message to send…'), {
			key: 'Enter',
			metaKey: true,
		});
		// `model` must be absent, not left at 'sonnet' - the whole point of the
		// patch carrying a full turnSettings object.
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ turnSettings: { model: undefined, effort: 'think' } })
		);
	});

	it('prefills from the item own capture and returns it unchanged on save', () => {
		const { onSave } = renderWithSession('claude-code', {
			turnSettings: { model: 'sonnet', effort: 'think' },
		});
		fireEvent.keyDown(screen.getByPlaceholderText('Message to send…'), {
			key: 'Enter',
			metaKey: true,
		});
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ turnSettings: { model: 'sonnet', effort: 'think' } })
		);
	});
});
