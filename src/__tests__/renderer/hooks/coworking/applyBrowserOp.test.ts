import { createElement, useState } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	applyBrowserOp,
	resolveAndRun,
	useCoworkingBrowserResponder,
	type BrowserApprovalRequester,
} from '../../../../renderer/hooks/coworking/useCoworkingBrowserResponder';
import type { BrowserTabViewHandle } from '../../../../renderer/components/MainPanel/BrowserTabView';
import {
	selectActiveSession,
	selectSessionById,
	updateBrowserTab,
	useSessionStore,
} from '../../../../renderer/stores/sessionStore';
import type { SessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';
import type { BrowserTab } from '../../../../shared/browserPage';
import type { BrowserViewportPreset } from '../../../../shared/browserViewport';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import {
	useCoworkingBrowserKeepAliveStore,
	activePinnedTabIds,
} from '../../../../renderer/stores/coworkingBrowserKeepAliveStore';

import type { BrowserOp } from '../../../../shared/coworkingBrowser';
import type { CoworkingApi } from '../../../../main/preload/coworking';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useCoworkingApprovalStore } from '../../../../renderer/stores/coworkingApprovalStore';

beforeEach(() => {
	useSettingsStore.setState({
		coworkingBrowserInteraction: ['claude-code'],
		coworkingBrowserInteractionConfirm: {},
	});
});

vi.mock('../../../../renderer/services/designModePick', () => ({
	deliverDesignPick: vi.fn(async () => ({
		aiTabId: 'ai-1',
		text: 'ELEMENT BLOCK',
		pickId: 'pick-1',
	})),
	// Takes the delivery so a test can read what it was asked to queue.
	queueDesignPick: vi.fn(async (_delivery: unknown) => ({
		aiTabId: 'ai-1',
		tabName: 'Fix the header',
		queueItemId: 'queue-1',
		text: 'QUEUED BLOCK',
	})),
}));
import { deliverDesignPick, queueDesignPick } from '../../../../renderer/services/designModePick';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: { getState: vi.fn(() => ({})) },
	selectActiveSession: vi.fn(),
	updateBrowserTab: vi.fn(),
	selectSessionById: vi.fn(() => () => ({
		id: 'sess-A',
		toolType: 'claude-code',
		activeBrowserTabId: null,
		// The execution-boundary re-check consults browserTabs; keep the suite's
		// cross-session target visible by default.
		browserTabs: [{ id: 'u-1' }],
	})),
}));

/** resolveAndRun reads id, activeBrowserTabId, toolType and (for the
 *  execution-boundary tab re-check) browserTabs. Every tab uuid this suite
 *  drives is live and visible by default; tests for the boundary check pass
 *  their own list. */
function fakeActive(
	id: string,
	activeBrowserTabId: string | null,
	browserTabs: Array<Partial<BrowserTab>> = [
		{ id: 'u-1' },
		{ id: 'u-2' },
		{ id: 'u-3' },
		{ id: 'u-9' },
	]
): Session {
	return { id, activeBrowserTabId, toolType: 'claude-code', browserTabs } as unknown as Session;
}

function makeHandle(overrides: Partial<BrowserTabViewHandle> = {}): BrowserTabViewHandle {
	return {
		getContent: vi.fn(async () => ''),
		getTabId: vi.fn(() => 'tab-1'),
		openFind: vi.fn(),
		goBack: vi.fn(),
		goForward: vi.fn(),
		focusWebview: vi.fn(),
		extract: vi.fn(async () => ''),
		getMeta: vi.fn(() => ({ url: 'https://e', title: 'E' })),
		navigate: vi.fn(() => 'https://e'),
		reload: vi.fn(),
		stop: vi.fn(),
		executeJavaScript: vi.fn(async () => undefined),
		capturePage: vi.fn(async () => 'data:image/png;base64,AAAA'),
		toggleDesignMode: vi.fn(),
		inspectElement: vi.fn(async () => null),
		inspectRegion: vi.fn(async () => null),
		...overrides,
	};
}

