// Analyze a Maestro field performance trace and print a Markdown summary.
//
// This is the development-time counterpart to the in-app capture (Cmd+K ->
// "Debug: Start/End Performance Profiling"). The app only CAPTURES traces; all
// analysis lives here so nothing heavy ships in the Electron main process.
//
// Usage:
//   node scripts/analyze-perf-trace.mjs <maestro-profile-*.zip | trace.json | trace.json.gz>
//
// It surfaces the long main-thread tasks (the lag a user feels), self-time by
// subsystem (Layout / Paint / JS / GC), and the hottest JS functions. See
// CLAUDE-PERFORMANCE.md -> "Field Performance Traces" for how to act on it.
//
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- Tunables (mirror src/main/profiling expectations) ----------------------
const LONG_TASK_US = 50_000; // >= 50ms task = perceived jank (Chromium's bar)
const FRAME_BUDGET_MS = 1000 / 60;
const MAX_LONG_TASKS = 20;
const MAX_COST_ROWS = 15;
const MAX_HOT_FUNCS = 15;
const JS_EVENT_NAMES = new Set(['FunctionCall', 'EvaluateScript', 'V8.Execute', 'v8.run']);

const us2ms = (us) => us / 1000;

// --- Input loading: .zip | .json.gz | .json ---------------------------------
function loadInput(inputPath) {
	if (!fs.existsSync(inputPath)) {
		throw new Error(`File not found: ${inputPath}`);
	}
	const lower = inputPath.toLowerCase();

	if (lower.endsWith('.zip')) {
		let AdmZip;
		try {
			AdmZip = require('adm-zip');
		} catch {
			throw new Error(
				'Reading a .zip needs adm-zip (a repo dependency). Run from the repo root, or unzip and pass trace.json directly.'
			);
		}
		const zip = new AdmZip(inputPath);
		const traceEntry = zip.getEntry('trace.json');
		if (!traceEntry) throw new Error('Bundle has no trace.json');
		const metaEntry = zip.getEntry('metadata.json');
		const meta = metaEntry ? safeJson(metaEntry.getData().toString('utf-8')) : null;
		return { traceText: traceEntry.getData().toString('utf-8'), meta };
	}

	if (lower.endsWith('.gz')) {
		const buf = zlib.gunzipSync(fs.readFileSync(inputPath));
		return { traceText: buf.toString('utf-8'), meta: null };
	}

	return { traceText: fs.readFileSync(inputPath, 'utf-8'), meta: null };
}

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// --- Core analysis ----------------------------------------------------------
// Trace events on one thread strictly nest by time containment, so
// self-time(event) = duration - sum(children). Standard flame-graph accounting.

