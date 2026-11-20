/**
 * What the context footprint audit may touch, and what may touch it.
 *
 * The audit is a report of estimates. Three promises make it safe to run and
 * safe to read, and each is cheaper to hold as a rule about source files than
 * as a runtime test of every path:
 *
 * - It never feeds the realized compression counters. Nothing in the token
 *   proxy or the stats tables imports it. The Models tab's explicit inventory
 *   display may format it, without feeding its numbers to the realized totals.
 * - It only reads. The collector's port has read methods, and no file of the
 *   audit names a way to write, remove or move a file.
 * - It runs when asked. No timer, watcher or schedule starts it, and the one
 *   verb that calls it is not reached from a spawn, a prompt or an automation.
 *
 * A new caller fails here until someone reads why it wants the audit and
 * updates the list on purpose.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function listSources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listSources(full, found);
		else if (/\.tsx?$/.test(entry.name)) found.push(full);
	}
	return found;
}

/** Source without comments, so a sentence that names a function is not a use of it. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const FILES = listSources(SRC).map((file) => ({
	relative: path.relative(SRC, file).split(path.sep).join('/'),
	text: code(fs.readFileSync(file, 'utf8')),
}));

const SHARED = 'shared/contextFootprint.ts';
const COLLECTOR = 'main/context-footprint.ts';
const COMMAND = 'cli/commands/agent-footprint.ts';
const SERVICE = 'main/context-footprint-service.ts';
// A plain read-only inventory display. It neither computes nor records proxy totals.
const AUDIT_VIEW = 'renderer/components/UsageDashboard/ModelUsage/ProxyInspectionDetails.tsx';

const textOf = (relative: string): string => {
	const file = FILES.find((candidate) => candidate.relative === relative);
	if (!file) throw new Error(`${relative} is missing`);
	return file.text;
};

const filesWhere = (test: (text: string) => boolean): string[] =>
	FILES.filter((file) => test(file.text))
		.map((file) => file.relative)
		.sort();

/** A named import, a bare side-effect import, a dynamic import and a require all count. */
const IMPORT_FORM = '(?:\\bfrom|\\bimport|\\bimport\\(|\\brequire\\()\\s*';
const importing = (module: string) => (text: string) =>
	new RegExp(`${IMPORT_FORM}['"][^'"]*/${module}['"]`).test(text);
const naming = (symbol: string) => (text: string) => new RegExp(`\\b${symbol}\\b`).test(text);

/** The module specifiers a file imports. */
function importsOf(relative: string): string[] {
	return [...textOf(relative).matchAll(new RegExp(`${IMPORT_FORM}['"]([^'"]+)['"]`, 'g'))].map(
		(match) => match[1]
	);
}

/** Every file that holds or shows the realized compression counters. */
const COUNTER_FILES = FILES.map((file) => file.relative).filter(
	(relative) =>
		relative.startsWith('main/local-models/proxy/') ||
		(relative.startsWith('renderer/components/UsageDashboard/') && relative !== AUDIT_VIEW) ||
		[
			'main/stats/proxy-requests.ts',
			'main/stats/model-usage.ts',
			'shared/local-models/token-proxy.ts',
			'shared/local-models/model-usage.ts',
			'cli/commands/models-proxy.ts',
		].includes(relative)
);

describe('who reaches the context footprint audit', () => {
	it('finds the files it is checking (a rename must not empty this test)', () => {
		for (const relative of [SHARED, COLLECTOR, COMMAND, SERVICE, AUDIT_VIEW])
			expect(textOf(relative).length).toBeGreaterThan(0);
		expect(COUNTER_FILES).toEqual(
			expect.arrayContaining([
				'main/local-models/proxy/request-stats.ts',
				'main/local-models/proxy/service.ts',
				'main/stats/proxy-requests.ts',
				'main/stats/model-usage.ts',
				'shared/local-models/token-proxy.ts',
				'shared/local-models/model-usage.ts',
			])
		);
		expect(COUNTER_FILES.length).toBeGreaterThan(20);
	});

	it('has its rules imported only by the collector, verb and typed on-demand app boundary', () => {
		expect(filesWhere(importing('contextFootprint'))).toEqual(
			[
				COMMAND,
				COLLECTOR,
				SERVICE,
				'main/preload/context.ts',
				'renderer/global.d.ts',
				AUDIT_VIEW,
			].sort()
		);
	});

	it('has its collector imported only by the verb and stored-agent service', () => {
		expect(filesWhere(importing('context-footprint'))).toEqual([COMMAND, SERVICE].sort());
		expect(filesWhere(importing('context-footprint-service'))).toEqual([
			'main/ipc/handlers/context.ts',
		]);
	});

	it('runs only through an explicit command or context audit request', () => {
		expect(filesWhere(naming('collectContextFootprint'))).toEqual(
			[COMMAND, COLLECTOR, SERVICE].sort()
		);
		expect(filesWhere(naming('auditContextFootprint'))).toEqual([COLLECTOR, SHARED]);
		expect(filesWhere(naming('agentFootprint'))).toEqual([COMMAND, 'cli/index.ts']);
	});

	it('is not reached from a prompt, a spawn, an automation or a turn', () => {
		const reachers = filesWhere(naming('(?:formatContextFootprint|collectContextFootprint)'));
		for (const relative of reachers) {
			expect(relative).not.toMatch(
				/system-prompt|systemPrompt|spawn|process-manager|\/cue\/|turns\/|autorun|group-chat|prompt/i
			);
		}
	});
});

