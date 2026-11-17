/**
 * Renderer entry points for Prompt Links: the one gate every way in uses, and
 * the refusal for a maestro://run link clicked inside Maestro.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { webDesktop, notifyToast } = vi.hoisted(() => ({
	webDesktop: { value: false },
	notifyToast: vi.fn(),
}));

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => webDesktop.value,
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast }));

import {
	isPromptLinksEnabled,
	openPromptLinks,
	promptLinksAvailable,
} from '../../../renderer/services/promptLinks';
import { openMaestroLink, MAESTRO_LINK_EVENT } from '../../../renderer/utils/openMaestroLink';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

function setEnabled(enabled: boolean) {
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, promptLinks: enabled },
	});
}

describe('Prompt Links renderer gate', () => {
	beforeEach(() => {
		webDesktop.value = false;
		notifyToast.mockClear();
		useModalStore.getState().closeModal('promptLinks');
		useSessionStore.setState({ activeSessionId: 'agent-active' });
		setEnabled(true);
	});

	it('is available only with the flag on and outside the web interface', () => {
		expect(promptLinksAvailable(true)).toBe(true);
		expect(promptLinksAvailable(false)).toBe(false);
		expect(promptLinksAvailable(undefined)).toBe(false);
		webDesktop.value = true;
		expect(promptLinksAvailable(true)).toBe(false);
	});

	it('opens the window on the active agent by default', () => {
		openPromptLinks();
		const state = useModalStore.getState();
		expect(state.isOpen('promptLinks')).toBe(true);
		expect(state.getData('promptLinks')).toEqual({ agentId: 'agent-active' });
	});

	it('keeps an explicit agent and prompt', () => {
		openPromptLinks({ agentId: 'agent-2', prompt: 'draft' });
		expect(useModalStore.getState().getData('promptLinks')).toEqual({
			agentId: 'agent-2',
			prompt: 'draft',
		});
	});

	it('does nothing while the feature is off', () => {
		setEnabled(false);
		expect(isPromptLinksEnabled()).toBe(false);
		openPromptLinks();
		expect(useModalStore.getState().isOpen('promptLinks')).toBe(false);
	});
});

describe('openMaestroLink with a Prompt Link', () => {
	it('refuses to run it in-app, says why, and dispatches nothing', () => {
		const listener = vi.fn();
		window.addEventListener(MAESTRO_LINK_EVENT, listener);
		try {
			expect(openMaestroLink('maestro://run/some-token')).toBe(true);
			expect(listener).not.toHaveBeenCalled();
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'yellow', title: expect.stringMatching(/outside/) })
			);
		} finally {
			window.removeEventListener(MAESTRO_LINK_EVENT, listener);
		}
	});

	it('still dispatches navigation links', () => {
		const listener = vi.fn();
		window.addEventListener(MAESTRO_LINK_EVENT, listener);
		try {
			expect(openMaestroLink('maestro://session/abc')).toBe(true);
			expect(listener).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener(MAESTRO_LINK_EVENT, listener);
		}
	});
});