function analyzeEvents(events) {
	const threadName = new Map();
	const perThread = new Map();
	const beStacks = new Map();
	let minTs = Infinity;
	let maxTs = -Infinity;

	const keyOf = (e) => `${e.pid ?? 0}:${e.tid ?? 0}`;
	const pushSpan = (key, span) => {
		let arr = perThread.get(key);
		if (!arr) perThread.set(key, (arr = []));
		arr.push(span);
	};

	for (const e of events) {
		if (typeof e.ts === 'number') {
			if (e.ts < minTs) minTs = e.ts;
			const end = e.ts + (typeof e.dur === 'number' ? e.dur : 0);
			if (end > maxTs) maxTs = end;
		}
		switch (e.ph) {
			case 'X':
				if (typeof e.ts === 'number') {
					pushSpan(keyOf(e), {
						ts: e.ts,
						dur: typeof e.dur === 'number' ? e.dur : 0,
						name: e.name ?? '(unnamed)',
						args: e.args,
					});
				}
				break;
			case 'B': {
				if (typeof e.ts !== 'number') break;
				const k = keyOf(e);
				let st = beStacks.get(k);
				if (!st) beStacks.set(k, (st = []));
				st.push({ ts: e.ts, dur: 0, name: e.name ?? '(unnamed)', args: e.args });
				break;
			}
			case 'E': {
				if (typeof e.ts !== 'number') break;
				const open = beStacks.get(keyOf(e))?.pop();
				if (open) {
					open.dur = e.ts - open.ts;
					pushSpan(keyOf(e), open);
				}
				break;
			}
			case 'M':
				if (e.name === 'thread_name' && e.args?.name) threadName.set(keyOf(e), e.args.name);
				break;
			default:
				break;
		}
	}

	const traceDurationSec =
		Number.isFinite(minTs) && maxTs > minTs ? us2ms(maxTs - minTs) / 1000 : 0;

	const busiestNamed = (target) => {
		let best,
			bestLen = 0;
		for (const [key, name] of threadName) {
			if (name !== target) continue;
			const len = perThread.get(key)?.length ?? 0;
			if (len > bestLen) {
				bestLen = len;
				best = key;
			}
		}
		return best;
	};

	const rKey = busiestNamed('CrRendererMain');
	const bKey = busiestNamed('CrBrowserMain');
	const renderer = rKey
		? analyzeThread(perThread.get(rKey) ?? [], 'Renderer main (UI)', minTs)
		: null;
	const browser = bKey ? analyzeThread(perThread.get(bKey) ?? [], 'Browser main', minTs) : null;

	const longTasks = [...(renderer?.longTasks ?? []), ...(browser?.longTasks ?? [])]
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, MAX_LONG_TASKS);

	const worstMs = longTasks.length ? longTasks[0].durationMs : 0;
	const estimatedDroppedFrames = longTasks.reduce(
		(sum, t) => sum + Math.max(0, Math.round(t.durationMs / FRAME_BUDGET_MS)),
		0
	);

	const hotFunctions = mergeHot([
		...(renderer?.hotFunctions ?? []),
		...(browser?.hotFunctions ?? []),
	]).slice(0, MAX_HOT_FUNCS);

	return {
		traceDurationSec,
		totalEvents: events.length,
		rendererMain: renderer?.summary,
		browserMain: browser?.summary,
		longTasks,
		costByName: (renderer?.costByName ?? browser?.costByName ?? []).slice(0, MAX_COST_ROWS),
		hotFunctions,
		jank: { longTaskCount: longTasks.length, worstMs, estimatedDroppedFrames },
	};
}

function analyzeThread(spans, label, traceStartUs) {
	const sorted = [...spans].sort((a, b) => a.ts - b.ts || b.dur - a.dur);
	const whole = computeSelfTimes(sorted);
	const busyMs = us2ms(whole.busyUs);

	const longSpans = whole.topLevel
		.filter((s) => s.dur >= LONG_TASK_US)
		.sort((a, b) => b.dur - a.dur)
		.slice(0, MAX_LONG_TASKS);

	const longTasks = longSpans.map((task) => {
		const slice = sliceByTime(sorted, task.ts, task.ts + task.dur);
		const local = computeSelfTimes(slice);
		const breakdown = [...local.byName.entries()]
			.map(([name, v]) => ({ name, selfMs: us2ms(v.selfUs) }))
			.sort((a, b) => b.selfMs - a.selfMs)
			.slice(0, 3);
		return {
			threadLabel: label,
			startSec: us2ms(task.ts - traceStartUs) / 1000,
			durationMs: us2ms(task.dur),
			breakdown,
			topFunction: bestFunction(local.byFunc),
		};
	});

	const costByName = [...whole.byName.entries()]
		.map(([name, v]) => ({ name, selfMs: us2ms(v.selfUs), count: v.count }))
		.sort((a, b) => b.selfMs - a.selfMs);

	const hotFunctions = mergeHot(
		[...whole.byFunc.values()].map((v) => ({
			name: v.name,
			location: v.location,
			selfMs: us2ms(v.selfUs),
			count: v.count,
		}))
	);

	return {
		summary: { label, busyMs, longTaskCount: longSpans.length },
		longTasks,
		costByName,
		hotFunctions,
	};
}

