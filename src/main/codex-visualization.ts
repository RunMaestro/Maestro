/**
 * Codex `visualize` content references, rendered inline.
 *
 * Codex's bundled `visualize` plugin (OpenAI, `openai-bundled/visualize`) has
 * the model write an HTML FRAGMENT to disk and then emit
 * `U+E200 visualize U+E202 {"path": ...} U+E201` in its reply. The Codex app
 * wraps that fragment in the skill's own stylesheet, component kit, and host
 * bridge, and runs it in a sandboxed frame.
 *
 * This is the same wrapping, done the way the skill's `scripts/render.py` does
 * it: the assets are read from the user's OWN Codex install at render time,
 * never shipped with Maestro (they are OpenAI's, and they move with the plugin
 * version the model was prompted against). The result is registered as a
 * Concerto document on the `visualization` surface, which serves it under its
 * own scheme and CSP - see `CODEX_VISUALIZATION_CSP`.
 *
 * Local agents only. An SSH agent's fragment and its Codex install both live on
 * the remote host, and the renderer falls back to the file chip there.
 */

import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveAgentAccountDir } from './agents/provider-account-dirs';
import { registerCodexVisualizationDocument } from './concerto-html';
import { isInitialized } from './stores/instances';
import { getSessionsStore } from './stores/getters';
import type {
	CodexVisualizationLoadRequest,
	CodexVisualizationLoadResult,
} from '../shared/codexVisualization';

/** Same cap as the skill's `render.py`; the skill tells the model about it. */
export const MAX_CODEX_VISUALIZATION_FRAGMENT_BYTES = 1_000_000;

const DOCUMENT_MARKUP = /<!doctype\s|<\s*(?:html|head|body)(?:\s|>)/i;
const FRAGMENT_PLACEHOLDER = '<!--__INLINE_VISUALIZATION_FRAGMENT__-->';
const VISUALIZE_PLUGIN_DIR = path.join('plugins', 'cache', 'openai-bundled', 'visualize');
const ASSETS_SUBDIR = path.join('skills', 'visualize', 'assets');

export interface CodexVisualizationAssets {
	stylesheet: string;
	kit: string;
	hostBridge: string;
	/** Only needed by fragments that use `<viz-calendar>`. */
	calendar: string | null;
}

function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
	const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The newest installed visualize plugin's asset dir under one Codex home. */
export async function findVisualizeAssetsDir(codexHome: string): Promise<string | null> {
	const pluginRoot = path.join(codexHome, VISUALIZE_PLUGIN_DIR);
	let versions: string[];
	try {
		versions = await fsp.readdir(pluginRoot);
	} catch {
		return null;
	}
	for (const version of versions.sort(compareVersions).reverse()) {
		const dir = path.join(pluginRoot, version, ASSETS_SUBDIR);
		try {
			await fsp.access(path.join(dir, 'visualize.css'));
			return dir;
		} catch {
			// Partially extracted or a different layout; try the next version.
		}
	}
	return null;
}

