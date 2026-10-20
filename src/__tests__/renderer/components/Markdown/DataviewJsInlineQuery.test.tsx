/**
 * Inline `` `$= expr` `` spans (DV-11, DV-12, DV-14, DEV-5): the span follows the note's DataviewJS policy like a
 * block does, and in a trusted vault every span of the note is evaluated in ONE hidden guest
 * (`DataviewJsInlineHost`), driven here the way Electron would drive the `<webview>` (dom-ready, ipc-message).
 * Covers the values and errors a span shows, the per-expression watchdog, and the refresh on `dataview:changed`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DataviewDocumentProvider } from '../../../../renderer/components/Markdown/components/DataviewDocumentProvider';
import {
	DataviewJsInlineQuery,
	parseDataviewJsInlineQuery,
} from '../../../../renderer/components/Markdown/components/DataviewJsInlineQuery';
import { DataviewJsInlineStore } from '../../../../renderer/components/Markdown/components/DataviewJsInlineHost';
import { DATAVIEW_JS_DESKTOP_ONLY_TEXT } from '../../../../renderer/components/Markdown/components/DataviewJsBlock';
import type { DataviewDocumentScope } from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import {
	DATAVIEW_GUEST_URL,
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	dataviewGuestPartition,
	type DataviewChangeEvent,
	type SandboxIndexSnapshot,
} from '../../../../shared/dataview';
import { DATAVIEW_REFRESH_DEBOUNCE_MS } from '../../../../renderer/hooks/file/useLiveDataviewResult';
import { resetDataviewJsGuestSlotsForTests } from '../../../../renderer/services/dataviewJsGuestSlots';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: vi.fn(() => false) }));

const ROOT = '/vault';
const NOTE = '/vault/Notes/Note.md';

function snapshotResponse(revision = 1) {
	const result: SandboxIndexSnapshot = {
		revision,
		files: ['Notes/Note.md'],
		folders: ['Notes'],
		stars: [],
		pages: [],
	};
	return { root: ROOT, sshRemoteId: null, revision, path: 'Notes/Note.md', result };
}

function scope(): DataviewDocumentScope {
	return { filePath: NOTE, agentId: 'agent-1', openLink: vi.fn() };
}

function Span({ expression }: { expression: string }) {
	return (
		<DataviewJsInlineQuery
			expression={expression}
			theme={mockTheme}
			fallback={<code data-testid={`code:${expression}`}>{`$= ${expression}`}</code>}
		/>
	);
}

function renderNote(expressions: string[], doc: DataviewDocumentScope | null = scope()) {
	return render(
		<DataviewDocumentProvider value={doc}>
			<p>
				{expressions.map((expression, index) => (
					<Span key={index} expression={expression} />
				))}
			</p>
		</DataviewDocumentProvider>
	);
}

// --- The guest element --------------------------------------------------------------------------------

type FakeGuest = HTMLElement & { send: ReturnType<typeof vi.fn> };

async function flush() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
}

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

function guestSays(guest: Element, message: unknown) {
	act(() => {
		const event = new Event('ipc-message');
		Object.assign(event, { channel: SANDBOX_TO_HOST_CHANNEL, args: [message] });
		guest.dispatchEvent(event);
	});
}

interface SentEval {
	type: 'eval';
	runId: string;
	thisPath: string;
	snapshot: SandboxIndexSnapshot;
	expressions: { id: string; source: string }[];
}

function evals(guest: FakeGuest): SentEval[] {
	return guest.send.mock.calls
		.filter((call) => call[0] === SANDBOX_TO_GUEST_CHANNEL && call[1]?.type === 'eval')
		.map((call) => call[1] as SentEval);
}

function lastEval(guest: FakeGuest): SentEval {
	const all = evals(guest);
	return all[all.length - 1];
}

function answer(guest: Element, run: SentEval, id: string, outcome: unknown) {
	guestSays(guest, { type: 'eval.result', runId: run.runId, id, outcome });
}

async function startNote(expressions: string[]) {
	const view = renderNote(expressions);
	const guest = await mountedGuest(view.container);
	domReady(guest);
	await flush();
	return { view, guest, run: lastEval(guest) };
}

function setSettings(settings: { js?: boolean; trusted?: string[] }) {
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, dataview: true },
		dataviewJsEnabled: settings.js ?? true,
		dataviewJsTrustedRoots: settings.trusted ?? [ROOT],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	clearCachedResources();
	resetDataviewJsGuestSlotsForTests();
	vi.mocked(isWebDesktop).mockReturnValue(false);
	vi.mocked(window.maestro.dataview.jsRoot).mockResolvedValue({ root: ROOT, sshRemoteId: null });
	vi.mocked(window.maestro.dataview.jsRunOnce).mockResolvedValue({ root: ROOT, sshRemoteId: null });
	vi.mocked(window.maestro.dataview.jsSnapshot).mockResolvedValue(snapshotResponse());
	setSettings({});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('parseDataviewJsInlineQuery', () => {
	it('claims `$=` spans with an expression only', () => {
		expect(parseDataviewJsInlineQuery('$= dv.current().file.name')).toBe('dv.current().file.name');
		expect(parseDataviewJsInlineQuery('$=   ')).toBeNull();
		expect(parseDataviewJsInlineQuery('= this.file.name')).toBeNull();
		expect(parseDataviewJsInlineQuery('x $= 1')).toBeNull();
	});
});

describe('DataviewJsInlineQuery: policy', () => {
	it('stays plain code, with no guest, outside a Dataview surface and while DataviewJS is off', async () => {
		const outside = renderNote(['1 + 1'], null);
		expect(screen.getByTestId('code:1 + 1')).toBeTruthy();
		outside.unmount();

		setSettings({ js: false });
		const { container } = renderNote(['1 + 1']);
		await flush();
		expect(screen.getByTestId('code:1 + 1')).toBeTruthy();
		expect(container.querySelector('webview')).toBeNull();
		expect(window.maestro.dataview.jsRoot).not.toHaveBeenCalled();
		expect(window.maestro.dataview.jsSnapshot).not.toHaveBeenCalled();
	});

	it('shows the code and the desktop-only pill in the browser build', async () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		const { container } = renderNote(['1 + 1']);
		await flush();
		expect(screen.getByTestId('code:1 + 1')).toBeTruthy();
		expect(screen.getByText(DATAVIEW_JS_DESKTOP_ONLY_TEXT)).toBeTruthy();
		expect(container.querySelector('webview')).toBeNull();
		expect(window.maestro.dataview.jsSnapshot).not.toHaveBeenCalled();
	});

	it('asks in an untrusted vault, and Run grants this session and evaluates the span', async () => {
		setSettings({ trusted: [] });
		const view = renderNote(['1 + 1']);
		const run = await screen.findByRole('button', { name: 'Run' });
		expect(view.container.querySelector('webview')).toBeNull();
		expect(window.maestro.dataview.jsSnapshot).not.toHaveBeenCalled();

		fireEvent.click(run);
		await flush();
		expect(window.maestro.dataview.jsRunOnce).toHaveBeenCalledWith({
			agentId: 'agent-1',
			filePath: NOTE,
		});
		const guest = await mountedGuest(view.container);
		domReady(guest);
		await flush();
		answer(guest, lastEval(guest), 'expr-1', { kind: 'value', value: 2 });
		expect(view.container.querySelector('[data-dataview-js-inline]')?.textContent).toBe('2');
	});
});

describe('DataviewJsInlineQuery: the note guest', () => {
	it('mounts no guest for a note without $= spans', async () => {
		const view = renderNote([]);
		await flush();
		expect(view.container.querySelector('webview')).toBeNull();
		expect(window.maestro.dataview.jsSnapshot).not.toHaveBeenCalled();
	});

	it('evaluates every span of the note in one hidden guest, in order, and renders the values', async () => {
		const { view, guest, run } = await startNote(['1 + 1', 'dv.current().file.name', '1 + 1']);
		expect(view.container.querySelectorAll('webview')).toHaveLength(1);
		expect(guest.getAttribute('partition')).toBe(dataviewGuestPartition(ROOT, null));
		expect(guest.getAttribute('src')).toBe(DATAVIEW_GUEST_URL);
		expect(guest.closest('[aria-hidden="true"]')).not.toBeNull();
		// Two spans with the same expression share one evaluation.
		expect(run).toMatchObject({
			thisPath: 'Notes/Note.md',
			expressions: [
				{ id: 'expr-1', source: '1 + 1' },
				{ id: 'expr-2', source: 'dv.current().file.name' },
			],
		});

		answer(guest, run, 'expr-1', { kind: 'value', value: 2 });
		answer(guest, run, 'expr-2', { kind: 'value', value: 'Note' });
		const shown = Array.from(view.container.querySelectorAll('[data-dataview-js-inline]'), (el) =>
			el.textContent?.trim()
		);
		expect(shown).toEqual(['2', 'Note', '2']);
		expect(evals(guest)).toHaveLength(1);
	});

	it('renders links through the DQL value renderer, nothing for undefined, and upstream error text', async () => {
		const { view, guest, run } = await startNote(['dv.current().file.link', 'undefined', 'boom()']);
		answer(guest, run, 'expr-1', {
			kind: 'value',
			value: {
				'___transfer-type': 'link',
				value: { path: 'Notes/Note.md', type: 'file', embed: false },
			},
		});
		answer(guest, run, 'expr-2', { kind: 'empty' });
		answer(guest, run, 'expr-3', { kind: 'error', message: 'ReferenceError: boom is not defined' });

		const spans = view.container.querySelectorAll('[data-dataview-js-inline]');
		expect(spans[0].querySelector('a')).not.toBeNull();
		expect(spans[1].textContent).toBe('');
		expect(
			screen.getByText(
				"Dataview (for inline JS query 'boom()'): ReferenceError: boom is not defined"
			)
		).toBeTruthy();
	});

	it('ignores an answer out of order, for another run, or that the protocol refuses', async () => {
		const { view, guest, run } = await startNote(['1', '2']);
		answer(guest, run, 'expr-2', { kind: 'value', value: 'early' });
		answer(guest, { ...run, runId: 'inline-run-999' }, 'expr-1', { kind: 'value', value: 'other' });
		answer(guest, run, 'expr-1', { kind: 'html' });
		expect(view.container.querySelector('[data-dataview-js-inline]')).toBeNull();
		answer(guest, run, 'expr-1', { kind: 'value', value: 'one' });
		expect(view.container.querySelector('[data-dataview-js-inline]')?.textContent).toBe('one');
	});

	it('answers dv.query through the DQL executor while the run is in flight', async () => {
		vi.mocked(window.maestro.dataview.query).mockResolvedValue({
			root: ROOT,
			sshRemoteId: null,
			revision: 1,
			path: 'Notes/Note.md',
			result: { kind: 'list', items: [], warnings: [], idMeaning: { type: 'path' } },
		} as never);
		const { guest } = await startNote(['await dv.query("LIST")']);
		guestSays(guest, { type: 'query.dql', requestId: 'q1', source: 'LIST' });
		await flush();
		expect(window.maestro.dataview.query).toHaveBeenCalledWith({
			filePath: NOTE,
			source: 'LIST',
			agentId: 'agent-1',
		});
		expect(guest.send).toHaveBeenCalledWith(
			SANDBOX_TO_GUEST_CHANNEL,
			expect.objectContaining({ type: 'query.dql.result', requestId: 'q1' })
		);
	});

	it("shows main's refusal of the snapshot on every span", async () => {
		vi.mocked(window.maestro.dataview.jsSnapshot).mockRejectedValue(
			new Error('DataviewJS is not trusted in /vault')
		);
		const view = renderNote(['1', '2']);
		await flush();
		expect(view.container.querySelector('webview')).toBeNull();
		expect(screen.getAllByText(/DataviewJS is not trusted in \/vault/)).toHaveLength(2);
	});
});

describe('DataviewJsInlineQuery: watchdog and refresh', () => {
	it('stops the expression that runs past 5 s, replaces the guest, and evaluates the rest there', async () => {
		vi.useFakeTimers();
		const { view, guest, run } = await startNote(['1', 'while (true) {}', '3']);
		answer(guest, run, 'expr-1', { kind: 'value', value: 'one' });
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
		domReady(replacement);
		await flush();
		// Only the expression the old guest never reached runs again; the looping one stays stopped.
		const retry = lastEval(replacement);
		expect(retry.expressions.map((e) => e.source)).toEqual(['3']);
		answer(replacement, retry, retry.expressions[0].id, { kind: 'value', value: 'three' });
		const shown = Array.from(view.container.querySelectorAll('[data-dataview-js-inline]'), (el) =>
			el.textContent?.trim()
		);
		expect(shown).toEqual(['one', 'three']);
		expect(screen.getByText(/did not finish within 5 seconds/)).toBeTruthy();
	});

	it('evaluates every span again after a change to its root, debounced, keeping the old values meanwhile', async () => {
		let emit: (event: DataviewChangeEvent) => void = () => {};
		vi.mocked(window.maestro.dataview.onChanged).mockImplementation((handler) => {
			emit = handler;
			return () => {};
		});
		const { view, guest, run } = await startNote(['dv.pages().length']);
		answer(guest, run, 'expr-1', { kind: 'value', value: 4 });
		vi.useFakeTimers();
		vi.mocked(window.maestro.dataview.jsSnapshot).mockResolvedValue(snapshotResponse(2));

		act(() => emit({ root: '/elsewhere', sshRemoteId: null, revision: 9, changedPaths: [] }));
		act(() => emit({ root: ROOT, sshRemoteId: null, revision: 2, changedPaths: ['a.md'] }));
		act(() => emit({ root: ROOT, sshRemoteId: null, revision: 2, changedPaths: ['a.md'] }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DATAVIEW_REFRESH_DEBOUNCE_MS + 10);
		});
		expect(window.maestro.dataview.jsSnapshot).toHaveBeenCalledTimes(2);
		expect(evals(guest)).toHaveLength(2);
		const refresh = lastEval(guest);
		expect(refresh).toMatchObject({ snapshot: { revision: 2 } });
		expect(view.container.querySelector('[data-dataview-js-inline]')?.textContent).toBe('4');

		answer(guest, refresh, 'expr-1', { kind: 'value', value: 5 });
		expect(view.container.querySelector('[data-dataview-js-inline]')?.textContent).toBe('5');
	});
});

describe('DataviewJsInlineStore', () => {
	it('shares an entry per expression, drops it with its last span, and keeps a halted one out of runs', () => {
		const store = new DataviewJsInlineStore();
		const releaseA = store.register('x');
		const releaseB = store.register('x');
		store.register('y');
		expect(store.pending().map((p) => p.expression)).toEqual(['x', 'y']);

		const [x, y] = store.pending();
		store.resolve('x', { kind: 'empty' }, x.ticket);
		store.resolve('y', { kind: 'problem', message: 'stopped' }, y.ticket, true);
		expect(store.pending()).toEqual([]);

		store.invalidate();
		expect(store.pending().map((p) => p.expression)).toEqual(['x']);
		expect(store.outcome('x')).toEqual({ kind: 'empty' });

		releaseA();
		expect(store.size).toBe(2);
		releaseB();
		expect(store.size).toBe(1);
		expect(store.outcome('x')).toBeNull();
	});

	it('wants a new evaluation when the index changes during one, so a stale answer does not settle it', () => {
		const store = new DataviewJsInlineStore();
		store.register('x');
		const [first] = store.pending();
		store.invalidate();
		store.resolve('x', { kind: 'empty' }, first.ticket);
		expect(store.pending().map((p) => p.expression)).toEqual(['x']);
	});
});

describe('DataviewJsInlineQuery: loading', () => {
	it('keeps the source in place, dimmed, until the first answer', async () => {
		const { view } = await startNote(['1']);
		await waitFor(() =>
			expect(view.container.querySelector('[data-dataview-inline-placeholder]')).not.toBeNull()
		);
		expect(screen.getByTestId('code:1')).toBeTruthy();
	});
});