function computeSelfTimes(sorted) {
	const byName = new Map();
	const byFunc = new Map();
	const topLevel = [];
	let busyUs = 0;
	const stack = [];

	const finalize = (frame) => {
		const selfUs = Math.max(0, frame.span.dur - frame.childUs);
		const name = frame.span.name;
		const n = byName.get(name) ?? { selfUs: 0, count: 0 };
		n.selfUs += selfUs;
		n.count += 1;
		byName.set(name, n);
		if (JS_EVENT_NAMES.has(name)) {
			const fn = functionLabel(frame.span);
			if (fn) {
				const f = byFunc.get(fn.key) ?? {
					selfUs: 0,
					count: 0,
					name: fn.name,
					location: fn.location,
				};
				f.selfUs += selfUs;
				f.count += 1;
				byFunc.set(fn.key, f);
			}
		}
	};

	for (const span of sorted) {
		const end = span.ts + span.dur;
		while (stack.length) {
			const top = stack[stack.length - 1];
			const topEnd = top.span.ts + top.span.dur;
			if (top.span.ts <= span.ts && topEnd >= end) break;
			const finished = stack.pop();
			finalize(finished);
			if (stack.length) stack[stack.length - 1].childUs += finished.span.dur;
		}
		if (stack.length === 0) {
			topLevel.push(span);
			busyUs += span.dur;
		}
		stack.push({ span, childUs: 0 });
	}
	while (stack.length) {
		const finished = stack.pop();
		finalize(finished);
		if (stack.length) stack[stack.length - 1].childUs += finished.span.dur;
	}
	return { topLevel, busyUs, byName, byFunc };
}

function sliceByTime(sorted, lo, hi) {
	let left = 0;
	let right = sorted.length;
	while (left < right) {
		const mid = (left + right) >> 1;
		if (sorted[mid].ts < lo) left = mid + 1;
		else right = mid;
	}
	const out = [];
	for (let i = left; i < sorted.length && sorted[i].ts < hi; i++) out.push(sorted[i]);
	return out;
}

function functionLabel(span) {
	const data = span.args?.data ?? {};
	const name = (data.functionName ?? '').trim();
	const location = data.url
		? `${data.url}:${data.lineNumber ?? 0}:${data.columnNumber ?? 0}`
		: undefined;
	if (!name && !location) return undefined;
	const display = name || '(anonymous)';
	return { key: `${display}@${location ?? ''}`, name: display, location };
}

function bestFunction(byFunc) {
	let best;
	for (const v of byFunc.values()) {
		const selfMs = us2ms(v.selfUs);
		if (!best || selfMs > best.selfMs)
			best = { name: v.name, location: v.location, selfMs, count: v.count };
	}
	return best;
}

function mergeHot(rows) {
	const merged = new Map();
	for (const r of rows) {
		const key = `${r.name}@${r.location ?? ''}`;
		const ex = merged.get(key);
		if (ex) {
			ex.selfMs += r.selfMs;
			ex.count += r.count;
		} else {
			merged.set(key, { ...r });
		}
	}
	return [...merged.values()].sort((a, b) => b.selfMs - a.selfMs);
}

// --- Rendering --------------------------------------------------------------
const ms = (n) => (n < 1000 ? `${n.toFixed(2)}ms` : `${(n / 1000).toFixed(2)}s`);
const sanitize = (s) => {
	if (!s) return '';
	const home = process.env.HOME;
	return home ? s.split(home).join('~') : s;
};

