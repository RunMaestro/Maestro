/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * P6: the Edit Queued Message modal closes only on a save that landed, in every mode. A save that
 * did not land (the message left the queue here, or a hosted agent's host refused or failed it)
 * keeps the modal open with what the person typed and says why in the modal, never in a toast
 * that closes it. The modal saves through the same `saveQueuedItemEdit()` its two surfaces use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueuedItemEditModal } from '../../../renderer/components/QueuedItemEditModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import {
	QUEUED_EDIT_IMAGES_PENDING_REASON,
	saveQueuedItemEdit,
} from '../../../renderer/services/queuedPrompt';
import { MODAL_SAVE_CHANGED_REASON } from '../../../renderer/hooks/ui/useModalSave';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { QueuedItem } from '../../../renderer/types';
import { mockTheme } from '../../helpers/mockTheme';
import { createMockAITab } from '../../helpers/mockTab';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers/mockSession';

const SID = 'agent-1';

/** How the host answers an `edit-queued`: took it, no longer holds it, or failed with a reason. */
let hostAnswer: 'found' | 'gone' | { error: string };
const act = vi.fn(async (_peer: string, _agent: string, action: { kind: string }) => {
	if (action.kind !== 'edit-queued') return { ok: false, error: 'unexpected' };
	if (typeof hostAnswer === 'object') return { ok: false, error: hostAnswer.error };
	return { ok: true, result: { kind: 'edit-queued', found: hostAnswer === 'found' } };
});

const originalMaestro = (window as unknown as { maestro: unknown }).maestro;

beforeEach(() => {
	hostAnswer = 'found';
	act.mockClear();
	(window as unknown as { maestro: unknown }).maestro = {
		federation: { act },
		agents: {
			getModels: vi.fn(async () => []),
			getConfigOptions: vi.fn(async () => []),
			getConfig: vi.fn(async () => ({})),
			onModelsRefreshed: vi.fn(() => () => {}),
		},
	};
	useSettingsStore.setState({ federationHostedAgents: true });
	useNotificationStore.setState({ toasts: [] } as never);
});

afterEach(() => {
	cleanup();
	(window as unknown as { maestro: unknown }).maestro = originalMaestro;
	useSessionStore.setState({ sessions: [] } as never);
});

/** A queued message as each mode holds it: a hosted agent's waits on its host. */
function itemFor(mode: AgentMode, extra: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'q1',
		timestamp: 0,
		tabId: 'tab-1',
		type: 'message',
		text: 'old text',
		...(mode === 'hosted' ? { hostQueued: true } : {}),
		...extra,
	} as QueuedItem;
}

/**
 * Render the modal on an agent of `mode`. `inQueue: false` is the local version of "the host no
 * longer holds it": the message left this window's queue (it started) while the modal was open.
 */
function open(mode: AgentMode, inQueue: boolean, extra: Partial<QueuedItem> = {}) {
	const item = itemFor(mode, extra);
	useSessionStore.setState({
		sessions: [
			createModeSession(mode, {
				id: SID,
				aiTabs: [createMockAITab({ id: 'tab-1' })],
				executionQueue: inQueue || mode === 'hosted' ? [item] : [],
			}),
		],
		activeSessionId: SID,
	} as never);
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<QueuedItemEditModal
				item={item}
				theme={mockTheme}
				sessionId={SID}
				onClose={onClose}
				onSave={(patch) => saveQueuedItemEdit(SID, item.id, patch)}
			/>
		</LayerStackProvider>
	);
	const textarea = screen.getByPlaceholderText('Message to send…') as HTMLTextAreaElement;
	fireEvent.change(textarea, { target: { value: 'new text' } });
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	return { onClose, textarea };
}

/** What the person sees after the save settled. */
async function settledView(onClose: ReturnType<typeof vi.fn>, textarea: HTMLTextAreaElement) {
	await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument());
	return {
		closed: onClose.mock.calls.length > 0,
		text: textarea.value,
		reason: screen.queryByTestId('modal-save-error')?.textContent ?? null,
		toasts: useNotificationStore.getState().toasts.length,
	};
}