describe('applyBrowserOp', () => {
	it('read returns the extracted content plus url/title meta', async () => {
		const extract = vi.fn(async () => 'PAGE');
		const handle = makeHandle({ extract, getMeta: () => ({ url: 'https://x', title: 'X' }) });
		const res = await applyBrowserOp(handle, { kind: 'read', format: 'text' });
		expect(extract).toHaveBeenCalledWith('text');
		expect(res).toEqual({ ok: true, content: 'PAGE', url: 'https://x', title: 'X' });
	});

	it('navigate resolves the url through the handle', async () => {
		const navigate = vi.fn(() => 'https://resolved');
		const res = await applyBrowserOp(makeHandle({ navigate }), {
			kind: 'navigate',
			url: 'resolved',
		});
		expect(navigate).toHaveBeenCalledWith('resolved');
		expect(res.ok).toBe(true);
		expect(res.url).toBe('https://resolved');
	});

	it('back/forward/reload/stop invoke the matching handle methods', async () => {
		const goBack = vi.fn();
		const goForward = vi.fn();
		const reload = vi.fn();
		const stop = vi.fn();
		const handle = makeHandle({ goBack, goForward, reload, stop });
		expect((await applyBrowserOp(handle, { kind: 'back' })).ok).toBe(true);
		expect((await applyBrowserOp(handle, { kind: 'forward' })).ok).toBe(true);
		expect((await applyBrowserOp(handle, { kind: 'reload' })).ok).toBe(true);
		expect((await applyBrowserOp(handle, { kind: 'stop' })).ok).toBe(true);
		expect(goBack).toHaveBeenCalled();
		expect(goForward).toHaveBeenCalled();
		expect(reload).toHaveBeenCalled();
		expect(stop).toHaveBeenCalled();
	});

	it('click returns ok and JSON-escapes the selector into the page script', async () => {
		const executeJavaScript = vi.fn(async () => 'ok');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'click',
			selector: '#go',
		});
		expect(res.ok).toBe(true);
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('"#go"');
	});

	it('click returns ok:false when no element matches', async () => {
		const executeJavaScript = vi.fn(async () => 'notfound');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'click',
			selector: '#missing',
		});
		expect(res.ok).toBe(false);
	});

	it('type injects the selector and text (JSON-escaped) and reports success', async () => {
		const executeJavaScript = vi.fn(async () => 'ok');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'type',
			selector: '#in',
			text: 'hi "there"',
		});
		expect(res.ok).toBe(true);
		const js = String(executeJavaScript.mock.calls[0][0]);
		expect(js).toContain('"#in"');
		expect(js).toContain(JSON.stringify('hi "there"'));
	});

	it.each(['input', 'textarea'] as const)(
		'types into a controlled React %s and submits via the click op',
		async (tag) => {
			const submitted = vi.fn();
			function Form() {
				const [value, setValue] = useState('');
				return createElement(
					'form',
					{
						onSubmit: (event) => {
							event.preventDefault();
							submitted(value);
						},
					},
					createElement(tag, {
						id: 'controlled',
						value,
						onChange: (event) => setValue(event.currentTarget.value),
					}),
					createElement('button', { type: 'submit', disabled: !value }, 'Submit')
				);
			}
			render(createElement(Form));
			const handle = makeHandle({ executeJavaScript: async (script) => window.eval(script) });
			const button = screen.getByRole('button', { name: 'Submit' });
			const text = 'Text with "quotes" and \\slashes';
			expect(button).toBeDisabled();

			await act(async () => {
				expect(
					await applyBrowserOp(handle, { kind: 'type', selector: '#controlled', text })
				).toMatchObject({ ok: true });
			});
			expect(screen.getByRole('textbox')).toHaveValue(text);
			expect(button).toBeEnabled();

			await act(async () => {
				expect(await applyBrowserOp(handle, { kind: 'click', selector: 'button' })).toMatchObject({
					ok: true,
				});
			});
			expect(submitted).toHaveBeenCalledExactlyOnceWith(text);
		}
	);

	it.each(['input', 'textarea', 'div'] as const)(
		'preserves the existing text, focus, and event behavior for a plain %s',
		async (tag) => {
			const { container } = render(
				createElement(tag, { id: 'plain', contentEditable: tag === 'div' })
			);
			const field = container.querySelector(tag)!;
			const events: string[] = [];
			for (const event of ['input', 'change']) {
				container.addEventListener(event, (event) => events.push(event.type));
			}
			const handle = makeHandle({ executeJavaScript: async (script) => window.eval(script) });

			expect(
				await applyBrowserOp(handle, { kind: 'type', selector: '#plain', text: 'Updated' })
			).toMatchObject({ ok: true });
			if (tag === 'div') {
				expect(field).toHaveTextContent('Updated');
				expect(events).toEqual([]);
			} else {
				expect(field).toHaveFocus();
				expect(field).toHaveValue('Updated');
				expect(events).toEqual(['input', 'change']);
			}
		}
	);

	it('eval stringifies a non-string result', async () => {
		const executeJavaScript = vi.fn(async () => ({ a: 1 }));
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'eval',
			code: '({a:1})',
		});
		expect(res.ok).toBe(true);
		expect(res.content).toBe(JSON.stringify({ a: 1 }));
	});

	it('screenshot returns the captured data url', async () => {
		const pngUrl = 'data:image/png;base64,' + 'A'.repeat(120);
		const capturePage = vi.fn(async () => pngUrl);
		const res = await applyBrowserOp(makeHandle({ capturePage }), { kind: 'screenshot' });
		expect(res.ok).toBe(true);
		expect(res.dataUrl).toBe(pngUrl);
	});

	it('screenshot returns ok:false when the capture produced no frame', async () => {
		// capturePage() now force-paints even a hidden/backgrounded tab, so a
		// blank/too-short result means the guest genuinely produced no frame - not
		// that the tab was hidden. The host still refuses to hand back an empty image.
		const capturePage = vi.fn(async () => '');
		const res = await applyBrowserOp(makeHandle({ capturePage }), { kind: 'screenshot' });
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/did not produce a frame/i);
	});

	it('waitFor returns ok when the selector appears on the first probe', async () => {
		const executeJavaScript = vi.fn(async () => true);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'waitFor',
			selector: '#late',
		});
		expect(res.ok).toBe(true);
		expect(String(res.content)).toMatch(/appeared/i);
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('"#late"');
	});

	it('waitFor keeps polling until the selector appears', async () => {
		const executeJavaScript = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'waitFor',
			selector: '#late',
			timeoutMs: 5000,
		});
		expect(res.ok).toBe(true);
		expect(executeJavaScript.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('waitFor returns ok:false when the timeout elapses without a match', async () => {
		const executeJavaScript = vi.fn(async () => false);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'waitFor',
			selector: '#never',
			timeoutMs: 1,
		});
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/timed out/i);
	});

	it('selector-scoped read returns the matched element content with page meta', async () => {
		const executeJavaScript = vi.fn(async () => 'ELEMENT TEXT');
		const extract = vi.fn(async () => 'WHOLE PAGE');
		const res = await applyBrowserOp(
			makeHandle({
				executeJavaScript,
				extract,
				getMeta: () => ({ url: 'https://x', title: 'X' }),
			}),
			{ kind: 'read', format: 'text', selector: '#main' }
		);
		expect(res).toEqual({ ok: true, content: 'ELEMENT TEXT', url: 'https://x', title: 'X' });
		// The selector path must query the element, not fall back to full-page extract.
		expect(extract).not.toHaveBeenCalled();
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('"#main"');
	});

	it('selector-scoped read maps html format to outerHTML extraction', async () => {
		const executeJavaScript = vi.fn(async () => '<div id="main"></div>');
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'read',
			format: 'html',
			selector: '#main',
		});
		expect(res.ok).toBe(true);
		expect(res.content).toBe('<div id="main"></div>');
		expect(String(executeJavaScript.mock.calls[0][0])).toContain('outerHTML');
	});

	it('selector-scoped read returns ok:false when nothing matches', async () => {
		const executeJavaScript = vi.fn(async () => null);
		const res = await applyBrowserOp(makeHandle({ executeJavaScript }), {
			kind: 'read',
			format: 'text',
			selector: '#missing',
		});
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/no element matches/i);
	});
});