function render(analysis, meta) {
	const out = [];
	out.push('# Maestro Performance Profile analysis');
	out.push('');
	if (meta) {
		out.push(
			`Captured ${meta.capturedAt} | Maestro v${meta.appVersion} | ${meta.platform} ${meta.arch} | ` +
				`Electron ${meta.electronVersion} (Chrome ${meta.chromeVersion}) | CPU ${meta.cpuModel} x${meta.cpuCount}`
		);
		out.push('');
	}

	const j = analysis.jank;
	out.push('## Verdict');
	out.push('');
	if (j.longTaskCount === 0) {
		out.push(
			`No main-thread long tasks (>= 50ms) in the ${analysis.traceDurationSec.toFixed(1)}s window. ` +
				'If lag was reported, it happened outside the capture or off the main thread - re-capture while reproducing it.'
		);
	} else {
		const worst = analysis.longTasks[0];
		const culprit = worst?.breakdown[0];
		out.push(
			`${j.longTaskCount} long main-thread task(s) blocked input/frames (~${j.estimatedDroppedFrames} dropped frames @60fps). ` +
				`Worst: ${ms(worst.durationMs)} at ${worst.startSec.toFixed(1)}s` +
				(culprit ? `, dominated by ${culprit.name} (${ms(culprit.selfMs)} self-time).` : '.')
		);
		if (analysis.rendererMain) {
			const r = analysis.rendererMain;
			const util = ((r.busyMs / 1000 / Math.max(analysis.traceDurationSec, 0.001)) * 100).toFixed(
				0
			);
			out.push('');
			out.push(
				`Renderer UI thread busy ${ms(r.busyMs)} of ${analysis.traceDurationSec.toFixed(1)}s (${util}% utilization).`
			);
		}
	}
	out.push('');

	if (analysis.longTasks.length) {
		out.push('## Long main-thread tasks (>= 50ms)');
		out.push('');
		out.push('| # | Thread | Start | Duration | Dominant cost | Hottest JS |');
		out.push('| --- | --- | --- | --- | --- | --- |');
		analysis.longTasks.forEach((t, i) => {
			const cost = t.breakdown.map((b) => `${b.name} ${ms(b.selfMs)}`).join(', ') || '-';
			const fn = t.topFunction
				? `\`${t.topFunction.name}\`${t.topFunction.location ? ` (${sanitize(t.topFunction.location)})` : ''}`
				: '-';
			out.push(
				`| ${i + 1} | ${t.threadLabel} | ${t.startSec.toFixed(2)}s | ${ms(t.durationMs)} | ${cost} | ${fn} |`
			);
		});
		out.push('');
	}

	if (analysis.costByName.length) {
		out.push('## Self-time by subsystem (renderer UI thread)');
		out.push('');
		out.push('| Event | Self-time | Count |');
		out.push('| --- | --- | --- |');
		for (const c of analysis.costByName) out.push(`| ${c.name} | ${ms(c.selfMs)} | ${c.count} |`);
		out.push('');
	}

	if (analysis.hotFunctions.length) {
		out.push('## Hottest JS functions');
		out.push('');
		out.push('| Function | Location | Self-time | Calls |');
		out.push('| --- | --- | --- | --- |');
		for (const f of analysis.hotFunctions) {
			out.push(`| \`${f.name}\` | ${sanitize(f.location) || '-'} | ${ms(f.selfMs)} | ${f.count} |`);
		}
		out.push('');
	}

	out.push(`_Analyzed ${analysis.totalEvents.toLocaleString()} trace events._`);
	out.push('');
	return out.join('\n');
}

// --- main -------------------------------------------------------------------
function main() {
	const inputPath = process.argv[2];
	if (!inputPath) {
		console.error(
			'Usage: node scripts/analyze-perf-trace.mjs <bundle.zip | trace.json | trace.json.gz>'
		);
		process.exit(2);
	}

	const sizeMb = fs.existsSync(inputPath)
		? (fs.statSync(inputPath).size / 1024 / 1024).toFixed(1)
		: '?';
	console.error(`[analyze-perf-trace] Loading ${path.basename(inputPath)} (${sizeMb} MB)...`);

	const { traceText, meta } = loadInput(inputPath);
	const parsed = JSON.parse(traceText);
	const events = Array.isArray(parsed) ? parsed : parsed?.traceEvents;
	if (!Array.isArray(events)) throw new Error('Trace did not contain a traceEvents array.');

	console.error(`[analyze-perf-trace] Analyzing ${events.length.toLocaleString()} events...`);
	const analysis = analyzeEvents(events);
	process.stdout.write(render(analysis, meta));
}

try {
	main();
} catch (err) {
	console.error(`[analyze-perf-trace] ${err.message}`);
	process.exit(1);
}
