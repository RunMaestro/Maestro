/**
 * Tests for delivering a Design Mode pick into the agent's composer.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { appendToDraft, sendDesignPickToComposer } from '../../../renderer/services/designModePick';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';
import { createMockAITab, createMockSession } from '../../helpers';
import type { DesignModePick } from '../../../renderer/utils/designModePicker';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';

const pick: DesignModePick = {
	url: 'https://example.com',
	tagName: 'button',
	selector: 'button.primary',
	html: '<button class="primary">Save</button>',
	htmlTruncated: false,
	styles: { display: 'inline-flex' },
	rect: { x: 0, y: 0, width: 80, height: 30 },
	viewport: { width: 1280, height: 800 },
};

function seed(tabOverrides = {}) {
	const session = createMockSession({
		id: SESSION_ID,
		activeTabId: TAB_ID,
		activeBrowserTabId: 'browser-1',
		aiTabs: [createMockAITab({ id: TAB_ID, inputValue: '', stagedImages: [], ...tabOverrides })],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
	return session;
}

function tab() {
	return useSessionStore.getState().sessions[0].aiTabs[0];
}

beforeEach(() => {
	useComposerInputStore.setState({
		aiValue: '',
		aiValueTabId: null,
		aiCommandMode: 'off',
	} as never);
	useCenterFlashStore.setState({ active: null } as never);
});

describe('appendToDraft', () => {
	it('starts a blank draft with the text and separates an existing one by a blank line', () => {
		expect(appendToDraft('', 'X')).toBe('X');
		expect(appendToDraft(undefined, 'X')).toBe('X');
		expect(appendToDraft('Make this red  \n', 'X')).toBe('Make this red\n\nX');
	});
});

describe('sendDesignPickToComposer', () => {
	it('stages the screenshot, appends the prompt, and switches to the AI tab', () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'Make it pop', aiValueTabId: TAB_ID } as never);

		expect(sendDesignPickToComposer(SESSION_ID, pick, 'data:image/png;base64,AAA')).toBe(true);

		const session = useSessionStore.getState().sessions[0];
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.inputMode).toBe('ai');
		expect(tab().stagedImages).toEqual(['data:image/png;base64,AAA']);

		const composer = useComposerInputStore.getState();
		expect(composer.aiValueTabId).toBe(TAB_ID);
		expect(composer.aiValue.startsWith('Make it pop\n\nDesign Mode:')).toBe(true);
		expect(composer.aiValue).toContain('button.primary');
		expect(tab().inputValue).toBe(composer.aiValue);
	});

	it('leaves command mode, since a pick is a message for the agent', () => {
		seed({ commandMode: 'shell' });
		useComposerInputStore.setState({
			aiValue: '',
			aiValueTabId: TAB_ID,
			aiCommandMode: 'shell',
		} as never);

		sendDesignPickToComposer(SESSION_ID, pick, null);

		expect(useComposerInputStore.getState().aiCommandMode).toBe('off');
		expect(tab().commandMode).toBe('off');
		expect(tab().stagedImages).toEqual([]);
	});

	it('does not stage the same screenshot twice', () => {
		seed({ stagedImages: ['data:image/png;base64,AAA'] });
		sendDesignPickToComposer(SESSION_ID, pick, 'data:image/png;base64,AAA');
		expect(tab().stagedImages).toEqual(['data:image/png;base64,AAA']);
	});

	it('refuses when the agent has no AI tab', () => {
		seed();
		useSessionStore.setState({
			sessions: [{ ...useSessionStore.getState().sessions[0], activeTabId: 'gone' }],
		} as never);

		expect(sendDesignPickToComposer(SESSION_ID, pick, null)).toBe(false);
		expect(useCenterFlashStore.getState().active?.color).toBe('red');
	});
});
