/**
 * DataviewJS end to end over the fixture vault's `Scripts/JS Demo.md` (D4, D5, DV-11): every `dataviewjs`
 * block of the note mounts a `DataviewJsFrame`, and every `<webview>` the frames mount is backed by the real
 * guest runtime (`createDataviewGuest()`) under jsdom. The bridge between them is the one Electron provides:
 * the host's `webview.send()` reaches `guest.receive()`, and what the guest sends comes back as an
 * `ipc-message` event on the tag. Main is mocked with the shared executor and the fixture files, so
 * `dataview:jsSnapshot`, `query`, and `readInRoot` answer as `DataviewService` would.
 *
 * The infinite loop. jsdom runs guest scripts on the test's own thread, so a real `while (true) {}` would
 * hang the test rather than one guest process. The test models the spinning guest as what the host sees of
 * it: a guest that took the run and never answers. The watchdog and the replacement guest are the real ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { DataviewJsFrame } from '../../../renderer/components/Markdown/components/DataviewJsFrame';
import type { DataviewDocumentScope } from '../../../renderer/components/Markdown/components/DataviewDocumentContext';
import {
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	PageIndex,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	executeDql,
	extractDataviewBlocks,
	type DataviewChangeEvent,
} from '../../../shared/dataview';
import { createDataviewGuest } from '../../../renderer/dataview-sandbox/guestRuntime';
import { OBSIDIAN_API_UNAVAILABLE } from '../../../renderer/dataview-sandbox/dvApi';
import { DATAVIEW_REFRESH_DEBOUNCE_MS } from '../../../renderer/hooks/file/useLiveDataviewResult';
import { resetDataviewJsGuestSlotsForTests } from '../../../renderer/services/dataviewJsGuestSlots';
import { fixtureSnapshot, fixtureText } from '../../helpers/dataviewFixtureVault';
import { dataviewGuestRealm } from '../../helpers/dataviewGuestRealm';
import { mockTheme } from '../../helpers/mockTheme';

const ROOT = '/vault';
const NOTE_PATH = 'Scripts/JS Demo.md';
const LOOP_SOURCE = 'while (true) {}';

/** The note's `dataviewjs` blocks, with a script that never ends placed second in the same document. */
function demoSources(): string[] {
	const sources = extractDataviewBlocks(fixtureText(NOTE_PATH))
		.filter((block) => block.language === 'dataviewjs')
		.map((block) => block.source);
	expect(sources).toHaveLength(4);
	return [sources[0], LOOP_SOURCE, ...sources.slice(1)];
}

/** Block positions in {@link demoSources}. */
const TABLE = 0;
const LOOP = 1;
const OBSIDIAN_APP = 2;
const VIEW = 3;
const CSV = 4;

type GuestWebview = HTMLElement & { send: (channel: string, message: unknown) => void };

interface WiredGuest {
	/** Where this guest draws its blocks: the guest page's body. */
	root: HTMLElement;
	/** Every `run` the host sent to this guest, by source. */
	runs: string[];
}

let revision = 1;
let emitChange: (event: DataviewChangeEvent) => void = () => {};
const guests = new Map<Element, WiredGuest>();

function snapshotResponse() {
	return {
		root: ROOT,
		sshRemoteId: null,
		revision,
		path: NOTE_PATH,
		result: fixtureSnapshot(revision),
	};
}

/** Main's side of the bridge, over the fixture vault. */
function mockMain() {
	const snapshot = fixtureSnapshot();
	const hostIndex = PageIndex.fromSnapshot(snapshot, async (relPath) => fixtureText(relPath));
	vi.mocked(window.maestro.dataview.jsSnapshot).mockImplementation(async () => snapshotResponse());
	vi.mocked(window.maestro.dataview.query).mockImplementation(async ({ filePath, source }) => {
		const thisPath = filePath.slice(ROOT.length + 1);
		return {
			root: ROOT,
			sshRemoteId: null,
			revision,
			path: thisPath,
			result: await executeDql(source, thisPath, hostIndex),
		} as never;
	});
	vi.mocked(window.maestro.dataview.readInRoot).mockImplementation(async ({ path }) => ({
		root: ROOT,
		sshRemoteId: null,
		path,
		text: snapshot.files.includes(path) ? fixtureText(path) : null,
	}));
	vi.mocked(window.maestro.dataview.onChanged).mockImplementation((handler) => {
		emitChange = handler;
		return () => {};
	});
}

