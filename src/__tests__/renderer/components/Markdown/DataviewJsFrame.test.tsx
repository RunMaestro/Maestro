/**
 * DataviewJsFrame (D4, DV-11, DEV-5): the host of one `dataviewjs` block. These tests drive the `<webview>`
 * the way Electron would (dom-ready, ipc-message, render-process-gone, did-fail-load) and check what the
 * host does with it: the tag carries only `partition` and `src`; every guest message is validated; DQL and
 * file reads go to main only within a run and a few at a time; links and tasks route like DataviewBlock's;
 * the 5 s watchdog and a crash replace the guest and stop on that block; changes re-run the script.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
	DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT,
	DataviewJsFrame,
} from '../../../../renderer/components/Markdown/components/DataviewJsFrame';
import type { DataviewDocumentScope } from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import {
	DATAVIEW_GUEST_URL,
	DATAVIEW_JS_MAX_FRAME_HEIGHT,
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	dataviewGuestPartition,
	type DataviewChangeEvent,
	type SandboxIndexSnapshot,
} from '../../../../shared/dataview';
import { PANEL_THEME_CHANNEL } from '../../../../shared/plugins/panel-theme';
import { DATAVIEW_REFRESH_DEBOUNCE_MS } from '../../../../renderer/hooks/file/useLiveDataviewResult';
import { resetDataviewJsGuestSlotsForTests } from '../../../../renderer/services/dataviewJsGuestSlots';
import { openUrl } from '../../../../renderer/utils/openUrl';
import { toggleDataviewResultTask } from '../../../../renderer/services/dataviewTaskToggle';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/utils/openUrl', () => ({ openUrl: vi.fn() }));
vi.mock('../../../../renderer/services/dataviewTaskToggle', () => ({
	toggleDataviewResultTask: vi.fn(async () => true),
}));

const ROOT = '/vault';
const NOTE = '/vault/Notes/Note.md';

function snapshotResponse(revision = 1, root = ROOT) {
	const result: SandboxIndexSnapshot = {
		revision,
		files: ['Notes/Note.md', 'Notes/Other.md'],
		folders: ['Notes'],
		stars: [],
		pages: [],
	};
	return { root, sshRemoteId: null, revision, path: 'Notes/Note.md', result };
}

function scope(overrides: Partial<DataviewDocumentScope> = {}): DataviewDocumentScope {
	return {
		filePath: NOTE,
		agentId: 'agent-1',
		openLink: vi.fn(),
		toggleOwnTask: vi.fn(async () => true),
		...overrides,
	};
}

// --- IntersectionObserver the test controls ---------------------------------------------------------

const observers: ControlledIntersectionObserver[] = [];

class ControlledIntersectionObserver {
	constructor(readonly callback: IntersectionObserverCallback) {
		observers.push(this);
	}
	observe() {}
	unobserve() {}
	disconnect() {
		const index = observers.indexOf(this);
		if (index >= 0) observers.splice(index, 1);
	}
	takeRecords() {
		return [];
	}
}

function setNear(near: boolean, observer?: ControlledIntersectionObserver) {
	act(() => {
		for (const target of observer ? [observer] : [...observers]) {
			target.callback(
				[{ isIntersecting: near } as IntersectionObserverEntry],
				target as unknown as IntersectionObserver
			);
		}
	});
}

// --- The guest element --------------------------------------------------------------------------------

type FakeGuest = HTMLElement & { send: ReturnType<typeof vi.fn> };

/** The guest element once it (or a new one, past `previous`) is mounted. Timer-free, so fake timers work. */
async function mountedGuest(container: HTMLElement, previous?: Element): Promise<FakeGuest> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const found = container.querySelector('webview');
		if (found && found !== previous) {
			const guest = found as FakeGuest;
			if (!vi.isMockFunction(guest.send)) guest.send = vi.fn();
			return guest;
		}
		await flush();
	}
	throw new Error('no new webview was mounted');
}

function domReady(guest: Element) {
	act(() => {
		guest.dispatchEvent(new Event('dom-ready'));
	});
}

function guestSays(guest: Element, message: unknown, channel = SANDBOX_TO_HOST_CHANNEL) {
	act(() => {
		const event = new Event('ipc-message');
		Object.assign(event, { channel, args: [message] });
		guest.dispatchEvent(event);
	});
}

