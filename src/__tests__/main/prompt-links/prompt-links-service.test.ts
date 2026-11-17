import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { settings, sessions, requestNewTab, safeSend } = vi.hoisted(() => ({
	settings: { encoreFeatures: { promptLinks: true } as Record<string, unknown> },
	sessions: { list: [{ id: 'agent-1', name: 'Research' }] as Array<{ id: string; name: string }> },
	requestNewTab: vi.fn(),
	safeSend: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => settings[key as keyof typeof settings] }),
	getSessionsStore: () => ({ get: () => sessions.list }),
}));

vi.mock('../../../main/utils/safe-send', () => ({
	createSafeSend: () => safeSend,
}));

vi.mock('../../../main/utils/new-ai-tab-request', () => ({
	NEW_AI_TAB_TIMEOUT_ERROR: 'Maestro desktop did not answer in time',
	NEW_AI_TAB_NO_WINDOW_ERROR: 'Maestro desktop window is not available',
	requestNewAITabWithPrompt: requestNewTab,
}));

import {
	createPromptLink,
	firePromptLink,
	listPromptLinks,
	markPromptLinksRendererReady,
	resetPromptLinksRendererReadyForTests,
	revokePromptLink,
} from '../../../main/prompt-links';
import {
	PromptLinkStore,
	setPromptLinkStoreForTests,
} from '../../../main/prompt-links/prompt-link-store';
import { parseMaestroDeepLink } from '../../../shared/deep-link-urls';

let dir: string;
const win = {
	isMinimized: vi.fn(() => false),
	restore: vi.fn(),
	show: vi.fn(),
	focus: vi.fn(),
};
const getMainWindow = () => win as unknown as Electron.BrowserWindow;

function tokenOf(url: string): string {
	return parseMaestroDeepLink(url)?.token ?? '';
}

function lastToast(): Record<string, unknown> {
	const call = safeSend.mock.calls.at(-1);
	expect(call?.[0]).toBe('remote:notifyToast');
	return call?.[1] as Record<string, unknown>;
}

let store: PromptLinkStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'prompt-links-svc-'));
	store = new PromptLinkStore(path.join(dir, 'prompt-links.json'));
	setPromptLinkStoreForTests(store);
	settings.encoreFeatures = { promptLinks: true };
	sessions.list = [{ id: 'agent-1', name: 'Research' }];
	requestNewTab.mockReset();
	safeSend.mockReset();
	win.show.mockClear();
	win.focus.mockClear();
	resetPromptLinksRendererReadyForTests();
	markPromptLinksRendererReady();
});