describe('resolveAndRun', () => {
	it('uses the captured caller policy when concurrent tabs and the selection use different providers', async () => {
		const session = createMockSession({
			id: 'sess-A',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [
				createMockAITab({ tabProvider: 'claude-code', turnProvider: 'codex', state: 'busy' }),
			],
			browserTabs: [{ id: 'u-1' } as BrowserTab],
		});
		vi.mocked(selectActiveSession).mockReturnValue(session);
		useSettingsStore.setState({ coworkingBrowserInteraction: ['codex'] });
		const approval = vi.fn(async () => true);
		const caller = {
			sessionId: 'sess-A',
			processSessionId: 'sess-A-ai-tab-1',
			provider: 'codex' as const,
		};
		await resolveAndRun(
			{ current: new Map([['u-1', makeHandle({ getTabId: () => 'u-1' })]]) },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			approval,
			undefined,
			true,
			caller
		);
		expect(approval).toHaveBeenCalledWith(
			{ kind: 'reload' },
			{ agentId: 'codex', sessionId: 'sess-A', forceConfirm: true }
		);
		approval.mockClear();
		const legacy = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			approval
		);
		expect(legacy.ok).toBe(false);
		expect(approval).not.toHaveBeenCalled();
	});

	const allow: BrowserApprovalRequester = async () => true;

	beforeEach(() => {
		vi.clearAllMocks();
		// Focused ops now pin into the module-singleton keep-alive store; start
		// clean and cancel the real 120s prune timer between tests.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	afterEach(() => {
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	it('returns ok:false when a non-focused agent has no background host', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not live/i);
	});

	it('uses an already-mounted handle for a focused op', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({
			getTabId: () => 'u-1',
			extract: vi.fn(async () => 'TXT'),
			getMeta: () => ({ url: 'https://x', title: 'X' }),
		});
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res).toEqual({ ok: true, content: 'TXT', url: 'https://x', title: 'X' });
	});

	it('runs on the pin-driven hidden mount without switching the user surface', async () => {
		// The user is on a terminal tab (activeBrowserTabId null). The op must drive
		// the browser tab through the keep-alive pin's hidden mount and NEVER switch
		// the visible surface: the activate/prevSurface-restore path is gone, so
		// setSessions must not be touched at all.
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-2' }]));
		const setSessions = vi.fn();
		vi.mocked(useSessionStore.getState).mockReturnValue({
			setSessions,
		} as unknown as SessionStore);
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-2', reload });
		const res = await resolveAndRun(
			{ current: new Map([['u-2', handle]]) },
			'u-2',
			'sess-A',
			{ kind: 'reload' },
			allow
		);
		expect(res.ok).toBe(true);
		expect(reload).toHaveBeenCalled();
		// The tab was pinned for keep-alive so it stays mounted (hidden)...
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).toContain('u-2');
		// ...and the user's visible surface was never switched.
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('returns ok:false when the pinned tab never mounts a handle', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-3' }]));
		const setSessions = vi.fn();
		vi.mocked(useSessionStore.getState).mockReturnValue({
			setSessions,
		} as unknown as SessionStore);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-3',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/could not be reached/i);
		// No activate/restore surface-switch on the unreachable path.
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('pick (browser-pick) describes by selector and delivers to the owning agent, unprompted', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const capture = {
			pick: { selector: 'h1', tagName: 'h1' },
			screenshot: 'data:image/png;base64,CROP',
		};
		const inspectElement = vi.fn(async () => capture);
		const handle = makeHandle({
			getTabId: () => 'u-1',
			inspectElement: inspectElement as unknown as BrowserTabViewHandle['inspectElement'],
		});
		const requestApproval = vi.fn(async () => true);
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'pick', selector: 'h1', note: 'bigger', background: true },
			requestApproval
		);
		expect(requestApproval).not.toHaveBeenCalled();
		expect(inspectElement).toHaveBeenCalledWith('h1');
		expect(deliverDesignPick).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'sess-A',
				browserTabId: 'u-1',
				note: 'bigger',
				reveal: false,
				screenshot: 'data:image/png;base64,CROP',
			})
		);
		expect(res).toMatchObject({
			ok: true,
			content: 'ELEMENT BLOCK',
			aiTabId: 'ai-1',
			pickId: 'pick-1',
			dataUrl: 'data:image/png;base64,CROP',
		});
		// A chip is not a queued message.
		expect(queueDesignPick).not.toHaveBeenCalled();
		expect(res).not.toHaveProperty('queueItemId');
	});

	describe('pick with queue (browser-pick --queue)', () => {
		const capture = {
			pick: { selector: 'h1', tagName: 'h1' },
			screenshot: 'data:image/png;base64,CROP',
		};
		const handleWith = (inspected: unknown) =>
			makeHandle({
				getTabId: () => 'u-1',
				inspectElement: vi.fn(
					async () => inspected
				) as unknown as BrowserTabViewHandle['inspectElement'],
			});

		it('queues the element as its own message: no chip, and nothing asks to reveal', async () => {
			vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
			const handle = handleWith(capture);
			const requestApproval = vi.fn(async () => true);
			const res = await resolveAndRun(
				{ current: new Map([['u-1', handle]]) },
				'u-1',
				'sess-A',
				{ kind: 'pick', selector: 'h1', note: 'bigger', background: true, queue: true },
				requestApproval
			);
			// Like a chip pick, it needs no approval: it only adds to the queue.
			expect(requestApproval).not.toHaveBeenCalled();
			expect(queueDesignPick).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'sess-A',
					browserTabId: 'u-1',
					note: 'bigger',
					screenshot: 'data:image/png;base64,CROP',
				})
			);
			// A queued pick moves nothing, so `reveal` is never part of the request.
			expect(vi.mocked(queueDesignPick).mock.calls[0][0]).not.toHaveProperty('reveal');
			expect(deliverDesignPick).not.toHaveBeenCalled();
			expect(res).toMatchObject({
				ok: true,
				content: 'QUEUED BLOCK',
				aiTabId: 'ai-1',
				queueItemId: 'queue-1',
				dataUrl: 'data:image/png;base64,CROP',
				url: 'https://e',
				title: 'E',
			});
			expect(res).not.toHaveProperty('pickId');
		});

		it('says so when the agent has no AI tab to queue into', async () => {
			// `null` is what the service returns (after its own toast) with no AI tab.
			vi.mocked(queueDesignPick).mockResolvedValueOnce(null as never);
			const res = await applyBrowserOp(
				handleWith(capture),
				{ kind: 'pick', selector: 'h1', queue: true },
				'sess-A'
			);
			expect(res).toEqual({
				ok: false,
				content: 'This agent has no AI tab to queue the element into.',
			});
		});

		it('queues nothing for a selector that misses or is invalid', async () => {
			for (const [inspected, content] of [
				['not-found', 'No element matches selector: .x'],
				['invalid-selector', 'Not a valid CSS selector: .x'],
			] as const) {
				const res = await applyBrowserOp(
					handleWith(inspected),
					{ kind: 'pick', selector: '.x', queue: true },
					'sess-A'
				);
				expect(res).toMatchObject({ ok: false, content });
			}
			expect(queueDesignPick).not.toHaveBeenCalled();
		});
	});

	describe('pick by region (browser-pick --rect)', () => {
		const rect = { x: 0, y: 120, width: 1280, height: 400 };
		const capture = {
			region: {
				url: 'https://e',
				rect,
				viewport: { width: 1280, height: 800 },
				elements: [],
				elementsTruncated: false,
			},
			screenshot: 'data:image/png;base64,REGION',
		};
		const handleWith = (inspected: unknown) =>
			makeHandle({
				getTabId: () => 'u-1',
				inspectRegion: vi.fn(
					async () => inspected
				) as unknown as BrowserTabViewHandle['inspectRegion'],
			});

		it('lists the region and delivers it as a chip, unprompted, without touching the selector path', async () => {
			vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
			const handle = handleWith(capture);
			const requestApproval = vi.fn(async () => true);
			const res = await resolveAndRun(
				{ current: new Map([['u-1', handle]]) },
				'u-1',
				'sess-A',
				{ kind: 'pick', rect, note: 'tighten', background: true },
				requestApproval
			);
			expect(requestApproval).not.toHaveBeenCalled();
			expect(handle.inspectRegion).toHaveBeenCalledWith(rect);
			expect(handle.inspectElement).not.toHaveBeenCalled();
			// The region capture itself is what is delivered, as a drag delivers it.
			expect(deliverDesignPick).toHaveBeenCalledWith(
				expect.objectContaining({
					region: capture.region,
					screenshot: 'data:image/png;base64,REGION',
					sessionId: 'sess-A',
					browserTabId: 'u-1',
					note: 'tighten',
					reveal: false,
				})
			);
			expect(res).toMatchObject({
				ok: true,
				content: 'ELEMENT BLOCK',
				aiTabId: 'ai-1',
				pickId: 'pick-1',
				dataUrl: 'data:image/png;base64,REGION',
			});
			expect(queueDesignPick).not.toHaveBeenCalled();
		});

		it('queues the region as its own message with queue', async () => {
			const res = await applyBrowserOp(
				handleWith(capture),
				{ kind: 'pick', rect, queue: true },
				'sess-A'
			);
			expect(queueDesignPick).toHaveBeenCalledWith(
				expect.objectContaining({ region: capture.region, sessionId: 'sess-A' })
			);
			expect(vi.mocked(queueDesignPick).mock.calls[0][0]).not.toHaveProperty('reveal');
			expect(deliverDesignPick).not.toHaveBeenCalled();
			expect(res).toMatchObject({ ok: true, content: 'QUEUED BLOCK', queueItemId: 'queue-1' });
			expect(res).not.toHaveProperty('pickId');
		});

		it('says so when none of the region is on the page, and delivers nothing', async () => {
			const res = await applyBrowserOp(handleWith(null), { kind: 'pick', rect }, 'sess-A');
			expect(res).toEqual({
				ok: false,
				content:
					"No part of the region 0,120,1280,400 is in the page's viewport (--rect is CSS px from the viewport's top-left corner).",
			});
			expect(deliverDesignPick).not.toHaveBeenCalled();
			expect(queueDesignPick).not.toHaveBeenCalled();
		});

		it('names the region when the agent has no AI tab for it', async () => {
			vi.mocked(deliverDesignPick).mockResolvedValueOnce(null as never);
			expect(await applyBrowserOp(handleWith(capture), { kind: 'pick', rect }, 'sess-A')).toEqual({
				ok: false,
				content: 'This agent has no AI tab to add the region to.',
			});

			vi.mocked(queueDesignPick).mockResolvedValueOnce(null as never);
			expect(
				await applyBrowserOp(handleWith(capture), { kind: 'pick', rect, queue: true }, 'sess-A')
			).toEqual({ ok: false, content: 'This agent has no AI tab to queue the region into.' });
		});
	});

	it('pick reports a selector miss and an invalid selector', async () => {
		const miss = makeHandle({
			inspectElement: vi.fn(async () => 'not-found' as const),
		});
		expect(await applyBrowserOp(miss, { kind: 'pick', selector: '.x' }, 'sess-A')).toMatchObject({
			ok: false,
			content: 'No element matches selector: .x',
		});
		const bad = makeHandle({
			inspectElement: vi.fn(async () => 'invalid-selector' as const),
		});
		expect(await applyBrowserOp(bad, { kind: 'pick', selector: '[[' }, 'sess-A')).toMatchObject({
			ok: false,
			content: 'Not a valid CSS selector: [[',
		});
	});

	it('pick refuses a tab hidden from agents', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(
			fakeActive('sess-A', 'u-1', [{ id: 'u-1', hiddenFromAgent: true }])
		);
		const handle = makeHandle({ getTabId: () => 'u-1' });
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'pick', selector: 'h1' },
			vi.fn(async () => true)
		);
		expect(res.ok).toBe(false);
		expect(handle.inspectElement).not.toHaveBeenCalled();
	});

	it('does not request approval for read ops', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'TXT') });
		const requestApproval = vi.fn(async () => true);
		await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			requestApproval
		);
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it('declines an interaction op when approval is denied and never touches the handle', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-9'));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-9', reload });
		const deny: BrowserApprovalRequester = async () => false;
		const res = await resolveAndRun(
			{ current: new Map([['u-9', handle]]) },
			'u-9',
			'sess-A',
			{ kind: 'reload' },
			deny
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/declined/i);
		expect(reload).not.toHaveBeenCalled();
	});

	it('reads a non-focused tab via the background host when provided', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'BG') });
		const resolveBackground = vi.fn(async () => handle);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow,
			resolveBackground
		);
		expect(res).toEqual({ ok: true, content: 'BG', url: 'https://e', title: 'E' });
		expect(resolveBackground).toHaveBeenCalledWith('sess-A', 'u-1');
	});

	it('drives a non-focused tab via the background host (interaction)', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-1', reload });
		const resolveBackground = vi.fn(async () => handle);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			allow,
			resolveBackground
		);
		expect(res.ok).toBe(true);
		expect(reload).toHaveBeenCalled();
	});

	it('returns ok:false when the background host cannot mount the tab', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const resolveBackground = vi.fn(async () => null);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow,
			resolveBackground
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not live/i);
		expect(resolveBackground).toHaveBeenCalled();
	});

	it('rejects an op targeting a hidden tab before requesting approval (hidden == closed)', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(
			fakeActive('sess-A', 'u-1', [{ id: 'u-1', hiddenFromAgent: true }])
		);
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-1', reload });
		const requestApproval = vi.fn(async () => true);
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			requestApproval
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not found in your session/i);
		expect(requestApproval).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it('rejects an op whose tab is gone from the requesting session', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-1' }]));
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-gone',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not found in your session/i);
	});

	it("propagates main's needsConfirm to the approval gate as forceConfirm", async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const reload = vi.fn();
		const handle = makeHandle({ getTabId: () => 'u-1', reload });
		const requestApproval = vi.fn(async () => true);
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			requestApproval,
			undefined,
			true
		);
		expect(res.ok).toBe(true);
		expect(requestApproval).toHaveBeenCalledWith(
			{ kind: 'reload' },
			{ agentId: 'claude-code', sessionId: 'sess-A', forceConfirm: true }
		);
	});

	it('does not force approval when main did not require confirmation', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({ getTabId: () => 'u-1' });
		const requestApproval = vi.fn(async () => true);
		await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'reload' },
			requestApproval
		);
		expect(requestApproval).toHaveBeenCalledWith(
			{ kind: 'reload' },
			{ agentId: 'claude-code', sessionId: 'sess-A', forceConfirm: false }
		);
	});
});

