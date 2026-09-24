/**
 * A Cappella speech latency harness.
 *
 * The measurement half of the "Time to first spoken word" section in
 * `docs/architecture/acappella/latency-baseline.md`. That number is the one a
 * user actually feels - how long they stand in silence before anything is said -
 * and everything in `src/main/acappella/speech/` exists to shorten it.
 *
 * Measuring it with a microphone and a live agent measures four things at once:
 * the decode, the model on the day, the network on the day, and the streaming
 * layer. Only the last of those is ours, and it is the only one a regression can
 * be attributed to. So the providers here are stubs with DECLARED costs and
 * everything between them is the shipping code - `AgentOutputTap`,
 * `ConversationalTranslator`, `SpeechScheduler`, and the one splitter in
 * `src/shared/acappella/sentences.ts`. Vary the declared costs and the arms move
 * together; vary the layer and only the streamed arm moves. That is the property
 * that makes this a baseline rather than a benchmark.
 *
 * Two arms per fixture, and the comparison between them IS the result:
 *
 *   - `streamed` - the shipped path. The tap cuts at a completed thought while
 *     the agent is still writing, the translator rewrites that piece alone, and
 *     the scheduler speaks it.
 *   - `buffered` - the counterfactual the layer replaced: wait for the whole
 *     reply, rewrite the whole thing, then speak.
 *
 * The zero point is the agent's first token, not the detector's speech end. That
 * is deliberate and it matches the doc's own definition of the **First spoken
 * sentence** span: STT and routing happen before this layer is involved, and
 * folding them in would hide the thing being measured behind two hops the tap
 * cannot affect.
 *
 * What it does NOT measure, and must not be read as measuring: the realtime
 * pipeline. A speech-to-speech provider produces audio directly, so none of this
 * code runs and its span is the provider's own. That row in the doc stays empty
 * until someone records it with a key and a microphone.
 *
 * Usage:
 *
 *   npm run acappella:latency                      # both cascade profiles
 *   npm run acappella:latency -- --profile hosted
 *   npm run acappella:latency -- --runs 3 --json
 *
 * A full run takes a few minutes, and that is the fixtures rather than the
 * harness: a long agent reply takes a long time to write, and shortening it would
 * shorten the very silence the layer exists to fill.
 */

import { EventEmitter } from 'events';

import { createAgentOutputTap } from '../src/main/acappella/speech/agent-output-tap';
import { ConversationalTranslator } from '../src/main/acappella/speech/conversational-translator';
import { SpeechScheduler } from '../src/main/acappella/speech/speech-scheduler';
import { buildProcessSessionId } from '../src/main/dispatch-callbacks/dispatch-callback-registry';
import type {
	BrainProvider,
	TtsChunk,
	TtsProvider,
	VoiceConverseContext,
} from '../src/shared/acappella/providers';
import type { RouteDecision } from '../src/shared/acappella/route-decision';

// ---------------------------------------------------------------------------
// Provider cost profiles
// ---------------------------------------------------------------------------

/**
 * What a hop costs. Round numbers on purpose: these are the harness's INPUT, not
 * a claim about any provider on any day. They exist so the two arms are compared
 * under the same conditions, and so a change in the layer shows up as a change in
 * the gap between them rather than as noise.
 */
interface Profile {
	key: string;
	label: string;
	/** Silence before the rewrite's first token. A local model load is not included. */
	brainFirstTokenMs: number;
	/** Between rewrite tokens, once it has started. */
	brainTokenMs: number;
	/** Synthesis of one sentence, before any of its audio exists. */
	ttsBaseMs: number;
	/** Added per character of the sentence being synthesised. */
	ttsPerCharMs: number;
	/** How fast the agent itself writes, in characters per second. */
	agentCharsPerSecond: number;
}

const PROFILES: Profile[] = [
	{
		key: 'local',
		label: 'Fully local cascade (Qwen3 Brain, Kokoro TTS)',
		brainFirstTokenMs: 320,
		brainTokenMs: 12,
		ttsBaseMs: 180,
		ttsPerCharMs: 1.2,
		agentCharsPerSecond: 220,
	},
	{
		key: 'hosted',
		label: 'Fully hosted cascade (OpenAI Brain, ElevenLabs TTS)',
		brainFirstTokenMs: 480,
		brainTokenMs: 8,
		ttsBaseMs: 260,
		ttsPerCharMs: 0.6,
		agentCharsPerSecond: 220,
	},
];