afterEach(async () => {
	// A fired link persists its use count without awaiting; let it land first.
	await store.flushForTests();
	setPromptLinkStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe('createPromptLink', () => {
	it('refuses while the Encore Feature is off', async () => {
		settings.encoreFeatures = { promptLinks: false };
		await expect(createPromptLink({ agentId: 'agent-1', prompt: 'x' })).rejects.toThrow(
			/turned off/
		);
	});

	it('refuses an agent that does not exist', async () => {
		await expect(createPromptLink({ agentId: 'ghost', prompt: 'x' })).rejects.toThrow(
			/Agent not found/
		);
	});

	it('lists and revokes even while the feature is off', async () => {
		const { link } = await createPromptLink({ agentId: 'agent-1', prompt: 'x' });
		settings.encoreFeatures = { promptLinks: false };
		expect(listPromptLinks()).toHaveLength(1);
		await expect(revokePromptLink(link.id)).resolves.toMatchObject({ id: link.id });
	});
});

describe('firePromptLink', () => {
	it('runs the stored prompt in a background tab and spends the link', async () => {
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'Prep me', label: 'AM' });
		requestNewTab.mockResolvedValue({ success: true, tabId: 'tab-9' });

		const result = await firePromptLink(tokenOf(url), getMainWindow);

		expect(result).toMatchObject({ ok: true, tabId: 'tab-9' });
		expect(requestNewTab).toHaveBeenCalledWith(getMainWindow, 'agent-1', 'Prep me', true);
		expect(win.show).not.toHaveBeenCalled();
		expect(lastToast()).toMatchObject({
			color: 'green',
			clickAction: { kind: 'jump-session', sessionId: 'agent-1', tabId: 'tab-9' },
		});
		expect(listPromptLinks()[0].useCount).toBe(1);

		const again = await firePromptLink(tokenOf(url), getMainWindow);
		expect(again).toMatchObject({ ok: false, reason: 'spent' });
		expect(requestNewTab).toHaveBeenCalledTimes(1);
	});

	it('brings Maestro forward for a foreground link', async () => {
		const { url } = await createPromptLink({
			agentId: 'agent-1',
			prompt: 'p',
			open: 'foreground',
		});
		requestNewTab.mockResolvedValue({ success: true, tabId: 't' });
		await firePromptLink(tokenOf(url), getMainWindow);
		expect(win.show).toHaveBeenCalled();
		expect(requestNewTab).toHaveBeenCalledWith(getMainWindow, 'agent-1', 'p', false);
	});

	it('refuses every link while the feature is off, without touching the store', async () => {
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'p' });
		settings.encoreFeatures = { promptLinks: false };
		const result = await firePromptLink(tokenOf(url), getMainWindow);
		expect(result).toMatchObject({ ok: false, reason: 'disabled' });
		expect(requestNewTab).not.toHaveBeenCalled();
		expect(listPromptLinks()[0].useCount).toBe(0);
	});

	it('refuses a forged token with a red toast', async () => {
		const result = await firePromptLink('forged-token', getMainWindow);
		expect(result).toMatchObject({ ok: false, reason: 'not-found' });
		expect(lastToast()).toMatchObject({ color: 'red', dismissible: true });
		expect(requestNewTab).not.toHaveBeenCalled();
	});

	it('keeps the use when the agent is gone', async () => {
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'p' });
		sessions.list = [];
		const result = await firePromptLink(tokenOf(url), getMainWindow);
		expect(result).toMatchObject({ ok: false, reason: 'agent-missing' });
		expect(listPromptLinks()[0].useCount).toBe(0);
	});

	it('keeps the use when the renderer refuses to open the tab', async () => {
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'p' });
		requestNewTab.mockResolvedValue({ success: false, error: 'Could not create a new AI tab' });
		const result = await firePromptLink(tokenOf(url), getMainWindow);
		expect(result).toMatchObject({ ok: false, reason: 'delivery-failed' });
		expect(listPromptLinks()[0].useCount).toBe(0);
		// The release clears the in-flight mark, so the link can be clicked again.
		requestNewTab.mockResolvedValue({ success: true, tabId: 't' });
		expect(await firePromptLink(tokenOf(url), getMainWindow)).toMatchObject({ ok: true });
	});

	it('spends the use when the renderer did not answer: the prompt may have run', async () => {
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'p' });
		requestNewTab.mockResolvedValue({
			success: false,
			error: 'Maestro desktop did not answer in time',
		});
		const result = await firePromptLink(tokenOf(url), getMainWindow);
		expect(result).toMatchObject({ ok: true, uncertain: true });
		expect(listPromptLinks()[0].useCount).toBe(1);
		expect(lastToast()).toMatchObject({ color: 'yellow' });
	});

	it('ignores a second delivery of the same URL while the first is running', async () => {
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'p', maxUses: null });
		let finish: (v: unknown) => void = () => {};
		requestNewTab.mockReturnValue(new Promise((resolve) => (finish = resolve)));

		const first = firePromptLink(tokenOf(url), getMainWindow);
		const second = await firePromptLink(tokenOf(url), getMainWindow);
		expect(second).toMatchObject({ ok: false, reason: 'in-flight' });

		finish({ success: true, tabId: 't' });
		await expect(first).resolves.toMatchObject({ ok: true });
		expect(requestNewTab).toHaveBeenCalledTimes(1);
	});

	it('waits for the renderer on a cold start, then runs', async () => {
		resetPromptLinksRendererReadyForTests();
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'p' });
		requestNewTab.mockResolvedValue({ success: true, tabId: 't' });

		const pending = firePromptLink(tokenOf(url), getMainWindow, { readyTimeoutMs: 10_000 });
		await Promise.resolve();
		expect(requestNewTab).not.toHaveBeenCalled();

		markPromptLinksRendererReady();
		await expect(pending).resolves.toMatchObject({ ok: true });
	});

	it('gives up untouched when the renderer never gets ready', async () => {
		resetPromptLinksRendererReadyForTests();
		const { url } = await createPromptLink({ agentId: 'agent-1', prompt: 'p' });
		const result = await firePromptLink(tokenOf(url), getMainWindow, { readyTimeoutMs: 5 });
		expect(result).toMatchObject({ ok: false, reason: 'not-ready' });
		expect(requestNewTab).not.toHaveBeenCalled();
		expect(listPromptLinks()[0].useCount).toBe(0);
	});
});