describe('resolveAndRun session-scoped ops (newTab / closeTab)', () => {
	const allow: BrowserApprovalRequester = async () => true;

	beforeEach(() => {
		vi.clearAllMocks();
		// createTabForSession pins the new tab; keep the singleton clean + cancel
		// its 120s prune timer between tests.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	afterEach(() => {
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	/** Minimal structural stand-in for the Session slices these ops touch. */
	interface StoreSession {
		id: string;
		browserTabs: Array<Partial<BrowserTab>>;
		unifiedTabOrder: Array<{ type: string; id: string }>;
		activeBrowserTabId?: string | null;
		inputMode?: string;
		aiTabs?: unknown[];
		filePreviewTabs?: unknown[];
		terminalTabs?: unknown[];
	}

	/** Wires useSessionStore.getState().setSessions to a mutable array so the
	 *  tests can observe what the op actually did to the requesting session. */
	function wireStore(sessions: StoreSession[]) {
		const setSessions = vi.fn((updater: (prev: Session[]) => Session[]) => {
			const prev = sessions as unknown as Session[];
			const next = updater(prev) as unknown as StoreSession[];
			sessions.length = 0;
			sessions.push(...next);
		});
		vi.mocked(useSessionStore.getState).mockReturnValue({
			setSessions,
		} as unknown as SessionStore);
		return setSessions;
	}

	it('newTab creates a tab in the requesting session without any webview or surface hijack', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [
			{ id: 'other', browserTabs: [], unifiedTabOrder: [] },
			{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [], activeBrowserTabId: null },
		];
		const setSessions = wireStore(sessions);
		const requestApproval = vi.fn(async () => true);
		const resolveBackground = vi.fn(async () => null);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'example.com', ephemeral: true },
			requestApproval,
			resolveBackground
		);
		expect(res.ok).toBe(true);
		expect(String(res.content)).toContain('list_browsers');
		// Scheme-less input went through the shared navigation resolver.
		expect(res.url).toBe('https://example.com/');
		// The tab landed in the REQUESTING session, flagged + partitioned incognito.
		const target = sessions.find((s) => s.id === 'sess-A');
		expect(target?.browserTabs).toHaveLength(1);
		const created = target?.browserTabs[0];
		expect(created?.url).toBe('https://example.com/');
		expect(created?.ephemeral).toBe(true);
		expect(created?.partition).toMatch(/^maestro-ephemeral-/);
		expect(target?.unifiedTabOrder).toContainEqual({ type: 'browser', id: created?.id });
		// No-hijack: the session was NOT already on a browser tab, so its active
		// surface is left untouched (activeBrowserTabId stays null).
		expect(target?.activeBrowserTabId).toBeNull();
		// The focused ('other') session is untouched.
		expect(sessions.find((s) => s.id === 'other')?.browserTabs).toHaveLength(0);
		// No webview handle was needed: the background host was never consulted.
		expect(resolveBackground).not.toHaveBeenCalled();
		// newTab is an interaction op: the approval gate still ran.
		expect(requestApproval).toHaveBeenCalled();
		expect(setSessions).toHaveBeenCalledTimes(1);
	});

	it('newTab brings the tab into view only when the session is already on a browser tab', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-existing'));
		const sessions: StoreSession[] = [
			{
				id: 'sess-A',
				browserTabs: [{ id: 'u-existing' }],
				unifiedTabOrder: [{ type: 'browser', id: 'u-existing' }],
				activeBrowserTabId: 'u-existing',
				inputMode: 'ai',
			},
		];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'example.com' },
			allow
		);
		expect(res.ok).toBe(true);
		const created = sessions[0].browserTabs.at(-1);
		expect(created?.id).not.toBe('u-existing');
		// Already viewing a browser tab -> opening another is a natural continuation,
		// so the new tab becomes the active surface.
		expect(sessions[0].activeBrowserTabId).toBe(created?.id);
		expect(sessions[0].inputMode).toBe('ai');
	});

	it('newTab pins the freshly created tab so it stays mounted from creation', async () => {
		// Test 2 (assigned): createTabForSession must pin the new tab's uuid the
		// instant it is created, so a user clicking away before the agent's next op
		// cannot unmount it. Teeth: dropping pin(created.id) empties the pin set.
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null));
		const sessions: StoreSession[] = [
			{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [], activeBrowserTabId: null },
		];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'example.com' },
			allow
		);
		expect(res.ok).toBe(true);
		const created = sessions.find((s) => s.id === 'sess-A')?.browserTabs.at(-1);
		expect(created?.id).toBeTruthy();
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).toContain(
			created?.id
		);
	});

	it('newTab without ephemeral mints a persistent per-session partition', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [] }];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab' },
			allow
		);
		expect(res.ok).toBe(true);
		const created = sessions[0].browserTabs[0];
		expect(created?.url).toBe('about:blank');
		expect(created?.partition).toMatch(/^persist:maestro-browser-session-/);
		expect(created?.ephemeral).toBeUndefined();
	});

	it('newTab rejects an unloadable target and creates no tab', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const sessions: StoreSession[] = [{ id: 'sess-A', browserTabs: [], unifiedTabOrder: [] }];
		const setSessions = wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'',
			'sess-A',
			{ kind: 'newTab', url: 'javascript:alert(1)' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/protocol not allowed/i);
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('closeTab removes the target tab from the requesting session', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-1' }]));
		const sessions: StoreSession[] = [
			{
				id: 'sess-A',
				browserTabs: [{ id: 'u-1', url: 'https://a', title: 'A' }],
				unifiedTabOrder: [{ type: 'browser', id: 'u-1' }],
				aiTabs: [],
				filePreviewTabs: [],
				terminalTabs: [],
			},
		];
		wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'closeTab' },
			allow
		);
		expect(res.ok).toBe(true);
		expect(sessions[0].browserTabs).toHaveLength(0);
		// It was the agent's only tab, so the agent lands on a blank AI chat.
		expect(sessions[0].unifiedTabOrder).toEqual([{ type: 'ai', id: expect.any(String) }]);
		expect(sessions[0].aiTabs).toHaveLength(1);
	});

	it('closeTab on a tab missing from the session fails closed at the boundary', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', null, [{ id: 'u-1' }]));
		const sessions: StoreSession[] = [
			{ id: 'sess-A', browserTabs: [{ id: 'u-1' }], unifiedTabOrder: [] },
		];
		const setSessions = wireStore(sessions);
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-9',
			'sess-A',
			{ kind: 'closeTab' },
			allow
		);
		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not found in your session/i);
		expect(sessions[0].browserTabs).toHaveLength(1);
		expect(setSessions).not.toHaveBeenCalled();
	});
});