describe('Edit Queued Message: a save that did not land (P6)', () => {
	it('keeps the modal open with the typed text and the same reason in all three modes', async () => {
		const views = [];
		for (const mode of AGENT_MODES) {
			hostAnswer = 'gone';
			const { onClose, textarea } = open(mode, false);
			views.push(await settledView(onClose, textarea));
			cleanup();
		}
		expect(views[0]).toEqual({
			closed: false,
			text: 'new text',
			reason: 'Not saved: It no longer waits in the queue: it may have started already.',
			toasts: 0,
		});
		expect(views[1]).toEqual(views[0]);
		expect(views[2]).toEqual(views[0]);
	});

	it('shows the host failure in the modal, not a toast, and keeps the text', async () => {
		hostAnswer = { error: 'The tab is mid-turn on the host.' };
		const { onClose, textarea } = open('hosted', true);
		expect(await settledView(onClose, textarea)).toEqual({
			closed: false,
			text: 'new text',
			reason: 'Not saved: The tab is mid-turn on the host.',
			toasts: 0,
		});
	});

	it('saves again from the same modal once the host takes it', async () => {
		hostAnswer = { error: 'The host is busy.' };
		const { onClose, textarea } = open('hosted', true);
		await settledView(onClose, textarea);
		hostAnswer = 'found';
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(act).toHaveBeenLastCalledWith('box', 'h1', {
			kind: 'edit-queued',
			itemId: 'q1',
			edit: { text: 'new text', images: [], turnSettings: {} },
		});
	});
});

describe('Edit Queued Message: text typed while the save waits on the host', () => {
	it('keeps the modal open with the later text, then saves it', async () => {
		let answer!: (value: unknown) => void;
		act.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never);
		const { onClose, textarea } = open('hosted', true);
		fireEvent.change(textarea, { target: { value: 'later text' } });
		answer({ ok: true, result: { kind: 'edit-queued', found: true } });
		expect(await settledView(onClose, textarea)).toEqual({
			closed: false,
			text: 'later text',
			reason: `Not saved: ${MODAL_SAVE_CHANGED_REASON}`,
			toasts: 0,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(act).toHaveBeenLastCalledWith('box', 'h1', {
			kind: 'edit-queued',
			itemId: 'q1',
			edit: { text: 'later text', images: [], turnSettings: {} },
		});
	});
});

describe('Edit Queued Message: a save that landed (P6)', () => {
	it.each(AGENT_MODES)('%s: closes the modal and writes the edit', async (mode) => {
		const { onClose } = open(mode, true);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(screen.queryByTestId('modal-save-error')).toBeNull();
		if (mode === 'hosted') {
			expect(act).toHaveBeenCalledTimes(1);
		} else {
			expect(act).not.toHaveBeenCalled();
			const queued = useSessionStore.getState().sessions[0].executionQueue?.[0];
			expect(queued?.text).toBe('new text');
		}
	});
});

// Parity M28: an older desktop host says an item's images are unchanged (`imagesKept`) before this
// window holds them, so the card draws none. A text edit must not save the message without them.
describe('Edit Queued Message: a message whose images are not here yet (M28)', () => {
	const image = 'data:image/png;base64,AAAA';

	it.each(AGENT_MODES)('%s: a text edit keeps the message images', async (mode) => {
		const { onClose } = open(
			mode,
			true,
			mode === 'hosted' ? { hostImagesPending: true } : { images: [image] }
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		if (mode === 'hosted') {
			// No images named: the host keeps its own.
			expect(act).toHaveBeenLastCalledWith('box', 'h1', {
				kind: 'edit-queued',
				itemId: 'q1',
				edit: { text: 'new text', turnSettings: {} },
			});
		} else {
			const queued = useSessionStore.getState().sessions[0].executionQueue?.[0];
			expect(queued).toMatchObject({ text: 'new text', images: [image] });
		}
	});

	it('hosted: an edit that adds images waits until the host images are here, and says why', async () => {
		useSessionStore.setState({
			sessions: [
				createModeSession('hosted', {
					id: SID,
					aiTabs: [createMockAITab({ id: 'tab-1' })],
					executionQueue: [itemFor('hosted', { hostImagesPending: true })],
				}),
			],
			activeSessionId: SID,
		} as never);
		expect(await saveQueuedItemEdit(SID, 'q1', { text: 'new text', images: [image] })).toEqual({
			saved: false,
			reason: QUEUED_EDIT_IMAGES_PENDING_REASON,
		});
		expect(act).not.toHaveBeenCalled();
	});
});