/**
 * Back every `<webview>` not yet wired with a real guest, then raise `dom-ready` on it. A guest spinning on
 * {@link LOOP_SOURCE} takes the run and stays silent (see the file comment).
 */
function wireGuests(container: HTMLElement): void {
	for (const element of container.querySelectorAll('webview')) {
		if (guests.has(element)) continue;
		const webview = element as GuestWebview;
		const root = document.createElement('div');
		document.body.append(root);
		const wired: WiredGuest = { root, runs: [] };
		guests.set(element, wired);
		const guest = createDataviewGuest({
			document,
			root,
			scriptGlobal: dataviewGuestRealm(),
			send: (message) => {
				const event = new Event('ipc-message');
				Object.assign(event, { channel: SANDBOX_TO_HOST_CHANNEL, args: [message] });
				webview.dispatchEvent(event);
			},
		});
		webview.send = (channel, message) => {
			if (channel !== SANDBOX_TO_GUEST_CHANNEL) return;
			const { type, source } = message as { type: string; source?: string };
			if (type === 'run') wired.runs.push(source ?? '');
			if (type === 'run' && source === LOOP_SOURCE) return;
			void guest.receive(message);
		};
		act(() => {
			webview.dispatchEvent(new Event('dom-ready'));
		});
	}
}

/** Let snapshots, runs, and guest requests settle (a few milliseconds of fake time, far below the watchdog). */
async function settle(container: HTMLElement): Promise<void> {
	for (let step = 0; step < 40; step++) {
		wireGuests(container);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
	}
}

function frames(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>('[data-dataview-js-block]'));
}

function webviewOf(frame: HTMLElement): Element {
	const element = frame.querySelector('webview');
	if (!element) throw new Error('the block has no guest');
	return element;
}

/** The guest page output of one block. */
function outputOf(frame: HTMLElement): HTMLElement {
	return guests.get(webviewOf(frame))!.root;
}

function rowTexts(output: HTMLElement): string[][] {
	return Array.from(output.querySelectorAll('tbody tr'), (row) =>
		Array.from(row.querySelectorAll('td'), (cell) => cell.textContent ?? '')
	);
}

const doc: DataviewDocumentScope = {
	filePath: `${ROOT}/${NOTE_PATH}`,
	agentId: 'agent-1',
	openLink: vi.fn(),
	toggleOwnTask: vi.fn(async () => true),
};

function Note({ sources }: { sources: string[] }) {
	return (
		<div>
			{sources.map((code, index) => (
				<DataviewJsFrame key={index} code={code} theme={mockTheme} doc={doc} />
			))}
		</div>
	);
}

const MEETING_ROWS = [
	['2026-09-20 Unrelated', 'September 20, 2026'],
	['Standup', 'September 10, 2026'],
	['2026-09-01 Kickoff', 'September 01, 2026'],
];

/** The output of every block that runs to the end, as it must look after each run. */
function expectHealthyBlocks(all: HTMLElement[]): void {
	const table = outputOf(all[TABLE]);
	expect(table.querySelectorAll('th.table-view-th')[0].textContent).toContain('Meeting');
	expect(rowTexts(table)).toEqual(MEETING_ROWS);

	const appProblem = all[OBSIDIAN_APP].querySelector('[data-dataview-js-problem="script"]');
	expect(appProblem?.textContent).toMatch(/^Evaluation Error: /);
	expect(appProblem?.textContent).toContain(OBSIDIAN_API_UNAVAILABLE);
	expect(outputOf(all[OBSIDIAN_APP]).textContent).toBe('');

	const view = outputOf(all[VIEW]);
	expect(view.querySelector('h3')!.textContent).toBe('People');
	expect(view.querySelector('div.sample-view')!.textContent).toBe(
		'Rendered by views/sample/view.js'
	);
	expect(view.querySelector('style')!.textContent).toContain('.sample-view');
	expect(view.querySelectorAll('ul.list-view-ul > li')).toHaveLength(4);

	expect(rowTexts(outputOf(all[CSV]))).toEqual([
		['Rami Example', 'Example Corp'],
		['Dana Sample', 'Sample Labs'],
	]);

	for (const index of [TABLE, VIEW, CSV]) {
		expect(all[index].querySelector('[data-dataview-js-problem]'), `block ${index}`).toBeNull();
		expect(all[index].querySelector('[data-dataview-placeholder]'), `block ${index}`).toBeNull();
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	// No IntersectionObserver: every block counts as near the viewport and asks for a guest at once.
	vi.stubGlobal('IntersectionObserver', undefined);
	resetDataviewJsGuestSlotsForTests();
	revision = 1;
	guests.clear();
	mockMain();
});