export async function readVisualizeAssets(dir: string): Promise<CodexVisualizationAssets> {
	const read = (name: string) => fsp.readFile(path.join(dir, name), 'utf8');
	const [stylesheet, kit, hostBridge, calendar] = await Promise.all([
		read('visualize.css'),
		read('visualize.html'),
		read('standalone-host-bridge.js'),
		read('calendar.js').catch(() => null),
	]);
	return { stylesheet, kit, hostBridge, calendar };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** A script body that cannot close its own `<script>` element early. */
function inlineScript(source: string): string {
	return `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;
}

/** `dropdown-hints.html` -> `Dropdown Hints`, as `render.py` titles it. */
export function defaultVisualizationTitle(fragmentPath: string): string {
	const stem = path.basename(fragmentPath, path.extname(fragmentPath));
	const words = stem.replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean);
	return (
		words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') ||
		'Visualization'
	);
}

/**
 * The inner frame document `render.py` builds, minus its standalone shell:
 * Maestro's renderer IS the shell, so it answers the bridge's MessageChannel
 * itself. Widget state is reported as non-persistent, which the bridge treats
 * as a normal mode rather than an error.
 *
 * Every substitution uses a function replacer: a fragment is agent-authored
 * and full of `$`, and a string replacer would expand `$&` and `$'` inside it.
 */
export function buildCodexVisualizationDocument(
	fragment: string,
	title: string,
	assets: CodexVisualizationAssets
): string {
	const calendar =
		assets.calendar && /\bviz-calendar\b/i.test(fragment) ? inlineScript(assets.calendar) : '';
	const body = assets.kit.replace(FRAGMENT_PLACEHOLDER, () => calendar + fragment);
	const widgetState = JSON.stringify({ widgetState: null, statePersistence: 'none' }).replace(
		/</g,
		'\\u003c'
	);
	return [
		'<!doctype html>',
		'<html lang="en" data-visualize-standalone>',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="referrer" content="no-referrer">',
		`<title>${escapeHtml(title)}</title>`,
		`<style>${assets.stylesheet.replace(/<\/style/gi, '<\\/style')}\nhtml>body{padding:0}</style>`,
		'</head>',
		'<body>',
		`<script type="application/json" id="codex-visualization-widget-state">${widgetState}</script>`,
		inlineScript(assets.hostBridge),
		body,
		'</body>',
		'</html>',
		'',
	].join('\n');
}

/** Read a fragment under the same rules `render.py` enforces. */
async function readFragment(fragmentPath: string): Promise<string> {
	const stat = await fsp.lstat(fragmentPath);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error('The visualization path is not a regular file');
	}
	if (stat.size > MAX_CODEX_VISUALIZATION_FRAGMENT_BYTES) {
		throw new Error('The visualization exceeds the 1 MB size limit');
	}
	const fragment = await fsp.readFile(fragmentPath, 'utf8');
	if (DOCUMENT_MARKUP.test(fragment)) {
		throw new Error('The visualization is a complete HTML document, not a fragment');
	}
	return fragment;
}

function storedSession(sessionId: string | undefined): Record<string, unknown> | undefined {
	if (!sessionId || !isInitialized()) return undefined;
	const sessions = getSessionsStore().get('sessions', []) as Array<Record<string, unknown>>;
	return sessions.find((s) => s?.id === sessionId);
}

/** The agent's own CODEX_HOME first, then the default, deduplicated. */
function candidateCodexHomes(sessionId: string | undefined): string[] {
	const homes = new Set<string>();
	const own = sessionId ? resolveAgentAccountDir(sessionId) : undefined;
	if (own) homes.add(own);
	homes.add(path.join(os.homedir(), '.codex'));
	return [...homes];
}

export async function loadCodexVisualization(
	request: CodexVisualizationLoadRequest
): Promise<CodexVisualizationLoadResult> {
	const { sessionId, path: fragmentPath, title } = request;
	if (typeof fragmentPath !== 'string' || !path.isAbsolute(fragmentPath)) {
		return { ok: false, reason: 'invalid', message: 'The visualization path is not absolute' };
	}
	const session = storedSession(sessionId);
	const ssh = session?.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
	if (ssh?.enabled) {
		return {
			ok: false,
			reason: 'remote',
			message: 'Visualizations from agents on an SSH remote are not rendered inline',
		};
	}

	let assetsDir: string | null = null;
	for (const home of candidateCodexHomes(sessionId)) {
		assetsDir = await findVisualizeAssetsDir(home);
		if (assetsDir) break;
	}
	if (!assetsDir) {
		return {
			ok: false,
			reason: 'no-runtime',
			message: "Codex's visualize plugin was not found in this agent's CODEX_HOME",
		};
	}

	let fragment: string;
	try {
		fragment = await readFragment(fragmentPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			ok: false,
			reason: code === 'ENOENT' ? 'not-found' : 'invalid',
			message:
				code === 'ENOENT'
					? 'The visualization file no longer exists'
					: String((error as Error).message),
		};
	}

	const assets = await readVisualizeAssets(assetsDir);
	const html = buildCodexVisualizationDocument(
		fragment,
		title?.trim() || defaultVisualizationTitle(fragmentPath),
		assets
	);
	// Keyed by path so every message pointing at one file shares a document.
	const id = createHash('sha256').update(fragmentPath).digest('hex').slice(0, 32);
	const revision = registerCodexVisualizationDocument(id, html);
	return { ok: true, id, revision };
}