function sentToGuest(guest: FakeGuest): Array<Record<string, unknown>> {
	return guest.send.mock.calls
		.filter((call) => call[0] === SANDBOX_TO_GUEST_CHANNEL)
		.map((call) => call[1] as Record<string, unknown>);
}

function runs(guest: FakeGuest) {
	return sentToGuest(guest).filter((message) => message.type === 'run');
}

function lastRun(guest: FakeGuest) {
	const all = runs(guest);
	return all[all.length - 1] as { runId: string; blockId: string; source: string };
}

/** Let resolved IPC promises and their reply hops settle. */
async function flush() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
}

async function startFrame(code = 'dv.paragraph("hi")', doc = scope()) {
	vi.mocked(window.maestro.dataview.jsSnapshot).mockResolvedValue(snapshotResponse());
	const view = render(<DataviewJsFrame code={code} theme={mockTheme} doc={doc} />);
	setNear(true);
	const guest = await mountedGuest(view.container);
	domReady(guest);
	return { view, guest, doc, run: lastRun(guest) };
}

function done(run: { runId: string; blockId: string }, height = 120) {
	return { type: 'render.done', blockId: run.blockId, runId: run.runId, height };
}

beforeEach(() => {
	vi.clearAllMocks();
	observers.length = 0;
	vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);
	resetDataviewJsGuestSlotsForTests();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('DataviewJsFrame: mounting', () => {
	it('fetches nothing and mounts no guest until the block nears the viewport', () => {
		render(<DataviewJsFrame code="dv.paragraph(1)" theme={mockTheme} doc={scope()} />);
		expect(window.maestro.dataview.jsSnapshot).not.toHaveBeenCalled();
		expect(document.querySelector('webview')).toBeNull();
		expect(document.querySelector('[data-dataview-placeholder]')).not.toBeNull();
	});

	it('sets only the per-root partition and the guest document on the tag', async () => {
		const { guest } = await startFrame();
		expect(window.maestro.dataview.jsSnapshot).toHaveBeenCalledWith({
			filePath: NOTE,
			agentId: 'agent-1',
		});
		expect(guest.getAttribute('partition')).toBe(dataviewGuestPartition(ROOT, null));
		expect(guest.getAttribute('src')).toBe(DATAVIEW_GUEST_URL);
		for (const attribute of [
			'preload',
			'nodeintegration',
			'nodeintegrationinsubframes',
			'webpreferences',
			'allowpopups',
			'disablewebsecurity',
			'plugins',
			'srcdoc',
		]) {
			expect(guest.hasAttribute(attribute), attribute).toBe(false);
		}
	});

	it('shows main refusing the snapshot and mounts no guest', async () => {
		vi.mocked(window.maestro.dataview.jsSnapshot).mockRejectedValue(
			new Error('Dataview: DataviewJS does not run in /vault, a vault that is not trusted.')
		);
		render(<DataviewJsFrame code="dv.paragraph(1)" theme={mockTheme} doc={scope()} />);
		setNear(true);
		await screen.findByText(/a vault that is not trusted/);
		expect(document.querySelector('webview')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
	});

	it('keeps a block past the window cap waiting until a guest slot frees', async () => {
		resetDataviewJsGuestSlotsForTests(1);
		vi.mocked(window.maestro.dataview.jsSnapshot).mockResolvedValue(snapshotResponse());
		const first = render(
			<DataviewJsFrame code="dv.paragraph(1)" theme={mockTheme} doc={scope()} />
		);
		const second = render(
			<DataviewJsFrame code="dv.paragraph(2)" theme={mockTheme} doc={scope()} />
		);
		setNear(true);
		await mountedGuest(first.container);
		expect(second.container.querySelector('webview')).toBeNull();
		expect(window.maestro.dataview.jsSnapshot).toHaveBeenCalledTimes(1);

		first.unmount();
		await mountedGuest(second.container);
		expect(window.maestro.dataview.jsSnapshot).toHaveBeenCalledTimes(2);
	});
});

describe('DataviewJsFrame: runs', () => {
	it('sends the theme and one run with the script, the note, and the snapshot once the guest is ready', async () => {
		const { guest, run } = await startFrame('dv.table(["a"], [[1]])');
		expect(guest.send).toHaveBeenCalledWith(PANEL_THEME_CHANNEL, expect.objectContaining({}));
		expect(runs(guest)).toHaveLength(1);
		expect(run).toMatchObject({
			type: 'run',
			source: 'dv.table(["a"], [[1]])',
			thisPath: 'Notes/Note.md',
			snapshot: snapshotResponse().result,
		});
		expect(run.runId).toMatch(/^[\w.:-]+$/);
		expect(run.blockId).toMatch(/^[\w.:-]+$/);
	});

	it('sizes the frame to the reported height, clamped, and drops the placeholder', async () => {
		const { guest, run } = await startFrame();
		expect(document.querySelector('[data-dataview-placeholder]')).not.toBeNull();
		guestSays(guest, done(run, 240.2));
		expect(guest.style.height).toBe('241px');
		expect(document.querySelector('[data-dataview-placeholder]')).toBeNull();

		guestSays(guest, done(run, DATAVIEW_JS_MAX_FRAME_HEIGHT * 3));
		expect(guest.style.height).toBe(`${DATAVIEW_JS_MAX_FRAME_HEIGHT}px`);
	});

	it('ignores an answer to another run or another block', async () => {
		const { guest, run } = await startFrame();
		guestSays(guest, done({ runId: 'run-elsewhere', blockId: run.blockId }));
		guestSays(guest, done({ runId: run.runId, blockId: 'block-elsewhere' }));
		expect(document.querySelector('[data-dataview-placeholder]')).not.toBeNull();
	});

	it("shows a script's error on the block", async () => {
		const { guest, run } = await startFrame();
		guestSays(guest, {
			type: 'render.error',
			blockId: run.blockId,
			runId: run.runId,
			message: 'Evaluation Error: Error: Obsidian API not available in Maestro',
		});
		expect(screen.getByText(/Obsidian API not available in Maestro/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
	});

	it('runs again when the script changes', async () => {
		const { guest, view, doc } = await startFrame('dv.paragraph(1)');
		view.rerender(<DataviewJsFrame code="dv.paragraph(2)" theme={mockTheme} doc={doc} />);
		expect(runs(guest)).toHaveLength(2);
		expect(lastRun(guest).source).toBe('dv.paragraph(2)');
	});

	it('fetches a new snapshot and runs again after a change to its root, debounced', async () => {
		let emit: (event: DataviewChangeEvent) => void = () => {};
		vi.mocked(window.maestro.dataview.onChanged).mockImplementation((handler) => {
			emit = handler;
			return () => {};
		});
		const { guest } = await startFrame();
		vi.useFakeTimers();
		vi.mocked(window.maestro.dataview.jsSnapshot).mockResolvedValue(snapshotResponse(2));

		act(() => emit({ root: '/elsewhere', sshRemoteId: null, revision: 9, changedPaths: [] }));
		act(() => emit({ root: ROOT, sshRemoteId: null, revision: 1, changedPaths: [] }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DATAVIEW_REFRESH_DEBOUNCE_MS + 10);
		});
		expect(window.maestro.dataview.jsSnapshot).toHaveBeenCalledTimes(1);

		act(() =>
			emit({ root: ROOT, sshRemoteId: null, revision: 2, changedPaths: ['Notes/Other.md'] })
		);
		act(() =>
			emit({ root: ROOT, sshRemoteId: null, revision: 2, changedPaths: ['Notes/Other.md'] })
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DATAVIEW_REFRESH_DEBOUNCE_MS + 10);
		});
		expect(window.maestro.dataview.jsSnapshot).toHaveBeenCalledTimes(2);
		expect(runs(guest)).toHaveLength(2);
		expect(lastRun(guest)).toMatchObject({ snapshot: { revision: 2 } });
	});
});

describe('DataviewJsFrame: the watchdog and a dying guest', () => {
	it('replaces a guest that does not answer within 5 s, shows a timeout, and runs nothing until asked', async () => {
		vi.useFakeTimers();
		const { guest, view, run } = await startFrame('while (true) {}');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DATAVIEW_JS_RUN_TIMEOUT_MS - 1);
		});
		expect(view.container.querySelector('webview')).toBe(guest);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(screen.getByText(/did not finish within 5 seconds/)).toBeTruthy();
		const replacement = await mountedGuest(view.container, guest);
		expect(guest.isConnected).toBe(false);

		// The new guest gets ready but runs nothing, and a late answer from the old run changes nothing.
		domReady(replacement);
		expect(runs(replacement)).toHaveLength(0);
		guestSays(replacement, done(run));
		expect(screen.getByText(/did not finish within 5 seconds/)).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
		const fresh = await mountedGuest(view.container, replacement);
		domReady(fresh);
		expect(runs(fresh)).toHaveLength(1);
		expect(screen.queryByText(/did not finish within 5 seconds/)).toBeNull();
	});

	it('never fires after the run answered', async () => {
		vi.useFakeTimers();
		const { guest, view, run } = await startFrame();
		guestSays(guest, done(run));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DATAVIEW_JS_RUN_TIMEOUT_MS * 2);
		});
		expect(view.container.querySelector('webview')).toBe(guest);
		expect(screen.queryByText(/did not finish/)).toBeNull();
	});

	it('replaces a guest whose process died, and stops there', async () => {
		const { guest, view } = await startFrame();
		act(() => {
			guest.dispatchEvent(new Event('render-process-gone'));
		});
		expect(screen.getByText(/the sandbox stopped unexpectedly/)).toBeTruthy();
		const replacement = await mountedGuest(view.container, guest);
		domReady(replacement);
		expect(runs(replacement)).toHaveLength(0);
	});

	it('shows a guest document that failed to load, but not a cancelled load', async () => {
		const { guest } = await startFrame();
		act(() => {
			guest.dispatchEvent(
				Object.assign(new Event('did-fail-load'), { errorCode: -3, isMainFrame: true })
			);
		});
		expect(screen.queryByText(/could not load/)).toBeNull();
		act(() => {
			guest.dispatchEvent(
				Object.assign(new Event('did-fail-load'), { errorCode: -6, isMainFrame: true })
			);
		});
		expect(screen.getByText(/the sandbox could not load/)).toBeTruthy();
	});
});