afterEach(() => {
	for (const { root } of guests.values()) root.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('DataviewJS over Scripts/JS Demo.md', () => {
	it('renders every block, stops the infinite loop at the watchdog, and keeps the rest rendering', async () => {
		const sources = demoSources();
		const view = render(<Note sources={sources} />);
		await settle(view.container);

		const all = frames(view.container);
		expect(all).toHaveLength(sources.length);
		expectHealthyBlocks(all);
		// dv.view loaded the view's script and its CSS through main's readInRoot.
		const reads = vi.mocked(window.maestro.dataview.readInRoot).mock.calls.map(([req]) => req.path);
		expect(reads).toEqual(
			expect.arrayContaining(['views/sample/view.js', 'views/sample/view.css', 'data/people.csv'])
		);
		// The CSS stays inside the guest page; the host document carries none of it.
		for (const frame of all) expect(frame.querySelector('style')).toBeNull();

		// The loop has not answered: its block waits, and nothing else is stopped.
		const loopGuest = webviewOf(all[LOOP]);
		expect(all[LOOP].querySelector('[data-dataview-placeholder]')).not.toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DATAVIEW_JS_RUN_TIMEOUT_MS);
		});
		expect(all[LOOP].textContent).toContain('did not finish within 5 seconds');
		await settle(view.container);

		// The looping guest is gone and a new one stands in its place, idle until asked.
		const replacement = webviewOf(all[LOOP]);
		expect(replacement).not.toBe(loopGuest);
		expect(loopGuest.isConnected).toBe(false);
		expect(guests.get(replacement)!.runs).toEqual([]);

		// The other blocks keep their guests and their output.
		expectHealthyBlocks(all);

		// A vault change runs every live block again, and they still render; the stopped block stays stopped.
		const runsBefore = all.map((frame) => guests.get(webviewOf(frame))!.runs.length);
		revision = 2;
		act(() => emitChange({ root: ROOT, sshRemoteId: null, revision, changedPaths: [NOTE_PATH] }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DATAVIEW_REFRESH_DEBOUNCE_MS + 10);
		});
		await settle(view.container);
		const runsAfter = all.map((frame) => guests.get(webviewOf(frame))!.runs.length);
		expect(runsAfter[LOOP]).toBe(runsBefore[LOOP]);
		for (const index of [TABLE, OBSIDIAN_APP, VIEW, CSV]) {
			expect(runsAfter[index], `block ${index}`).toBe(runsBefore[index] + 1);
		}
		expectHealthyBlocks(all);
		expect(all[LOOP].textContent).toContain('did not finish within 5 seconds');

		// Fixing the script runs it in the recreated guest.
		const fixed = [...sources];
		fixed[LOOP] = "dv.paragraph('recovered');";
		view.rerender(<Note sources={fixed} />);
		await settle(view.container);
		expect(webviewOf(all[LOOP])).toBe(replacement);
		expect(guests.get(replacement)!.runs).toEqual(["dv.paragraph('recovered');"]);
		expect(outputOf(all[LOOP]).querySelector('p')!.textContent).toBe('recovered');
		expect(all[LOOP].querySelector('[data-dataview-js-problem]')).toBeNull();
		expectHealthyBlocks(all);
	});
});
