/**
 * Tests for PeerAgentComposer, the composer of a mirrored Federation agent (FED-SSH-06).
 *
 * The real `services/peerMirror` runs against a stand-in `window.maestro.federation`, so each case
 * checks the action that reaches the main-process service: a send, a Stop, nothing at all for a
 * slash command or an image. A refused send (the peer is down) is one call, a red toast, and the
 * draft kept: never queued, never retried. Nothing here may touch `sessionStore`.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationStoreModule from '../../../../renderer/stores/notificationStore';

vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => {
	const actual = await importOriginal<typeof NotificationStoreModule>();
	return { ...actual, notifyToast: vi.fn(() => 'toast-1') };
});

import { PeerAgentComposer } from '../../../../renderer/components/PeerAgentPanel/PeerAgentComposer';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { mirrorDraftKey, usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { MIRROR_COMPOSER_UNAVAILABLE } from '../../../../renderer/utils/peerMirrorView';
import type { AITabRecord } from '../../../../shared/maestro-lib/store/records';
import { resetStores } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();

function renderComposer(tab: AITabRecord = { id: 't1', name: 'First' }) {
	return render(
		<PeerAgentComposer
			theme={mockTheme}
			peerId="build"
			peerName="Build Box"
			agentId="a1"
			agentName="Builder"
			tab={tab}
		/>
	);
}

const textbox = () => screen.getByLabelText('Message Builder on Build Box') as HTMLTextAreaElement;
const draft = () => usePeerMirrorStore.getState().drafts[mirrorDraftKey('build', 'a1', 't1')];
const flush = () => act(async () => undefined);

describe('PeerAgentComposer', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore, useSettingsStore);
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		maestro.federation = { act: act$ };
		vi.mocked(notifyToast).mockClear();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('sends on Enter through the mirror service and clears the draft once the host took it', async () => {
		renderComposer();
		fireEvent.change(textbox(), { target: { value: '  hello host  ' } });
		expect(draft()).toBe('  hello host  ');
		fireEvent.keyDown(textbox(), { key: 'Enter' });
		await flush();
		expect(act$).toHaveBeenCalledTimes(1);
		expect(act$).toHaveBeenCalledWith('build', 'a1', {
			kind: 'send',
			tabId: 't1',
			text: 'hello host',
		});
		expect(draft()).toBeUndefined();
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('keeps the draft and shows an error toast when the peer is disconnected, without retrying', async () => {
		act$.mockResolvedValue({
			ok: false,
			error: 'Not connected to peer "build" (lost). Nothing was sent.',
		});
		renderComposer();
		fireEvent.change(textbox(), { target: { value: 'are you there' } });
		fireEvent.click(screen.getByTitle('Send to Builder on Build Box'));
		await flush();
		expect(act$).toHaveBeenCalledTimes(1);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'red',
				title: 'Message not sent',
				message: expect.stringContaining('Nothing was sent'),
			})
		);
		expect(draft()).toBe('are you there');
		await flush();
		expect(act$).toHaveBeenCalledTimes(1);
	});

	it('adds a newline on Shift+Enter instead of sending', async () => {
		renderComposer();
		fireEvent.change(textbox(), { target: { value: 'line one' } });
		fireEvent.keyDown(textbox(), { key: 'Enter', shiftKey: true });
		await flush();
		expect(act$).not.toHaveBeenCalled();
	});

	it('follows the tab Enter-to-send setting: Cmd+Enter sends when Enter does not', async () => {
		renderComposer({ id: 't1', enterToSend: false });
		fireEvent.change(textbox(), { target: { value: 'via chord' } });
		fireEvent.keyDown(textbox(), { key: 'Enter' });
		await flush();
		expect(act$).not.toHaveBeenCalled();
		fireEvent.keyDown(textbox(), { key: 'Enter', metaKey: true });
		await flush();
		expect(act$).toHaveBeenCalledWith('build', 'a1', {
			kind: 'send',
			tabId: 't1',
			text: 'via chord',
		});
	});

	it('refuses a slash command before anything reaches the host', async () => {
		renderComposer();
		fireEvent.change(textbox(), { target: { value: '/compact now' } });
		fireEvent.keyDown(textbox(), { key: 'Enter' });
		await flush();
		expect(act$).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: MIRROR_COMPOSER_UNAVAILABLE.slashCommands })
		);
		expect(draft()).toBe('/compact now');
	});

	it('sends a message that only starts with a path', async () => {
		renderComposer();
		fireEvent.change(textbox(), { target: { value: '/Users/me/notes.md has the plan' } });
		fireEvent.keyDown(textbox(), { key: 'Enter' });
		await flush();
		expect(act$).toHaveBeenCalledTimes(1);
	});

	it('draws slash commands, shell mode, and image attach greyed out with the reason', () => {
		renderComposer();
		const cases: Array<[string, string]> = [
			['Slash commands (not available)', MIRROR_COMPOSER_UNAVAILABLE.slashCommands],
			['Shell command mode (not available)', MIRROR_COMPOSER_UNAVAILABLE.shellMode],
			['Attach image (not available)', MIRROR_COMPOSER_UNAVAILABLE.images],
		];
		for (const [label, reason] of cases) {
			const control = screen.getByLabelText(label);
			expect(control).toHaveAttribute('aria-disabled', 'true');
			expect(control).toHaveAttribute('title', reason);
			fireEvent.click(control);
		}
		expect(act$).not.toHaveBeenCalled();
	});

	it('does not attach a pasted image', () => {
		renderComposer();
		fireEvent.paste(textbox(), {
			clipboardData: {
				items: [{ type: 'image/png' }],
				getData: () => '',
			},
		});
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: MIRROR_COMPOSER_UNAVAILABLE.images })
		);
		expect(act$).not.toHaveBeenCalled();
	});

	it('shows Stop while the tab works, stops that tab on the host, and queues a send there', async () => {
		act$.mockResolvedValue({
			ok: true,
			result: { kind: 'interrupt', targetTabIds: ['t1'], stoppedTabIds: ['t1'] },
		});
		renderComposer({ id: 't1', state: 'busy' });
		expect(screen.getByText('Working on Build Box')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Stop this turn on Build Box'));
		await flush();
		expect(act$).toHaveBeenCalledWith('build', 'a1', { kind: 'interrupt', tabId: 't1' });
		expect(
			screen.getByTitle('Queue on Build Box: the agent is busy, so the host runs it next')
		).toBeInTheDocument();
	});

	it('disables Send while the draft is empty', () => {
		renderComposer();
		expect(screen.getByTitle('Send to Builder on Build Box')).toBeDisabled();
	});
});