describe('DataviewJsFrame: the bridge', () => {
	it('drops every message parseSandboxMessage refuses, without asking main or answering', async () => {
		const { guest } = await startFrame();
		const before = guest.send.mock.calls.length;
		for (const message of [
			{ type: 'eval', code: 'x' },
			{ type: 'run', runId: 'r', blockId: 'b', source: 'x', thisPath: 'a.md', snapshot: {} },
			{ type: 'io.load', requestId: 'q1', path: '../../etc/passwd' },
			{ type: 'io.load', requestId: 'q2', path: '/etc/passwd' },
			{ type: 'io.load', requestId: 'q3', path: 'C:\\Windows\\win.ini' },
			JSON.parse('{"type":"io.load","requestId":"q4","path":"a.md","__proto__":{"x":1}}'),
			{ type: 'query.dql', requestId: 'q5', source: 'x'.repeat(1024 * 1024 + 1) },
			{ type: 'open.link', kind: 'url', url: 'javascript:alert(1)', newTab: false },
			null,
			'render.done',
		]) {
			guestSays(guest, message);
		}
		// Another channel is not the bridge at all.
		guestSays(guest, { type: 'io.load', requestId: 'q6', path: 'a.md' }, 'maestro:invokeCommand');
		await flush();
		expect(window.maestro.dataview.readInRoot).not.toHaveBeenCalled();
		expect(window.maestro.dataview.query).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
		expect(guest.send.mock.calls.length).toBe(before);
	});

	it('answers query.dql through the DQL executor, binding `this` to the note or the origin page', async () => {
		const { guest } = await startFrame();
		const result = { kind: 'list', items: ['a'], idMeaning: { type: 'path' }, warnings: [] };
		vi.mocked(window.maestro.dataview.query).mockResolvedValue({
			root: ROOT,
			sshRemoteId: null,
			revision: 1,
			path: 'Notes/Note.md',
			result,
		} as never);

		guestSays(guest, { type: 'query.dql', requestId: 'q-1', source: 'LIST' });
		guestSays(guest, {
			type: 'query.dql',
			requestId: 'q-2',
			source: 'LIST',
			originPath: 'Notes/Other.md',
		});
		await flush();

		expect(window.maestro.dataview.query).toHaveBeenCalledWith({
			filePath: NOTE,
			source: 'LIST',
			agentId: 'agent-1',
		});
		expect(window.maestro.dataview.query).toHaveBeenCalledWith({
			filePath: '/vault/Notes/Other.md',
			source: 'LIST',
			agentId: 'agent-1',
		});
		expect(sentToGuest(guest)).toContainEqual({
			type: 'query.dql.result',
			requestId: 'q-1',
			result,
		});
	});

	it('answers io.load through readInRoot in main, and a failure as request.failed', async () => {
		const { guest } = await startFrame();
		vi.mocked(window.maestro.dataview.readInRoot)
			.mockResolvedValueOnce({ root: ROOT, sshRemoteId: null, path: 'data/a.csv', text: 'x,y' })
			.mockRejectedValueOnce(new Error('Dataview: escape.md resolves outside /vault'));

		guestSays(guest, { type: 'io.load', requestId: 'q-1', path: './data/a.csv' });
		guestSays(guest, { type: 'io.load', requestId: 'q-2', path: 'escape.md' });
		await flush();

		expect(window.maestro.dataview.readInRoot).toHaveBeenCalledWith({
			filePath: NOTE,
			agentId: 'agent-1',
			path: 'data/a.csv',
		});
		const replies = sentToGuest(guest);
		expect(replies).toContainEqual({ type: 'io.load.result', requestId: 'q-1', text: 'x,y' });
		expect(replies).toContainEqual(
			expect.objectContaining({ type: 'request.failed', requestId: 'q-2' })
		);
	});

	it('refuses requests once the run is over, without asking main', async () => {
		const { guest, run } = await startFrame();
		guestSays(guest, done(run));
		guestSays(guest, { type: 'io.load', requestId: 'late', path: 'data/a.csv' });
		await flush();
		expect(window.maestro.dataview.readInRoot).not.toHaveBeenCalled();
		expect(sentToGuest(guest)).toContainEqual(
			expect.objectContaining({ type: 'request.failed', requestId: 'late' })
		);
	});

	it('keeps at most a few requests in flight, and starts the next as one finishes', async () => {
		const { guest } = await startFrame();
		const pending: Array<(value: unknown) => void> = [];
		vi.mocked(window.maestro.dataview.query).mockImplementation(
			() => new Promise((resolve) => pending.push(resolve as (value: unknown) => void))
		);
		for (let i = 0; i < DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT + 2; i++) {
			guestSays(guest, { type: 'query.dql', requestId: `q-${i}`, source: 'LIST' });
		}
		await flush();
		expect(window.maestro.dataview.query).toHaveBeenCalledTimes(DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT);

		pending[0]({ result: { kind: 'error', message: 'x' } });
		await flush();
		expect(window.maestro.dataview.query).toHaveBeenCalledTimes(
			DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT + 1
		);
	});

	it('refuses what is still waiting in line when the run ends', async () => {
		const { guest, run } = await startFrame();
		vi.mocked(window.maestro.dataview.query).mockImplementation(() => new Promise(() => {}));
		for (let i = 0; i < DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT + 1; i++) {
			guestSays(guest, { type: 'query.dql', requestId: `q-${i}`, source: 'LIST' });
		}
		guestSays(guest, done(run));
		await flush();
		expect(window.maestro.dataview.query).toHaveBeenCalledTimes(DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT);
		expect(sentToGuest(guest)).toContainEqual(
			expect.objectContaining({
				type: 'request.failed',
				requestId: `q-${DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT}`,
			})
		);
	});

	it('opens a vault link through the document scope and a URL through openUrl', async () => {
		const { guest, doc } = await startFrame();
		guestSays(guest, { type: 'open.link', kind: 'file', path: 'Notes/Other.md', newTab: true });
		guestSays(guest, {
			type: 'open.link',
			kind: 'url',
			url: 'https://example.com/a',
			newTab: false,
		});
		expect(doc.openLink).toHaveBeenCalledWith('/vault/Notes/Other.md', { openInNewTab: true });
		expect(openUrl).toHaveBeenCalledWith('https://example.com/a', { ctrlKey: false });
	});

	it('toggles a task with the routing DataviewBlock uses, and runs again when nothing was written', async () => {
		const { guest, doc } = await startFrame();
		guestSays(guest, { type: 'toggle.task', path: 'Notes/Other.md', line: 4, text: 'ship it' });
		await flush();
		expect(toggleDataviewResultTask).toHaveBeenCalledWith(
			doc.toggleOwnTask,
			expect.objectContaining({ root: ROOT, sshRemoteId: null, path: 'Notes/Note.md' }),
			{ path: 'Notes/Other.md', line: 4, text: 'ship it' }
		);
		expect(runs(guest)).toHaveLength(1);

		vi.mocked(toggleDataviewResultTask).mockResolvedValueOnce(false);
		guestSays(guest, { type: 'toggle.task', path: 'Notes/Note.md', line: 2, text: 'x' });
		await flush();
		expect(runs(guest)).toHaveLength(2);
	});
});