/**
 * Speaking rate used to simulate playback offline, in characters per second.
 *
 * Roughly 150 words a minute, which is unhurried assistant speech. Only the
 * inter-sentence gap depends on it: a gap exists when the next sentence's audio
 * is not ready by the time the current one stops being audible.
 */
const SPEECH_CHARS_PER_SECOND = 14;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
	key: string;
	label: string;
	text: string;
}

/** A paragraph of the long summary, repeated with varying detail. */
function summaryParagraph(n: number): string {
	return [
		`Step ${n}: reworked the token check so a refresh that lands mid-request is not`,
		`treated as an expiry. The old path compared the issued-at stamp against the`,
		`request clock, which drifts, so a request that arrived during a refresh was`,
		`rejected and the client retried into the same window. It now compares against`,
		`the session's own high-water mark, which only moves forward.`,
	].join(' ');
}

/**
 * The three shapes an agent replies in, at the sizes they really are.
 *
 * Size is not decoration here: the whole point of the tap is that a long reply
 * takes a long time to WRITE, so shrinking the fixtures to make the harness quick
 * would shrink the effect being measured. These are trimmed to the smallest size
 * that still takes tens of seconds to produce, which is what makes a run a few
 * minutes rather than a coffee break.
 */
const FIXTURES: Fixture[] = [
	{
		key: 'long-summary',
		label: 'A long implementation summary (about 100 lines)',
		text: [
			'I fixed the authentication bug. It was a stale token check in the refresh path.',
			'',
			...Array.from({ length: 20 }, (_, i) => [summaryParagraph(i + 1), '']).flat(),
			'All 214 tests pass and the lint is clean.',
		].join('\n'),
	},
	{
		key: 'diff-heavy',
		label: 'A diff-heavy reply',
		text: [
			'Here is the change to the middleware.',
			'',
			'```diff',
			'--- a/src/auth/middleware.ts',
			'+++ b/src/auth/middleware.ts',
			...Array.from({ length: 40 }, (_, i) => `-\tconst stale${i} = issuedAt < now;`),
			...Array.from({ length: 40 }, (_, i) => `+\tconst stale${i} = issuedAt < highWater;`),
			'```',
			'',
			'The high-water mark only moves forward, so a refresh landing mid-request is no',
			'longer read as an expiry and the client stops retrying into the same window.',
		].join('\n'),
	},
	{
		key: 'confirmation',
		label: 'A one-line confirmation',
		text: 'Yes, the tests pass.',
	},
];

// ---------------------------------------------------------------------------
// Stub providers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A Brain that writes a plausible spoken rewrite at the profile's declared rate.
 *
 * The content is fixed rather than generated: this harness measures WHEN words
 * arrive, and a model deciding what to say would make two runs incomparable. The
 * shape is what matters - two short sentences, no markdown - because that is what
 * the translator and the splitter downstream have to handle.
 */
function stubBrain(profile: Profile): BrainProvider {
	async function* write(agentText: string, context: VoiceConverseContext): AsyncIterable<string> {
		await sleep(profile.brainFirstTokenMs);
		const words = rewriteFor(agentText).split(' ');
		for (const word of words) {
			if (context.signal?.aborted) return;
			yield `${word} `;
			await sleep(profile.brainTokenMs);
		}
	}

	return {
		id: 'stub-brain',
		label: 'Stub Brain',
		tier: 'mock',
		route: (): Promise<RouteDecision> => {
			throw new Error('the latency harness never routes');
		},
		converse: async (agentText, context) => {
			let whole = '';
			for await (const delta of write(agentText, context)) whole += delta;
			return whole.trim();
		},
		converseStream: write,
	};
}

/** Two sentences and nothing markdown-shaped, sized from the source. */
function rewriteFor(agentText: string): string {
	if (agentText.length < 200) return 'Yes, everything passes.';
	return (
		'Done, I fixed the auth bug and it turned out to be a stale token check. ' +
		'Everything passes now.'
	);
}