describe('resolveAndRun viewport (browser-viewport)', () => {
	/** A requester that would grant anything, so a test can see it was never asked. */
	const ask = vi.fn(async () => true) as unknown as BrowserApprovalRequester &
		ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	/**
	 * One agent with these browser tabs, behind a store whose single-tab updater
	 * applies the caller's mapper to them, as `updateBrowserTab()` does. Returns the
	 * live session so a test can read what the op left on its tabs.
	 */
	function wireTabs(tabs: Array<Partial<BrowserTab>>, { focused = true } = {}) {
		const session = {
			id: 'sess-A',
			toolType: 'claude-code',
			activeBrowserTabId: null,
			browserTabs: tabs,
		};
		vi.mocked(selectSessionById).mockReturnValue(() => session as unknown as Session);
		vi.mocked(selectActiveSession).mockReturnValue(
			focused ? (session as unknown as Session) : fakeActive('other', null)
		);
		vi.mocked(updateBrowserTab).mockImplementation((_sessionId, tabId, updater) => {
			session.browserTabs = session.browserTabs.map((t) =>
				t.id === tabId ? updater(t as BrowserTab) : t
			);
		});
		return session;
	}

	const tab = (extra: Partial<BrowserTab> = {}): Partial<BrowserTab> => ({
		id: 'u-1',
		url: 'https://example.com/',
		title: 'Example',
		...extra,
	});

	const run = (op: { kind: 'viewport'; preset?: BrowserViewportPreset }) =>
		resolveAndRun({ current: new Map() }, 'u-1', 'sess-A', op, ask);

	it('sets the preset through the single-tab updater and reports it with the one before', async () => {
		const session = wireTabs([tab()]);

		const res = await run({ kind: 'viewport', preset: 'phone' });

		expect(res).toMatchObject({
			ok: true,
			viewportPreset: 'phone',
			previousViewportPreset: 'fit',
			content: 'Phone (390 px wide)',
		});
		expect(updateBrowserTab).toHaveBeenCalledTimes(1);
		expect(vi.mocked(updateBrowserTab).mock.calls[0].slice(0, 2)).toEqual(['sess-A', 'u-1']);
		// The write is the toolbar's: the tab keeps everything else it had.
		expect(session.browserTabs[0]).toMatchObject({
			id: 'u-1',
			url: 'https://example.com/',
			title: 'Example',
			viewportPreset: 'phone',
		});
	});

	it('reports the preset the tab had before, so the caller can put it back', async () => {
		const session = wireTabs([tab({ viewportPreset: 'tablet' })]);

		const res = await run({ kind: 'viewport', preset: 'laptop' });

		expect(res).toMatchObject({ viewportPreset: 'laptop', previousViewportPreset: 'tablet' });
		expect(session.browserTabs[0].viewportPreset).toBe('laptop');
	});

	it('can put a tab back to Fit, which the toolbar writes as a preset too', async () => {
		const session = wireTabs([tab({ viewportPreset: 'phone' })]);

		const res = await run({ kind: 'viewport', preset: 'fit' });

		expect(res).toMatchObject({ viewportPreset: 'fit', previousViewportPreset: 'phone' });
		expect(session.browserTabs[0].viewportPreset).toBe('fit');
	});

	it('reads without writing: Fit for a tab with no saved preset, the saved one otherwise', async () => {
		wireTabs([tab()]);
		expect(await run({ kind: 'viewport' })).toMatchObject({
			ok: true,
			viewportPreset: 'fit',
			previousViewportPreset: 'fit',
			content: "Fit (the tab's width)",
		});

		wireTabs([tab({ viewportPreset: 'desktop' })]);
		expect(await run({ kind: 'viewport' })).toMatchObject({
			ok: true,
			viewportPreset: 'desktop',
			previousViewportPreset: 'desktop',
		});
		expect(updateBrowserTab).not.toHaveBeenCalled();
	});

	it('writes nothing when the tab already shows the preset', async () => {
		wireTabs([tab({ viewportPreset: 'phone' })]);

		const res = await run({ kind: 'viewport', preset: 'phone' });

		expect(res).toMatchObject({
			ok: true,
			viewportPreset: 'phone',
			previousViewportPreset: 'phone',
		});
		expect(updateBrowserTab).not.toHaveBeenCalled();
	});

	it('is a store update: it needs no webview, never asks for approval, and works for an agent that is not on screen', async () => {
		const session = wireTabs([tab()], { focused: false });
		const resolveBackgroundHandle = vi.fn(async () => null);

		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'viewport', preset: 'tablet' },
			ask,
			resolveBackgroundHandle,
			// Main says the policy would confirm an interaction; a viewport is not one.
			true
		);

		expect(res).toMatchObject({ ok: true, viewportPreset: 'tablet' });
		expect(session.browserTabs[0].viewportPreset).toBe('tablet');
		expect(ask).not.toHaveBeenCalled();
		expect(resolveBackgroundHandle).not.toHaveBeenCalled();
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).toEqual([]);
	});

	it('fails closed for a tab that is not in the agent, and writes nothing', async () => {
		wireTabs([tab({ id: 'u-2' })]);

		const res = await run({ kind: 'viewport', preset: 'phone' });

		expect(res.ok).toBe(false);
		expect(String(res.content)).toMatch(/not found in your session/i);
		expect(updateBrowserTab).not.toHaveBeenCalled();
	});

	it('treats a tab hidden from agents as closed, for a read as well as a write', async () => {
		wireTabs([tab({ hiddenFromAgent: true, viewportPreset: 'phone' })]);

		for (const op of [
			{ kind: 'viewport' as const },
			{ kind: 'viewport' as const, preset: 'fit' as const },
		]) {
			const res = await run(op);
			expect(res.ok).toBe(false);
			expect(String(res.content)).toMatch(/not found in your session/i);
			expect(res).not.toHaveProperty('viewportPreset');
		}
		expect(updateBrowserTab).not.toHaveBeenCalled();
	});

	it('says so when the store did not take the write, rather than reporting the preset asked for', async () => {
		wireTabs([tab()]);
		// The tab vanished between the check and the write: the updater matches nothing.
		vi.mocked(updateBrowserTab).mockImplementation(() => {});

		const res = await run({ kind: 'viewport', preset: 'phone' });

		expect(res).toEqual({
			ok: false,
			content: 'The browser tab changed while its viewport was being set.',
		});
	});
});

