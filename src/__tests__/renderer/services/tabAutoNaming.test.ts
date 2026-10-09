/**
 * Tests for the shared tab auto-naming service.
 *
 * The naming spawn itself is covered in main/ipc/handlers/tabNaming.test.ts;
 * what matters here is the renderer-side contract every caller relies on:
 * which tabs may be named, which are left alone, and what the wizard's tabs
 * end up called. The wizard case is the reason this module exists as a
 * service - its tab is created with a placeholder name before anyone knows
 * the subject, so "has a name" is not the same question as "the user named it".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	collectNamingPrompt,
	isWizardTabAutoNameable,
	requestTabAutoName,
	requestTabAutoNameForMessage,
	requestWizardTabAutoName,
	WIZARD_TAB_NAME_PREFIX,
	WIZARD_TAB_PLACEHOLDER_NAME,
} from '../../../renderer/services/tabAutoNaming';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { createMockSession, createMockAITab } from '../../helpers';
import type { Session } from '../../../renderer/types';

const generateTabName = vi.fn<(config: unknown) => Promise<string | null>>();

function seedStore(session: Session): void {
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
}

/** Let the fire-and-forget promise chain inside the service settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	generateTabName.mockReset();
	generateTabName.mockResolvedValue('Ingest Pipeline');
	window.maestro = {
		...window.maestro,
		tabNaming: { generateTabName },
	} as typeof window.maestro;
	useSettingsStore.setState({ automaticTabNamingEnabled: true } as never);
});

describe('collectNamingPrompt', () => {
	it('joins prior messages ahead of the current one', () => {
		expect(collectNamingPrompt(['first', 'second'], 'third')).toBe('first\n\nsecond\n\nthird');
	});

	it('falls back to the current message when there is no history', () => {
		expect(collectNamingPrompt([], 'only message')).toBe('only message');
	});

	it('spends the budget on prior messages first', () => {
		// The oldest message establishes the topic; a truncated follow-up is a
		// better trade than dropping the message that says what this is about.
		const prompt = collectNamingPrompt(['a'.repeat(30)], 'b'.repeat(30), 40);
		expect(prompt).toBe(`${'a'.repeat(30)}\n\n${'b'.repeat(10)}`);
	});

	it('stops at the cap without emitting the current message', () => {
		const prompt = collectNamingPrompt(['a'.repeat(50)], 'ignored', 40);
		expect(prompt).toBe('a'.repeat(40));
	});
});

describe('requestTabAutoName', () => {
	it('names an unnamed tab from the agent response', async () => {
		const tab = createMockAITab({ id: 'tab-1', name: null });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoName({ session, tabId: tab.id, prompt: 'wire up the ingest pipeline' });
		await flush();

		expect(generateTabName).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].name).toBe('Ingest Pipeline');
		expect(useSessionStore.getState().sessions[0].aiTabs[0].isGeneratingName).toBe(false);
	});

	it('skips a tab that already has a name', () => {
		const tab = createMockAITab({ id: 'tab-1', name: 'My Tab' });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoName({ session, tabId: tab.id, prompt: 'anything' });

		expect(generateTabName).not.toHaveBeenCalled();
	});

	it('leaves the name alone when the user renames the tab mid-flight', async () => {
		const tab = createMockAITab({ id: 'tab-1', name: null });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoName({ session, tabId: tab.id, prompt: 'wire up the ingest pipeline' });
		// The user types their own name while the ephemeral namer is still running.
		useSessionStore.setState({
			sessions: [{ ...session, aiTabs: [{ ...tab, name: 'Mine', isGeneratingName: true }] }],
		});
		await flush();

		expect(useSessionStore.getState().sessions[0].aiTabs[0].name).toBe('Mine');
		// The spinner must still clear, or the tab keeps spinning forever.
		expect(useSessionStore.getState().sessions[0].aiTabs[0].isGeneratingName).toBe(false);
	});

	it('honors the automatic tab naming setting unless forced', () => {
		useSettingsStore.setState({ automaticTabNamingEnabled: false } as never);
		const tab = createMockAITab({ id: 'tab-1', name: null });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoName({ session, tabId: tab.id, prompt: 'wire up the ingest pipeline' });
		expect(generateTabName).not.toHaveBeenCalled();

		// The rename modal's "Auto" button is an explicit ask - it runs anyway.
		requestTabAutoName({
			session,
			tabId: tab.id,
			prompt: 'wire up the ingest pipeline',
			force: true,
		});
		expect(generateTabName).toHaveBeenCalledTimes(1);
	});

	it('uses the pattern match instead of spawning an agent', () => {
		const tab = createMockAITab({ id: 'tab-1', name: null });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoName({
			session,
			tabId: tab.id,
			prompt: 'look at https://github.com/RunMaestro/Maestro/pull/381',
		});

		expect(generateTabName).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].name).toBe('PR #381');
	});

	it('does not start a second namer while one is in flight', () => {
		const tab = createMockAITab({ id: 'tab-1', name: null, isGeneratingName: true });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoName({ session, tabId: tab.id, prompt: 'wire up the ingest pipeline' });

		expect(generateTabName).not.toHaveBeenCalled();
	});
});

describe('requestWizardTabAutoName', () => {
	it('replaces the placeholder with a prefixed name', async () => {
		const tab = createMockAITab({ id: 'tab-1', name: WIZARD_TAB_PLACEHOLDER_NAME });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestWizardTabAutoName(session, tab.id, 'plan the ingest pipeline rewrite');
		await flush();

		expect(useSessionStore.getState().sessions[0].aiTabs[0].name).toBe(
			`${WIZARD_TAB_NAME_PREFIX}Ingest Pipeline`
		);
	});

	it('leaves a wizard tab the user renamed alone', () => {
		const tab = createMockAITab({ id: 'tab-1', name: 'My Plan' });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestWizardTabAutoName(session, tab.id, 'plan the ingest pipeline rewrite');

		expect(generateTabName).not.toHaveBeenCalled();
	});

	it('feeds earlier wizard turns into the prompt', async () => {
		const tab = createMockAITab({ id: 'tab-1', name: WIZARD_TAB_PLACEHOLDER_NAME });
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestWizardTabAutoName(session, tab.id, 'and add retries', ['rewrite the ingest pipeline']);
		await flush();

		expect(generateTabName.mock.calls[0][0]).toMatchObject({
			userMessage: 'rewrite the ingest pipeline\n\nand add retries',
		});
	});

	it('treats the placeholder and no name as nameable, a real name as not', () => {
		expect(isWizardTabAutoNameable(createMockAITab({ name: WIZARD_TAB_PLACEHOLDER_NAME }))).toBe(
			true
		);
		expect(isWizardTabAutoNameable(createMockAITab({ name: null }))).toBe(true);
		expect(isWizardTabAutoNameable(createMockAITab({ name: 'wizard: Ingest Pipeline' }))).toBe(
			false
		);
	});
});

describe('requestTabAutoNameForMessage', () => {
	// Issue #1531: every path that hands a message to an AI tab (composer, queue
	// drain, remote dispatch) goes through this, so a tab fed only by
	// `maestro-cli dispatch` gets named the same way a typed one does.
	it('names an unnamed tab from its earlier user messages plus this one', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			name: null,
			logs: [
				{ id: 'l1', timestamp: 1, source: 'user', text: 'rewrite the ingest pipeline' },
				{ id: 'l2', timestamp: 2, source: 'stdout', text: 'sure' },
			],
		});
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoNameForMessage(session, tab.id, 'and add retries');
		await flush();

		expect(generateTabName.mock.calls[0][0]).toMatchObject({
			userMessage: 'rewrite the ingest pipeline\n\nand add retries',
		});
		expect(useSessionStore.getState().sessions[0].aiTabs[0].name).toBe('Ingest Pipeline');
	});

	it('does not feed the message twice when it is already the newest log entry', async () => {
		// The dequeue path appends the user entry before processQueuedItem runs.
		const tab = createMockAITab({
			id: 'tab-1',
			name: null,
			logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'wire up the ingest pipeline' }],
		});
		const session = createMockSession({ aiTabs: [tab], activeTabId: tab.id });
		seedStore(session);

		requestTabAutoNameForMessage(session, tab.id, 'wire up the ingest pipeline');
		await flush();

		expect(generateTabName.mock.calls[0][0]).toMatchObject({
			userMessage: 'wire up the ingest pipeline',
		});
	});

	it('leaves a named tab, an empty message, and a disabled setting alone', () => {
		const named = createMockAITab({ id: 'tab-1', name: 'My Tab' });
		const unnamed = createMockAITab({ id: 'tab-2', name: null });
		const session = createMockSession({ aiTabs: [named, unnamed], activeTabId: named.id });
		seedStore(session);

		requestTabAutoNameForMessage(session, named.id, 'anything');
		requestTabAutoNameForMessage(session, unnamed.id, '   ');
		useSettingsStore.setState({ automaticTabNamingEnabled: false } as never);
		requestTabAutoNameForMessage(session, unnamed.id, 'anything');

		expect(generateTabName).not.toHaveBeenCalled();
	});
});
