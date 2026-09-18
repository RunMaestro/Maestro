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
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- Tunables (mirror src/main/profiling expectations) ----------------------
const LONG_TASK_US = 50_000; // >= 50ms task = perceived jank (Chromium's bar)
const FRAME_BUDGET_MS = 1000 / 60;
const MAX_LONG_TASKS = 20;
const MAX_COST_ROWS = 15;
const MAX_HOT_FUNCS = 15;
const JS_EVENT_NAMES = new Set(['FunctionCall', 'EvaluateScript', 'V8.Execute', 'v8.run']);
// V8's max string length. Past it a trace can only be read line by line.
const MAX_WHOLE_PARSE_BYTES = 0x1fffffe8;
// A frame cadence at or under this gap means the compositor never went idle.
const CONTINUOUS_FRAME_GAP_MS = 20;

const us2ms = (us) => us / 1000;

// --- Input loading: .zip | .json.gz | .json ---------------------------------
// A field trace is routinely larger than V8's 512MB max string, so the file is
// never turned into one string. `openTrace` hands back a factory that yields a
// fresh line stream over the same bytes, and the analysis makes two passes:
// one to learn the thread names, one to keep only the spans that matter.
// Chromium writes the Trace Event format one event per line, which is what
// makes the line scan safe; a trace from another producer falls back to a whole
// document parse (only possible under the string limit).
function openTrace(inputPath) {
	if (!fs.existsSync(inputPath)) {
		throw new Error(`File not found: ${inputPath}`);
	}
	const lower = inputPath.toLowerCase();

	if (lower.endsWith('.zip')) {
		let unzipSync;
		try {
			({ unzipSync } = require('fflate'));
		} catch {
			throw new Error(
				'Reading a .zip needs fflate (a repo dependency). Run from the repo root, or unzip and pass trace.json directly.'
			);
		}
		const files = unzipSync(new Uint8Array(fs.readFileSync(inputPath)));
		const traceBytes = files['trace.json'];
		if (!traceBytes) throw new Error('Bundle has no trace.json');
		const metaBytes = files['metadata.json'];
		const meta = metaBytes ? safeJson(Buffer.from(metaBytes).toString('utf-8')) : null;
		const buf = Buffer.from(traceBytes.buffer, traceBytes.byteOffset, traceBytes.byteLength);
		return { meta, byteLength: buf.length, createStream: () => chunkedStream(buf) };
	}

	if (lower.endsWith('.gz')) {
		const buf = zlib.gunzipSync(fs.readFileSync(inputPath));
		return { meta: null, byteLength: buf.length, createStream: () => chunkedStream(buf) };
	}

	return {
		meta: null,
		byteLength: fs.statSync(inputPath).size,
		createStream: () => fs.createReadStream(inputPath, { highWaterMark: 1 << 22 }),
	};
}

// Feed an in-memory buffer out in pieces. Handing readline the whole buffer in
// one chunk makes its StringDecoder decode it as a single string, which throws
// on anything past V8's limit - the exact failure this streaming path exists to
// avoid.
const STREAM_CHUNK_BYTES = 1 << 22;
function chunkedStream(buf) {
	return Readable.from(
		(function* () {
			for (let offset = 0; offset < buf.length; offset += STREAM_CHUNK_BYTES) {
				yield buf.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, buf.length));
			}
		})()
	);
}

// Walk every trace event, calling `onEvent` once per event. Returns the number
// of events seen so a caller can tell a real trace from an unparsable one.
async function forEachEvent(trace, onEvent) {
	const rl = readline.createInterface({ input: trace.createStream(), crlfDelay: Infinity });
	let seen = 0;
	for await (const line of rl) {
		// Events are comma-separated one per line; the first and last lines carry
		// the enclosing object, which has no event on it.
		const text = line.endsWith(',') ? line.slice(0, -1) : line;
		if (text.charCodeAt(0) !== 0x7b /* { */) continue;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			continue;
		}
		// A whole trace document on ONE line parses here as a single "event" with
		// no `ph`, which would leave `seen` at 1 and so skip the whole-document
		// fallback below, and the run dies with "no CrRendererMain thread" instead
		// of an analysis. Chrome DevTools' own "Save profile" writes exactly this
		// shape (`{"metadata":{...},"traceEvents":[...]}`), so expand it here.
		// The bare-array form starts with `[` and is skipped above, which is what
		// already routes it to the fallback.
		if (Array.isArray(event?.traceEvents)) {
			for (const inner of event.traceEvents) {
				seen += 1;
				onEvent(inner);
			}
			continue;
		}
		seen += 1;
		onEvent(event);
	}
	return seen;
}