describe('resolveAndRun keep-alive pin', () => {
	const allow: BrowserApprovalRequester = async () => true;

	beforeEach(() => {
		vi.clearAllMocks();
		// Every focused op pins into this module-level singleton; start clean so a
		// prior test's pin can't produce a false positive here.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	afterEach(() => {
		// Cancel the real 120s prune timer the pin scheduled.
		useCoworkingBrowserKeepAliveStore.getState().clear();
	});

	it('pins the driven tab for keep-alive on a focused-session op', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'TXT') });
		// A read needs no approval and hits the already-mounted fast path, so it
		// returns without any focus change - isolating the pin() side effect.
		const res = await resolveAndRun(
			{ current: new Map([['u-1', handle]]) },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow
		);
		expect(res.ok).toBe(true);
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).toContain('u-1');
	});

	it('does not pin the focused keep-alive store for a non-focused (background) op', async () => {
		// The requesting agent is not the focused session; it resolves via the
		// background host and must NOT touch the focused-agent keep-alive store
		// (that store scopes the active agent only).
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('other', null));
		const handle = makeHandle({ getTabId: () => 'u-1', extract: vi.fn(async () => 'BG') });
		const res = await resolveAndRun(
			{ current: new Map() },
			'u-1',
			'sess-A',
			{ kind: 'read', format: 'text' },
			allow,
			async () => handle
		);
		expect(res.ok).toBe(true);
		expect(activePinnedTabIds(useCoworkingBrowserKeepAliveStore.getState().pins)).not.toContain(
			'u-1'
		);
	});
});