describe('the audit and the realized compression counters stay apart', () => {
	it('is imported by no realized-counter owner or proxy file', () => {
		const reachers = filesWhere(
			(text) => importing('contextFootprint')(text) || importing('context-footprint')(text)
		);
		expect(reachers.filter((relative) => COUNTER_FILES.includes(relative))).toEqual([]);
	});

	it('imports nothing from the counters, the proxy or the stats tables', () => {
		const banned =
			/local-models\/proxy|local-models\/token-proxy|local-models\/model-usage|stats\/|request-stats|compression-cache|UsageDashboard/;
		for (const relative of [SHARED, COLLECTOR, COMMAND, SERVICE, AUDIT_VIEW]) {
			expect(
				importsOf(relative).filter((specifier) => banned.test(specifier)),
				relative
			).toEqual([]);
		}
	});

	it('names no counter and no recorder', () => {
		const symbols = [
			'recordTokenProxyRequest',
			'proxyRequestFromLog',
			'readTokenProxyUsage',
			'getTokenProxyReport',
			'readTokenProxyBlock',
			'tokensSaved',
			'bytesSaved',
			'proxy_requests',
			'model_usage',
			'getStatsDB',
		];
		for (const relative of [SHARED, COLLECTOR, COMMAND, SERVICE, AUDIT_VIEW]) {
			for (const symbol of symbols) {
				expect(naming(symbol)(textOf(relative)), `${relative} names ${symbol}`).toBe(false);
			}
		}
	});

	it('never calls configured text known loaded and never offers a window total', () => {
		for (const relative of [SHARED, COLLECTOR, COMMAND, SERVICE, AUDIT_VIEW]) {
			expect(textOf(relative), relative).not.toMatch(/known[ _-]?loaded/i);
			expect(textOf(relative), relative).not.toMatch(/windowTotal|currentContext|currentWindow/i);
		}
	});

	it('speaks of savings only to deny them: the literal field, and sentences that begin "Nothing here is"', () => {
		const lines = textOf(SHARED)
			.split('\n')
			.filter((line) => /\bsav(?:e|ed|ing|ings)\b|Savings\b/i.test(line));
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line, line).toMatch(/countsAsSavings|Nothing here is/);
		}
	});
});

describe('the audit only reads', () => {
	const WRITES =
		/\b(?:writeFile\w*|appendFile\w*|unlink\w*|rmdir\w*|rmSync|rm|rename\w*|mkdir\w*|symlink\w*|copyFile\w*|truncate\w*|createWriteStream|chmod\w*|chown\w*|utimes\w*|atomicWrite\w*|createExclusive|open(?:Sync)?|execFile\w*|exec|spawn\w*|fork)\s*\(/;

	it('names no way to write, remove, move or run anything', () => {
		for (const relative of [SHARED, COLLECTOR, COMMAND, SERVICE, AUDIT_VIEW]) {
			const match = textOf(relative).match(WRITES);
			expect(match?.[0], `${relative} calls ${match?.[0]}`).toBeUndefined();
		}
	});

	it('gives the collector a port of read methods only', () => {
		expect(textOf(COLLECTOR)).toMatch(
			/type FootprintFs = Pick<TranslationFs, 'stat' \| 'readdir' \| 'readFile' \| 'realpath'>/
		);
	});

	it('keeps the rules pure: no file system, no process, no Node built-ins', () => {
		expect(importsOf(SHARED)).toEqual(['./formatters']);
	});

	it('needs no running app: the verb opens no connection to the desktop', () => {
		const text = textOf(COMMAND);
		for (const symbol of [
			'withMaestroClient',
			'sendBridgeCommand',
			'maestro-client',
			'WebSocket',
		]) {
			expect(text.includes(symbol), `${COMMAND} names ${symbol}`).toBe(false);
		}
	});
});

describe('the audit runs when asked', () => {
	it('starts no timer, watcher, schedule or background task', () => {
		const SCHEDULING =
			/\b(?:setInterval|setTimeout|setImmediate|queueMicrotask|requestIdleCallback|requestAnimationFrame|chokidar|watchFile|fs\.watch|watch\(|node-cron|cron|schedule\w*|nohup|daemon)\b/;
		for (const relative of [SHARED, COLLECTOR, COMMAND, SERVICE, AUDIT_VIEW]) {
			const match = textOf(relative).match(SCHEDULING);
			expect(match?.[0], `${relative} uses ${match?.[0]}`).toBeUndefined();
		}
	});

	it('keeps nothing between runs: no module-level cache or store', () => {
		for (const relative of [SHARED, COLLECTOR]) {
			expect(textOf(relative)).not.toMatch(/^(?:const|let|var)\s+\w*(?:cache|memo|store)\w*\s*=/im);
			expect(textOf(relative)).not.toMatch(/\bnew (?:Map|Set|WeakMap)\(\)\s*;?\s*$/m);
		}
	});

	it('has no Cue subscription, playbook or settings entry that runs it', () => {
		const names = (text: string) =>
			/agent footprint|agentFootprint|collectContextFootprint/.test(text);
		const callers = FILES.filter((file) => names(file.text)).map((file) => file.relative);
		for (const relative of callers) {
			expect(relative).not.toMatch(/\/cue\/|playbook|settings|schedul|automation/i);
		}
	});
});