// Fallback for a trace that is not line-delimited (another producer, or a
// hand-edited file). Only reachable under V8's max string length.
function forEachEventWhole(trace, onEvent) {
	if (trace.byteLength > MAX_WHOLE_PARSE_BYTES) {
		throw new Error(
			`Trace is ${(trace.byteLength / 1024 / 1024).toFixed(0)}MB and is not line-delimited, so it cannot be ` +
				'parsed as a single JSON document. Re-capture with Maestro, which writes one event per line.'
		);
	}
	const chunks = [];
	const stream = trace.createStream();
	return new Promise((resolve, reject) => {
		stream.on('data', (c) => chunks.push(c));
		stream.on('error', reject);
		stream.on('end', () => {
			const parsed = safeJson(Buffer.concat(chunks).toString('utf-8'));
			const events = Array.isArray(parsed) ? parsed : parsed?.traceEvents;
			if (!Array.isArray(events)) {
				reject(new Error('Trace did not contain a traceEvents array.'));
				return;
			}
			for (const event of events) onEvent(event);
			resolve(events.length);
		});
	});
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

// Pass 1: learn which thread is which. Chromium emits the thread_name metadata
// up front, but counting here also lets pass 2 pick the BUSIEST renderer when
// an Electron window has several (webviews, the dev tools, a second window).
async function collectThreads(trace) {
	const threadName = new Map();
	const spanCount = new Map();
	const busyUs = new Map();
	let totalEvents = 0;

	const onEvent = (e) => {
		const key = `${e.pid ?? 0}:${e.tid ?? 0}`;
		if (e.ph === 'M') {
			if (e.name === 'thread_name' && e.args?.name) threadName.set(key, e.args.name);
			return;
		}
		if (e.ph !== 'X' && e.ph !== 'B' && e.ph !== 'E') return;
		spanCount.set(key, (spanCount.get(key) ?? 0) + 1);
		if (e.ph === 'X' && typeof e.dur === 'number') busyUs.set(key, (busyUs.get(key) ?? 0) + e.dur);
	};

	totalEvents = await forEachEvent(trace, onEvent);
	if (totalEvents === 0) totalEvents = await forEachEventWhole(trace, onEvent);

	const busiestNamed = (target) => {
		let best;
		let bestUs = -1;
		for (const [key, name] of threadName) {
			if (name !== target) continue;
			const us = busyUs.get(key) ?? 0;
			if (us > bestUs) {
				bestUs = us;
				best = key;
			}
		}
		return best;
	};

	return { threadName, spanCount, totalEvents, busiestNamed };
}

// Pass 2: keep the spans for the two threads a user actually feels, plus the
// V8 sampling profiler's chunks. Everything else is dropped as it streams by,
// which is what keeps a multi-gigabyte trace inside a normal heap.
// Style/layout invalidation events are instantaneous (ph:'I'), so they never
// land in the span tables, and each one carries the JS stack that dirtied the
// node. Aggregating them by (reason, stack) is what turns "the renderer painted
// 5,470 frames while idle" into "this function did it" - the step a Sep 2026
// field analysis could not take, because the category emitting the reasons was
// not being recorded at all.
const INVALIDATION_EVENTS = new Set([
	'StyleRecalcInvalidationTracking',
	'LayoutInvalidationTracking',
	'ScheduleStyleRecalculation',
	'InvalidateLayout',
]);
const MAX_INVALIDATION_ROWS = 15;

/** `fn @ file:line:col` for the frame that scheduled an invalidation. */
function invalidationOrigin(data) {
	const top = data?.stackTrace?.[0];
	if (!top) return '(no JS stack)';
	const file =
		String(top.url ?? '')
			.split('/')
			.pop() || '(inline)';
	return `${top.functionName || '(anonymous)'} @ ${file}:${top.lineNumber}:${top.columnNumber}`;
}

async function collectSpans(trace, wantedKeys) {
	const perThread = new Map([...wantedKeys].map((k) => [k, []]));
	const beStacks = new Map();
	const profiles = new Map();
	// key `pid:tid` -> Map(`event|reason|origin` -> { event, reason, origin, count })
	const invalidations = new Map();
	// The window is taken from the threads being reported on, not from every
	// event in the file. Metadata is stamped ts:0, and a background renderer's
	// compositor can carry events from minutes before the capture started -
	// either one silently stretches the window and deflates every rate and
	// utilization figure derived from it.
	let minTs = Infinity;
	let maxTs = -Infinity;

	const onEvent = (e) => {
		const key = `${e.pid ?? 0}:${e.tid ?? 0}`;
		if (perThread.has(key) && typeof e.ts === 'number' && e.ts > 0 && e.ph !== 'M') {
			if (e.ts < minTs) minTs = e.ts;
			const end = e.ts + (typeof e.dur === 'number' ? e.dur : 0);
			if (end > maxTs) maxTs = end;
		}
		if (e.name === 'Profile' || e.name === 'ProfileChunk') {
			collectProfileChunk(profiles, e);
			return;
		}
		if (!perThread.has(key)) return;
		if (e.ph === 'I' && INVALIDATION_EVENTS.has(e.name)) {
			const data = e.args?.data;
			const reason = data?.reason ?? '-';
			const origin = invalidationOrigin(data);
			let byKey = invalidations.get(key);
			if (!byKey) invalidations.set(key, (byKey = new Map()));
			const rowKey = `${e.name}|${reason}|${origin}`;
			const row = byKey.get(rowKey);
			if (row) row.count++;
			else byKey.set(rowKey, { event: e.name, reason, origin, count: 1 });
			return;
		}
		switch (e.ph) {
			case 'X':
				if (typeof e.ts === 'number') {
					perThread.get(key).push({
						ts: e.ts,
						dur: typeof e.dur === 'number' ? e.dur : 0,
						name: e.name ?? '(unnamed)',
						args: e.args,
					});
				}
				break;
			case 'B': {
				if (typeof e.ts !== 'number') break;
				let stack = beStacks.get(key);
				if (!stack) beStacks.set(key, (stack = []));
				stack.push({ ts: e.ts, dur: 0, name: e.name ?? '(unnamed)', args: e.args });
				break;
			}
			case 'E': {
				if (typeof e.ts !== 'number') break;
				const open = beStacks.get(key)?.pop();
				if (open) {
					open.dur = e.ts - open.ts;
					perThread.get(key).push(open);
				}
				break;
			}
			default:
				break;
		}
	};

	const seen = await forEachEvent(trace, onEvent);
	if (seen === 0) await forEachEventWhole(trace, onEvent);

	return { perThread, profiles, minTs, maxTs, invalidations };
}

// The v8.cpu_profiler category carries the only usable JS attribution in an
// Electron trace: the devtools FunctionCall events this script used to look for
// are not emitted, so the "hottest JS" table was always empty. Chunks arrive
// incrementally and share one node table per profile id.
function collectProfileChunk(profiles, e) {
	const id = `${e.pid ?? 0}:${e.id ?? e.id2?.local ?? ''}`;
	let profile = profiles.get(id);
	if (!profile) {
		profile = { pid: e.pid ?? 0, tid: e.tid ?? 0, nodes: new Map(), samples: [], deltas: [] };
		profiles.set(id, profile);
	}
	const data = e.args?.data;
	if (!data) return;
	if (e.name === 'Profile') {
		profile.tid = e.tid ?? profile.tid;
		return;
	}
	const cpuProfile = data.cpuProfile;
	if (!cpuProfile) return;
	for (const node of cpuProfile.nodes ?? []) profile.nodes.set(node.id, node);
	for (const sampleId of cpuProfile.samples ?? []) profile.samples.push(sampleId);
	for (const delta of data.timeDeltas ?? []) profile.deltas.push(delta);
}

// Self-time per JS function from the sampling profiler, plus the share of the
// window V8 spent idle - the single most useful number for telling "the app is
// working hard" apart from "the app is redrawing a static screen".
function analyzeProfile(profile) {
	const selfUs = new Map();
	let sampledUs = 0;
	let idleUs = 0;
	const count = Math.min(profile.samples.length, profile.deltas.length);
	for (let i = 0; i < count; i++) {
		const delta = profile.deltas[i];
		// A negative or absurd delta means a dropped chunk; charging it to a
		// function would invent time that was never spent.
		if (!(delta > 0) || delta > 1_000_000) continue;
		sampledUs += delta;
		const nodeId = profile.samples[i];
		selfUs.set(nodeId, (selfUs.get(nodeId) ?? 0) + delta);
	}

	const rows = [];
	for (const [nodeId, us] of selfUs) {
		const frame = profile.nodes.get(nodeId)?.callFrame;
		const name = frame?.functionName || '(anonymous)';
		if (name === '(idle)') {
			idleUs += us;
			continue;
		}
		if (name === '(program)' || name === '(root)') continue;
		const location = frame?.url ? `${frame.url}:${(frame.lineNumber ?? -1) + 1}` : undefined;
		rows.push({ name, location, selfMs: us2ms(us), count: 0 });
	}

	return {
		sampledMs: us2ms(sampledUs),
		idleMs: us2ms(idleUs),
		hotFunctions: mergeHot(rows).slice(0, MAX_HOT_FUNCS),
	};
}

// How often the compositor committed a frame. A UI that is genuinely idle
// commits nothing; one pinned at the display cadence for the whole window is
// burning the renderer, the compositor and the GPU on a static picture, which
// no long-task table would ever show.
function analyzeFrameCadence(spans, windowSec) {
	const commits = spans.filter((s) => s.name === 'Commit').map((s) => s.ts);
	if (commits.length < 2) return null;
	commits.sort((a, b) => a - b);
	const gaps = [];
	for (let i = 1; i < commits.length; i++) gaps.push(us2ms(commits[i] - commits[i - 1]));
	const sorted = [...gaps].sort((a, b) => a - b);
	const continuous = gaps.filter((g) => g <= CONTINUOUS_FRAME_GAP_MS).length;
	return {
		frames: commits.length,
		medianGapMs: sorted[sorted.length >> 1],
		continuousShare: continuous / gaps.length,
		framesPerSec: windowSec > 0 ? commits.length / windowSec : 0,
	};
}

async function analyzeTrace(trace) {
	const { threadName, totalEvents, busiestNamed } = await collectThreads(trace);
	const rendererKey = busiestNamed('CrRendererMain');
	const browserKey = busiestNamed('CrBrowserMain');
	const wanted = new Set([rendererKey, browserKey].filter(Boolean));
	if (wanted.size === 0) throw new Error('Trace has no CrRendererMain or CrBrowserMain thread.');

	const { perThread, profiles, minTs, maxTs, invalidations } = await collectSpans(trace, wanted);

	const traceDurationSec =
		Number.isFinite(minTs) && maxTs > minTs ? us2ms(maxTs - minTs) / 1000 : 0;

	const renderer = rendererKey
		? analyzeThread(perThread.get(rendererKey) ?? [], 'Renderer main (UI)', minTs)
		: null;
	const browser = browserKey
		? analyzeThread(perThread.get(browserKey) ?? [], 'Browser main', minTs)
		: null;

	const longTasks = [...(renderer?.longTasks ?? []), ...(browser?.longTasks ?? [])]
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, MAX_LONG_TASKS);

	const worstMs = longTasks.length ? longTasks[0].durationMs : 0;
	const estimatedDroppedFrames = longTasks.reduce(
		(sum, t) => sum + Math.max(0, Math.round(t.durationMs / FRAME_BUDGET_MS)),
		0
	);

	// Pair each profile with the thread it sampled, so the JS table says which
	// process the cost landed in rather than merging main and renderer together.
	const profileFor = (key) => {
		if (!key) return null;
		for (const profile of profiles.values()) {
			if (`${profile.pid}:${profile.tid}` === key) return analyzeProfile(profile);
		}
		const [pid] = key.split(':');
		for (const profile of profiles.values()) {
			if (String(profile.pid) === pid) return analyzeProfile(profile);
		}
		return null;
	};

	const rendererProfile = profileFor(rendererKey);
	const browserProfile = profileFor(browserKey);

	const hotFunctions = mergeHot([
		...(rendererProfile?.hotFunctions ?? []),
		...(browserProfile?.hotFunctions ?? []),
		...(renderer?.hotFunctions ?? []),
		...(browser?.hotFunctions ?? []),
	]).slice(0, MAX_HOT_FUNCS);

	return {
		traceDurationSec,
		totalEvents,
		threadCount: threadName.size,
		rendererMain: renderer?.summary,
		browserMain: browser?.summary,
		rendererProfile,
		browserProfile,
		frames: analyzeFrameCadence(perThread.get(rendererKey) ?? [], traceDurationSec),
		longTasks,
		costByName: (renderer?.costByName ?? browser?.costByName ?? []).slice(0, MAX_COST_ROWS),
		hotFunctions,
		// Renderer only: style and layout invalidation is a renderer-main concern,
		// and the browser process has no document to dirty.
		invalidations: [...(invalidations.get(rendererKey)?.values() ?? [])]
			.sort((a, b) => b.count - a.count)
			.slice(0, MAX_INVALIDATION_ROWS),
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

	// Whether the file is whole changes how every number below should be read, so
	// it is stated before any of them. Captures from Sep 2026 onward record their
	// own buffer usage and can answer this outright; older ones are judged by
	// comparing the covered window against the requested duration, which only
	// ever produced a suspicion.
	const requestedSec = meta?.profilingDurationMs ? meta.profilingDurationMs / 1000 : 0;
	const coveredPct =
		requestedSec > 0 && analysis.traceDurationSec > 0
			? (analysis.traceDurationSec / requestedSec) * 100
			: null;

	if (typeof meta?.bufferExhausted === 'boolean') {
		const peakPct = Math.round((meta.peakBufferPercent ?? 0) * 100);
		const bufferMb = meta.traceBufferSizeKb ? Math.round(meta.traceBufferSizeKb / 1000) : null;
		if (meta.bufferExhausted) {
			out.push(
				`> [!WARNING]` +
					`\n> INCOMPLETE CAPTURE. Trace buffer peaked at ${peakPct}%` +
					`${bufferMb ? ` of ${bufferMb}MB per process` : ''}, so Chromium dropped events. ` +
					`This file covers ${analysis.traceDurationSec.toFixed(1)}s of a ${requestedSec.toFixed(0)}s ` +
					`recording${coveredPct !== null ? ` (${coveredPct.toFixed(0)}%)` : ''}. ` +
					`Every total below is a LOWER BOUND, and anything absent may simply not have been recorded.`
			);
		} else {
			out.push(
				`> [!NOTE]` +
					`\n> Complete capture: the recording ${meta.autoStopped ? 'was ended automatically' : 'ended'} ` +
					`at ${peakPct}% trace-buffer usage, before any events were dropped. ` +
					`Totals below cover the full ${requestedSec.toFixed(1)}s window.`
			);
		}
		out.push('');
	} else if (coveredPct !== null && coveredPct < 90) {
		// Pre-watchdog bundle: infer truncation the old way.
		out.push(
			`> [!WARNING]` +
				`\n> The trace buffer filled. This file covers ${analysis.traceDurationSec.toFixed(1)}s of the ` +
				`${requestedSec.toFixed(0)}s recording (${coveredPct.toFixed(0)}%); the rest was discarded. ` +
				`This bundle predates the capture-side buffer watchdog, so the loss can only be inferred, ` +
				`not measured - re-capture on a current build to get a complete window.`
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
	}
	if (analysis.rendererMain) {
		const r = analysis.rendererMain;
		const util = ((r.busyMs / 1000 / Math.max(analysis.traceDurationSec, 0.001)) * 100).toFixed(0);
		out.push('');
		out.push(
			`Renderer UI thread busy ${ms(r.busyMs)} of ${analysis.traceDurationSec.toFixed(1)}s (${util}% utilization).`
		);
	}
	out.push('');

	// Frame production is reported next to JS idle time on purpose: a renderer
	// that commits every 16.7ms while V8 sits idle is not doing work a user
	// asked for, it is animating something nobody is looking at.
	const f = analysis.frames;
	if (f) {
		out.push('## Frame production');
		out.push('');
		out.push(
			`${f.frames.toLocaleString()} frames committed in ${analysis.traceDurationSec.toFixed(1)}s ` +
				`(${f.framesPerSec.toFixed(1)}/s, median gap ${f.medianGapMs.toFixed(1)}ms).`
		);
		if (f.continuousShare > 0.8) {
			const idlePct = analysis.rendererProfile?.sampledMs
				? (analysis.rendererProfile.idleMs / analysis.rendererProfile.sampledMs) * 100
				: null;
			out.push('');
			out.push(
				`> [!IMPORTANT]` +
					`\n> ${(f.continuousShare * 100).toFixed(0)}% of frames arrived within ${CONTINUOUS_FRAME_GAP_MS}ms of the last one: ` +
					`the renderer never went idle` +
					(idlePct !== null ? `, while V8 was idle ${idlePct.toFixed(1)}% of the window` : '') +
					`. Look for an \`infinite\` CSS animation on a non-composited property (box-shadow, filter, ` +
					`background) or a permanent requestAnimationFrame loop. Every one of those frames costs the ` +
					`renderer, the compositor and the GPU process.`
			);
		}
		out.push('');
	}

	if (analysis.rendererProfile || analysis.browserProfile) {
		out.push('## JS idle time (V8 sampling profiler)');
		out.push('');
		out.push('| Thread | Sampled | Idle | Working |');
		out.push('| --- | --- | --- | --- |');
		const row = (label, p) => {
			if (!p || !p.sampledMs) return;
			out.push(
				`| ${label} | ${ms(p.sampledMs)} | ${ms(p.idleMs)} (${((p.idleMs / p.sampledMs) * 100).toFixed(1)}%) | ${ms(p.sampledMs - p.idleMs)} |`
			);
		};
		row('Renderer main (UI)', analysis.rendererProfile);
		row('Browser main', analysis.browserProfile);
		out.push('');
	}

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
		// Counts come from devtools FunctionCall events; the sampling profiler has
		// no call count, so a sampled row shows a dash rather than a fake zero.
		out.push('| Function | Location | Self-time | Calls |');
		out.push('| --- | --- | --- | --- |');
		for (const f of analysis.hotFunctions) {
			out.push(
				`| \`${f.name}\` | ${sanitize(f.location) || '-'} | ${ms(f.selfMs)} | ${f.count || '-'} |`
			);
		}
		out.push('');
	}

	if (analysis.invalidations?.length) {
		out.push('## What dirties style and layout (renderer UI thread)');
		out.push('');
		out.push(
			'Who scheduled the work, not how much it cost. A renderer that recalculates ' +
				'style or layout on every frame while the user touches nothing is doing it at ' +
				"somebody's request, and this is that request: the reason Blink recorded, and the " +
				'JS frame that triggered it.'
		);
		out.push('');
		out.push('| Count | Event | Reason | Scheduled by |');
		out.push('| --- | --- | --- | --- |');
		for (const row of analysis.invalidations) {
			out.push(
				`| ${row.count.toLocaleString()} | ${row.event} | ${sanitize(row.reason)} | ${sanitize(row.origin)} |`
			);
		}
		out.push('');
	} else {
		out.push('## What dirties style and layout (renderer UI thread)');
		out.push('');
		out.push(
			'No invalidation events in this capture. The ' +
				'`disabled-by-default-devtools.timeline.invalidationTracking` category was not ' +
				'recorded, so why a style recalc or layout happened cannot be answered from this ' +
				'file - only that it did. Re-capture on a build that enables it.'
		);
		out.push('');
	}

	out.push(`_Analyzed ${analysis.totalEvents.toLocaleString()} trace events._`);
	out.push('');
	return out.join('\n');
}

// --- main -------------------------------------------------------------------
async function main() {
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

	const trace = openTrace(inputPath);
	const meta = trace.meta ?? safeJson(readSiblingMetadata(inputPath)) ?? null;

	console.error('[analyze-perf-trace] Scanning threads...');
	const analysis = await analyzeTrace(trace);
	console.error(`[analyze-perf-trace] Analyzed ${analysis.totalEvents.toLocaleString()} events.`);
	process.stdout.write(render(analysis, meta));
}

/** `metadata.json` next to an already-unzipped `trace.json`, if it is there. */
function readSiblingMetadata(inputPath) {
	const sibling = path.join(path.dirname(inputPath), 'metadata.json');
	return fs.existsSync(sibling) ? fs.readFileSync(sibling, 'utf-8') : '';
}

main().catch((err) => {
	console.error(`[analyze-perf-trace] ${err.message}`);
	process.exit(1);
});