/** Synthesis whose cost scales with the sentence, which is how real TTS behaves. */
function stubTts(profile: Profile): TtsProvider {
	let cancelled = false;
	let index = 0;

	return {
		id: 'stub-tts',
		label: 'Stub TTS',
		tier: 'mock',
		cancel: () => {
			cancelled = true;
		},
		speak: async function* (text: string, options): AsyncIterable<TtsChunk> {
			await sleep(profile.ttsBaseMs + text.length * profile.ttsPerCharMs);
			if (cancelled) return;
			yield {
				utteranceId: options.utteranceId,
				index: index++,
				text,
				format: 'none',
				audio: null,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// One measured turn
// ---------------------------------------------------------------------------

interface TurnResult {
	/** Agent first token to the first sentence whose audio exists. */
	firstSpokenWordMs: number;
	/**
	 * The same, ignoring the tap's own status lines.
	 *
	 * These are not the same number and conflating them flatters the result. A
	 * reply the layer cannot start speaking still produces sound at the twenty
	 * second mark, because the tap says the agent is still working rather than
	 * going silent. Counting that as the first spoken word would score the safety
	 * net as if it were the answer.
	 */
	firstAnswerWordMs: number;
	/** Longest silence between two sentences, once playback is simulated. */
	maxGapMs: number;
	meanGapMs: number;
	sentences: number;
	/** The rewrite reached the model, or was passed through untouched. */
	translated: boolean;
	/**
	 * When each sentence's audio existed, in order.
	 *
	 * Reported under `--json` because an aggregate gap is not diagnosable: a long
	 * one can be the layer stalling or the agent writing something unspeakable,
	 * and only the stamps say which.
	 */
	stamps: { at: number; chars: number; status: boolean }[];
}

const AGENT_SESSION_ID = 'sess-backend';
const TAB_ID = 'tab-auth-refactor';

/**
 * Run one fixture through the real layer and record when each sentence's audio
 * became available.
 *
 * `arm` decides only WHEN the agent's text reaches the tap: `streamed` writes it
 * at the profile's rate, `buffered` withholds every character until the reply is
 * finished. Nothing else differs, so the difference in the result is the tap.
 */
async function measureTurn(
	profile: Profile,
	fixture: Fixture,
	arm: 'streamed' | 'buffered'
): Promise<TurnResult> {
	const source = new EventEmitter();
	const processSessionId = buildProcessSessionId(AGENT_SESSION_ID, TAB_ID);
	const brain = stubBrain(profile);
	const translator = new ConversationalTranslator({ brain });

	/** When each sentence's audio existed, relative to the agent's first token. */
	const available: { text: string; at: number; status: boolean }[] = [];
	/**
	 * Sentences the tap produced about itself rather than about the answer.
	 *
	 * A status chunk is passed through the translator verbatim, so its sentences
	 * arrive at the scheduler with the text they were written with and can be told
	 * apart by identity. Threading a kind through the scheduler instead would put
	 * a harness concern into the protocol.
	 */
	const statusSentences = new Set<string>();
	let startedAt = 0;

	const scheduler = new SpeechScheduler({
		tts: stubTts(profile),
		onStart: () => {},
		onSentence: (event) =>
			available.push({
				text: event.text,
				at: Date.now() - startedAt,
				status: statusSentences.has(event.text),
			}),
		onEnd: () => {},
	});

	const translations: Promise<void>[] = [];
	const tap = createAgentOutputTap({
		source,
		onChunk: (chunk) => {
			translations.push(
				(async () => {
					for await (const sentence of translator.translate({
						agentSessionId: chunk.agentSessionId,
						tabId: chunk.tabId,
						text: chunk.text,
						kind: chunk.kind,
					})) {
						if (chunk.kind === 'status') statusSentences.add(sentence);
						scheduler.pushSentence(sentence);
					}
				})()
			);
		},
	});

	tap.watch({ agentSessionId: AGENT_SESSION_ID, tabId: TAB_ID });
	scheduler.begin(`utt-${fixture.key}-${arm}`);
	startedAt = Date.now();

	await writeAgentOutput(source, processSessionId, fixture.text, profile, arm);
	source.emit('query-complete', processSessionId);

	// Every rewrite that the tap started has to finish before the run can be
	// closed, or the scheduler would end on a gap in the translation rather than
	// on the end of the reply.
	await Promise.all(translations);
	scheduler.close();
	await scheduler.drained();
	tap.dispose();

	return summarise(available, translator.stats.translations > 0);
}

/**
 * Feed the agent's reply to the tap the way the process manager would.
 *
 * `buffered` is not "one event at the end of an instant reply": the agent takes
 * just as long to write either way. Withholding the text until the reply is
 * finished, at the same write rate, is what makes the arms comparable.
 */
async function writeAgentOutput(
	source: EventEmitter,
	processSessionId: string,
	text: string,
	profile: Profile,
	arm: 'streamed' | 'buffered'
): Promise<void> {
	const perEvent = 120;
	const delay = (perEvent / profile.agentCharsPerSecond) * 1000;

	if (arm === 'buffered') {
		// The same write time as the streamed arm, spent in one silence instead of
		// spread across events. Anything else would compare two different agents.
		const writeMs = (Math.max(0, text.length - perEvent) / profile.agentCharsPerSecond) * 1000;
		await sleep(writeMs);
		source.emit('data', processSessionId, text);
		return;
	}

	for (let i = 0; i < text.length; i += perEvent) {
		// Before the write, not after: a sleep following the LAST event would be
		// charged to the layer as silence the agent had already stopped producing,
		// and on a one-line reply that artefact is bigger than the thing measured.
		if (i > 0) await sleep(delay);
		source.emit('data', processSessionId, text.slice(i, i + perEvent));
	}
}

/**
 * Turn availability stamps into the two numbers the doc asks for.
 *
 * The gap is simulated rather than observed because the scheduler hands audio to
 * a sink and does not wait for it to be heard. A sentence's audio being ready
 * before the previous one stops being audible is exactly the no-gap property, and
 * it is computable from the stamps: play serially at a speaking rate and see
 * where the player runs out of material.
 */
function summarise(
	available: { text: string; at: number; status: boolean }[],
	translated: boolean
): TurnResult {
	const stamps = available.map((entry) => ({
		at: entry.at,
		chars: entry.text.length,
		status: entry.status,
	}));
	if (available.length === 0) {
		return {
			firstSpokenWordMs: -1,
			firstAnswerWordMs: -1,
			maxGapMs: 0,
			meanGapMs: 0,
			sentences: 0,
			translated,
			stamps,
		};
	}

	const gaps: number[] = [];
	let playbackEnd = available[0].at;
	for (let i = 0; i < available.length; i++) {
		const start = i === 0 ? available[0].at : Math.max(playbackEnd, available[i].at);
		if (i > 0) gaps.push(Math.max(0, available[i].at - playbackEnd));
		playbackEnd = start + (available[i].text.length / SPEECH_CHARS_PER_SECOND) * 1000;
	}

	return {
		firstSpokenWordMs: available[0].at,
		firstAnswerWordMs: available.find((entry) => !entry.status)?.at ?? -1,
		maxGapMs: gaps.length ? Math.max(...gaps) : 0,
		meanGapMs: gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0,
		sentences: available.length,
		translated,
		stamps,
	};
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Row {
	profile: string;
	fixture: string;
	arm: 'streamed' | 'buffered';
	firstSpokenWordMs: number;
	firstAnswerWordMs: number;
	maxGapMs: number;
	meanGapMs: number;
	sentences: number;
	translated: boolean;
	/** First run's stamps, for diagnosing a gap rather than just reporting one. */
	stamps: { at: number; chars: number; status: boolean }[];
}

interface Options {
	profiles: Profile[];
	runs: number;
	json: boolean;
}

async function run(options: Options): Promise<void> {
	const rows: Row[] = [];

	for (const profile of options.profiles) {
		for (const fixture of FIXTURES) {
			for (const arm of ['streamed', 'buffered'] as const) {
				const results: TurnResult[] = [];
				for (let i = 0; i < options.runs; i++) {
					results.push(await measureTurn(profile, fixture, arm));
				}
				rows.push({
					profile: profile.key,
					fixture: fixture.key,
					arm,
					firstSpokenWordMs: median(results.map((r) => r.firstSpokenWordMs)),
					firstAnswerWordMs: median(results.map((r) => r.firstAnswerWordMs)),
					maxGapMs: median(results.map((r) => r.maxGapMs)),
					meanGapMs: median(results.map((r) => r.meanGapMs)),
					sentences: results[0].sentences,
					translated: results[0].translated,
					stamps: results[0].stamps,
				});
			}
		}
	}

	report(options, rows);
}

/** Median, because the first run of anything pays for a warm-up nobody hears twice. */
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : (sorted[mid] ?? 0);
	return Math.round(value);
}

function report(options: Options, rows: Row[]): void {
	if (options.json) {
		console.log(JSON.stringify({ rows, speechCharsPerSecond: SPEECH_CHARS_PER_SECOND }, null, 2));
		return;
	}

	console.log('');
	console.log(`Runs per cell: ${options.runs} (median reported). Zero point: agent first token.`);

	for (const profile of options.profiles) {
		console.log('');
		console.log(profile.label);
		console.log('');
		console.log(
			'| Fixture | Arm | First sound | First word of the answer | Max gap | Sentences | Rewrite |'
		);
		console.log(
			'| ------- | --- | ----------- | ------------------------ | ------- | --------- | ------- |'
		);
		for (const row of rows.filter((candidate) => candidate.profile === profile.key)) {
			console.log(
				`| ${row.fixture} | ${row.arm} | ${row.firstSpokenWordMs} ms | ` +
					`${row.firstAnswerWordMs} ms | ${row.maxGapMs} ms | ${row.sentences} | ` +
					`${row.translated ? 'model' : 'passthrough'} |`
			);
		}
	}

	console.log('');
	for (const profile of options.profiles) {
		for (const fixture of FIXTURES) {
			const streamed = find(rows, profile.key, fixture.key, 'streamed');
			const buffered = find(rows, profile.key, fixture.key, 'buffered');
			if (!streamed || !buffered) continue;
			// Against the answer, not against the first sound: the buffered arm's first
			// sound on a long reply is the tap's twenty second hang notice, and scoring
			// the layer against its own safety net would understate it by a factor of
			// three.
			const saved = buffered.firstAnswerWordMs - streamed.firstAnswerWordMs;
			console.log(
				`${profile.key}/${fixture.key}: the tap saves ${saved} ms of silence ` +
					`(${buffered.firstAnswerWordMs} ms buffered, ${streamed.firstAnswerWordMs} ms streamed).`
			);
		}
	}

	console.log('');
	console.log('Paste the rows into docs/architecture/acappella/latency-baseline.md.');
	console.log('Realtime is not measured here: that provider speaks directly and this layer');
	console.log('never runs. Its row stays empty until it is recorded with a key and a mic.');
}

function find(rows: Row[], profile: string, fixture: string, arm: Row['arm']): Row | undefined {
	return rows.find((row) => row.profile === profile && row.fixture === fixture && row.arm === arm);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Options {
	let profileKey = 'both';
	// One by default. A cell's cost is dominated by declared sleeps rather than by
	// machine load, so repeats buy little, and a fixture that takes half a minute
	// to write makes three of everything a five minute wait.
	let runs = 1;
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--profile') profileKey = argv[++i];
		else if (arg === '--runs') runs = Number(argv[++i]);
		else if (arg === '--json') json = true;
		else throw new Error(`Unknown option: ${arg}`);
	}

	const profiles =
		profileKey === 'both' ? PROFILES : PROFILES.filter((profile) => profile.key === profileKey);
	if (profiles.length === 0) throw new Error(`Unknown profile: ${profileKey}`);
	if (!Number.isFinite(runs) || runs < 1) throw new Error(`Runs must be at least 1`);

	return { profiles, runs, json };
}

run(parseArgs(process.argv.slice(2))).catch((error: Error) => {
	console.error(`Speech latency harness failed: ${error.message}`);
	process.exit(1);
});
