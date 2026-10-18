import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	home: '',
	accountDir: undefined as string | undefined,
	sessions: [] as Array<Record<string, unknown>>,
}));

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	const homedir = () => state.home;
	return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../main/agents/provider-account-dirs', () => ({
	resolveAgentAccountDir: () => state.accountDir,
}));
vi.mock('../../main/stores/instances', () => ({ isInitialized: () => true }));
vi.mock('../../main/stores/getters', () => ({
	getSessionsStore: () => ({ get: () => state.sessions }),
}));

import {
	buildCodexVisualizationDocument,
	defaultVisualizationTitle,
	findVisualizeAssetsDir,
	loadCodexVisualization,
} from '../../main/codex-visualization';
import {
	clearConcertoHtmlDocumentsForTests,
	getConcertoHtmlDocumentBody,
} from '../../main/concerto-html';

const ASSETS = {
	stylesheet: '.kit{color:red}',
	kit: '<div class="kit"><!--__INLINE_VISUALIZATION_FRAGMENT__--></div><script>kit()</script>',
	hostBridge: 'bridge("</script>")',
	calendar: 'calendar()',
};

function writeAssets(codexHome: string, version: string): string {
	const dir = path.join(
		codexHome,
		'plugins',
		'cache',
		'openai-bundled',
		'visualize',
		version,
		'skills',
		'visualize',
		'assets'
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'visualize.css'), ASSETS.stylesheet);
	fs.writeFileSync(path.join(dir, 'visualize.html'), ASSETS.kit);
	fs.writeFileSync(path.join(dir, 'standalone-host-bridge.js'), ASSETS.hostBridge);
	fs.writeFileSync(path.join(dir, 'calendar.js'), ASSETS.calendar);
	return dir;
}

describe('buildCodexVisualizationDocument', () => {
	it('places the fragment in the kit and reports non-persistent widget state', () => {
		const html = buildCodexVisualizationDocument('<p id="x">hi</p>', 'Chart', ASSETS);
		expect(html).toContain('<div class="kit"><p id="x">hi</p></div>');
		expect(html).toContain('<title>Chart</title>');
		expect(html).toContain('{"widgetState":null,"statePersistence":"none"}');
		expect(html).toContain('<style>.kit{color:red}');
	});

	it('cannot be broken out of by a script body or a $ pattern in the fragment', () => {
		const html = buildCodexVisualizationDocument("<p>$& $' $1</p>", 'T', ASSETS);
		expect(html).toContain("<p>$& $' $1</p>");
		expect(html).toContain('bridge("<\\/script>")');
	});

	it('includes the calendar element only when the fragment uses it', () => {
		expect(buildCodexVisualizationDocument('<p></p>', 'T', ASSETS)).not.toContain('calendar()');
		expect(buildCodexVisualizationDocument('<viz-calendar></viz-calendar>', 'T', ASSETS)).toContain(
			'calendar()'
		);
	});

	it('escapes the title', () => {
		expect(buildCodexVisualizationDocument('', '<b>&', ASSETS)).toContain(
			'<title>&lt;b&gt;&amp;</title>'
		);
	});
});

describe('defaultVisualizationTitle', () => {
	it('titles a file the way render.py does', () => {
		expect(defaultVisualizationTitle('/a/dropdown-hints.html')).toBe('Dropdown Hints');
		expect(defaultVisualizationTitle('/a/my_chart.html')).toBe('My Chart');
	});
});

describe('loadCodexVisualization', () => {
	let root: string;
	let fragment: string;

	beforeEach(() => {
		clearConcertoHtmlDocumentsForTests();
		root = fs.mkdtempSync(path.join(tmpdir(), 'codex-viz-'));
		state.home = path.join(root, 'home');
		state.accountDir = path.join(root, 'codex-account');
		state.sessions = [{ id: 'agent-1', toolType: 'codex' }];
		fragment = path.join(root, 'chart.html');
		fs.writeFileSync(fragment, '<div id="chart">bars</div>');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("picks the newest plugin version in the agent's own CODEX_HOME", async () => {
		writeAssets(state.accountDir!, '1.0.9');
		const newest = writeAssets(state.accountDir!, '1.0.46');
		expect(await findVisualizeAssetsDir(state.accountDir!)).toBe(newest);
	});

	it('registers the built document and returns its id and revision', async () => {
		writeAssets(state.accountDir!, '1.0.46');
		const result = await loadCodexVisualization({ sessionId: 'agent-1', path: fragment });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const body = getConcertoHtmlDocumentBody('visualization', result.id);
		expect(body).toContain('<div id="chart">bars</div>');
		expect(body).toContain('<title>Chart</title>');

		const again = await loadCodexVisualization({ sessionId: 'agent-1', path: fragment });
		expect(again).toEqual(result);
	});

	it('falls back to the default Codex home', async () => {
		writeAssets(path.join(state.home, '.codex'), '1.0.46');
		state.accountDir = undefined;
		expect((await loadCodexVisualization({ path: fragment })).ok).toBe(true);
	});

	it('refuses an SSH agent', async () => {
		writeAssets(state.accountDir!, '1.0.46');
		state.sessions = [
			{ id: 'agent-1', toolType: 'codex', sessionSshRemoteConfig: { enabled: true } },
		];
		expect(await loadCodexVisualization({ sessionId: 'agent-1', path: fragment })).toMatchObject({
			ok: false,
			reason: 'remote',
		});
	});

	it('reports a missing plugin, a missing file, and a full document', async () => {
		expect(await loadCodexVisualization({ sessionId: 'agent-1', path: fragment })).toMatchObject({
			ok: false,
			reason: 'no-runtime',
		});

		writeAssets(state.accountDir!, '1.0.46');
		expect(
			await loadCodexVisualization({ sessionId: 'agent-1', path: path.join(root, 'gone.html') })
		).toMatchObject({ ok: false, reason: 'not-found' });

		fs.writeFileSync(fragment, '<!doctype html><html><body></body></html>');
		expect(await loadCodexVisualization({ sessionId: 'agent-1', path: fragment })).toMatchObject({
			ok: false,
			reason: 'invalid',
		});

		expect(await loadCodexVisualization({ path: 'relative.html' })).toMatchObject({
			ok: false,
			reason: 'invalid',
		});
	});
});