describe('Coworking browser responder approval', () => {
	it('executes only with matching opt-in or per-call approval', async () => {
		vi.mocked(selectActiveSession).mockReturnValue(fakeActive('sess-A', 'u-1'));
		const settings = useSettingsStore.getState();
		const approvalStore = useCoworkingApprovalStore.getState();
		const previousBridge = window.maestro.coworking;
		const sendBrowserOpResponse = vi.fn();
		const onRequestBrowserOp = vi.fn<CoworkingApi['onRequestBrowserOp']>(() => () => {});
		window.maestro.coworking = { onRequestBrowserOp, sendBrowserOpResponse } as CoworkingApi;
		const executeJavaScript = vi.fn(async () => 'ok');
		const handle = makeHandle({ getTabId: () => 'u-1', executeJavaScript });

		try {
			useSettingsStore.setState({
				coworkingBrowserInteraction: ['claude-code'],
				coworkingBrowserInteractionConfirm: {},
				coworkingBrowserTypingWithoutConfirmation: [],
			});
			const { unmount } = renderHook(() =>
				useCoworkingBrowserResponder({ current: new Map([['u-1', handle]]) })
			);
			const [receive] = onRequestBrowserOp.mock.lastCall!;
			const type: BrowserOp = { kind: 'type', selector: 'textarea', text: 'fixture' };

			async function expectApproval(op: BrowserOp, mainNeedsConfirm = false) {
				executeJavaScript.mockClear();
				receive('u-1', 'sess-A', op, 'response', mainNeedsConfirm);
				const [request] = useCoworkingApprovalStore.getState().queue;
				expect(request).toBeDefined();
				expect(executeJavaScript).not.toHaveBeenCalled();
				await act(async () => approvalStore.settle(request!.id, false));
				expect(sendBrowserOpResponse).toHaveBeenLastCalledWith(
					'response',
					expect.objectContaining({ ok: false })
				);
				expect(executeJavaScript).not.toHaveBeenCalled();
			}

			await expectApproval(type);
			useSettingsStore.setState({ coworkingBrowserTypingWithoutConfirmation: ['claude-code'] });
			await act(async () => receive('u-1', 'sess-A', type, 'response', false));
			expect(executeJavaScript).toHaveBeenCalledOnce();
			expect(sendBrowserOpResponse).toHaveBeenLastCalledWith(
				'response',
				expect.objectContaining({ ok: true })
			);
			expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
			await expectApproval(type, true);
			await expectApproval({ kind: 'eval', code: '1 + 1' });
			useSettingsStore.setState({ coworkingBrowserTypingWithoutConfirmation: [] });
			await expectApproval(type);
			unmount();
		} finally {
			window.maestro.coworking = previousBridge;
			useSettingsStore.setState({
				coworkingBrowserInteraction: settings.coworkingBrowserInteraction,
				coworkingBrowserInteractionConfirm: settings.coworkingBrowserInteractionConfirm,
				coworkingBrowserTypingWithoutConfirmation:
					settings.coworkingBrowserTypingWithoutConfirmation,
			});
			for (const { id } of useCoworkingApprovalStore.getState().queue)
				approvalStore.settle(id, false);
			useCoworkingBrowserKeepAliveStore.getState().clear();
		}
	});
});
