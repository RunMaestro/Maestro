/**
 * Previews of what a repeated file read could shrink to: a short "unchanged"
 * reference for a re-read that matches the earlier one, or the lines that
 * differ for one that changed.
 *
 * A preview only MEASURES. It builds the text a replacement would carry, counts
 * it against the re-read the agent really sent, and reports the difference as a
 * potential reduction. It edits no request, opens no cache and keeps nothing
 * between calls, so what the model is shown, and every verdict the cache has
 * frozen, are exactly what they were.
 *
 * ## Inputs
 *
 * Only pairs the analyzer approved are previewed: the `repeat` findings of
 * `analyzeReadOpportunities()`. A finding holds hashes and sizes, never text, so
 * the texts come from the events the report was built from, and every text is
 * checked against the hash the finding carries before it is used. A report and
 * a set of events that are not the same analysis produce `source-mismatch`.
 *
 * ## A usable baseline
 *
 * A delta is only as good as the model's copy of the baseline. The analyzer
 * proves the baseline is in the same request, in the same context, with no reset
 * between; nothing else is inferred. Whether the model is SHOWN the baseline as
 * the agent sent it is something only the caller knows: the proxy may have
 * shortened it on the way. The caller says so per result (`deliveries`), and a
 * baseline not proven `whole` has no preview, because a diff against text the
 * model does not hold is worse than no diff. How long ago the baseline was read
 * is never evidence.
 *
 * Two more refusals keep the figures honest. A baseline that is itself the target
 * of a preview in this report is refused (`baseline-previewed`): replacing it
 * would leave the model without its full text, so the pair's figure would
 * overstate, and refusing keeps the totals additive. And a preview must be at
 * least {@link MIN_SAVING_RATIO} smaller than the re-read with every marker
 * line counted, the bar the compressor holds its own replacements to.
 *
 * ## What the figures are
 *
 * Every figure is measured against the re-read exactly as the agent sent it
 * ({@link PotentialReduction.basis}), before any compression the proxy applies,
 * and says so. It is not a saving: nothing was replaced. Where the proxy also
 * shortens the re-read, the two reductions overlap; `targetDelivery` tells which
 * case a preview is in.
 *
 * ## Work bounds
 *
 * Every limit in {@link READ_PREVIEW_LIMITS} is explicit and lowerable per call.
 * Sizes are checked against the finding before any text is hashed or diffed.
 * The diff's cost is bounded by `maxEditLines` (jsdiff's `maxEditLength`), not
 * by a clock, so the same input gives the same output on a loaded machine. A
 * bound never produces a preview.
 */

import { formatPatch, OMIT_HEADERS, structuredPatch } from 'diff';
import { estimateTokenCount } from '../../../shared/formatters';
import { MIN_SAVING_RATIO, type ToolResultDescriptor } from './compress';
import { contentHash } from './compression-cache';
import { stringValue } from './json-spans';
import {
	withoutLineNumbers,
	type ReadEvent,
	type ReadFinding,
	type ReadOpportunityReport,
	type ReadVersion,
} from './read-opportunities';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface ReadPreviewLimits {
	/** Repeated reads previewed per request. The rest are `over-budget`. */
	maxPairs: number;
	/** Characters of either text of one pair. */
	maxPairChars: number;
	/** Characters across both texts of every pair examined. */
	maxTotalChars: number;
	/** Lines of either text of one pair. */
	maxLines: number;
	/**
	 * Lines a delta may add plus remove (a changed line counts twice). This is
	 * jsdiff's `maxEditLength`: it bounds the diff's work by the size of the
	 * change instead of by elapsed time.
	 */
	maxEditLines: number;
	/** Unchanged lines kept around each change. */
	contextLines: number;
}

/**
 * Tighter than the analyzer's own limits on purpose: the analyzer hashes and
 * scans, a preview also diffs. The line limit matches the default length of one
 * Read of a file.
 */
export const READ_PREVIEW_LIMITS: Readonly<ReadPreviewLimits> = Object.freeze({
	maxPairs: 64,
	maxPairChars: 262_144,
	maxTotalChars: 2_097_152,
	maxLines: 5_000,
	maxEditLines: 256,
	contextLines: 3,
});

/** Said wherever a preview figure is shown. */
export const READ_PREVIEW_NOTE =
	'Potential reduction only. Each figure compares a re-read, as the agent sent it, with the preview that could stand in for it. Nothing was replaced and nothing was saved. Token counts are estimates at 4 characters per token.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the model is shown for one tool result of the request, as the caller
 * proved it. `whole`: the exact text the agent sent. `replaced`: another text
 * (the proxy shortened it, for one). A result with no entry is unproven.
 */
export type ResultDelivery = 'whole' | 'replaced';

/** Why a repeated read has no preview. A reason names the missing evidence or the bound. */
export type ReadPreviewUnsupportedReason =
	/** A work bound was reached before this pair was examined. */
	| 'over-budget'
	/** The events hold no text for one of the pair's reads. */
	| 'source-missing'
	/** The text supplied is not the text the finding hashed, or the finding contradicts itself. */
	| 'source-mismatch'
	/** The caller proved the model is shown another text for the baseline. */
	| 'baseline-replaced'
	/** No evidence says what the model is shown for the baseline. */
	| 'baseline-unproven'
	/** The baseline is itself the target of a preview in this report. */
	| 'baseline-previewed'
	/** Either text is longer than {@link ReadPreviewLimits.maxPairChars}. */
	| 'too-large'
	/** Either text has more lines than {@link ReadPreviewLimits.maxLines}. */
	| 'too-many-lines'
	/** The change is longer than {@link ReadPreviewLimits.maxEditLines}, so no delta was computed. */
	| 'diff-too-large'
	/** The texts differ only in how the line numbers are printed. */
	| 'no-line-changes'
	/** The preview, markers included, is not {@link MIN_SAVING_RATIO} smaller than the re-read. */
	| 'insufficient-reduction';

export type ReadPreviewKind = 'unchanged' | 'delta';

/** The only basis on which a baseline counts as visible. */
export type BaselineBasis = 'same-request-delivered-whole';

/** What a preview could remove from the re-read. It is a measurement, never a saving. */
export interface PotentialReduction {
	kind: 'potential-reduction';
	/** Always false: nothing here changed a request or reached a model. */
	realized: false;
	/** The re-read exactly as the agent sent it, before any compression the proxy applies. */
	basis: 'text-as-sent';
	tokenCountKind: 'character-estimate';
	fullChars: number;
	fullTokens: number;
	/** The whole preview text: its markers, hunk headers and lines. */
	previewChars: number;
	previewTokens: number;
	reducibleChars: number;
	reducibleTokens: number;
}

export interface ReadPreviewChanges {
	hunks: number;
	/** Lines the delta adds and removes. */
	added: number;
	removed: number;
}

export type ReadPreview =
	| {
			status: 'preview';
			kind: ReadPreviewKind;
			/** The earlier read the model already holds. */
			baseline: ReadVersion;
			/** The re-read the preview would stand in for. */
			target: ReadVersion;
			baselineBasis: BaselineBasis;
			/** What the model is shown for the re-read itself; `replaced` or `unproven` means compression overlaps. */
			targetDelivery: ResultDelivery | 'unproven';
			potential: PotentialReduction;
			/** Null for `unchanged`. */
			changes: ReadPreviewChanges | null;
			/** The text a replacement would carry. It holds lines of the file. */
			text: string;
	  }
	| {
			status: 'unsupported';
			reason: ReadPreviewUnsupportedReason;
			baseline: ReadVersion;
			target: ReadVersion;
	  };

export interface ReadPreviewCounts {
	/** Repeated reads the analyzer approved; each has exactly one entry. */
	examined: number;
	unchanged: number;
	delta: number;
	unsupported: number;
	unsupportedByReason: Partial<Record<ReadPreviewUnsupportedReason, number>>;
	/** Sum over the previews. Additive, because no baseline is itself previewed. */
	potentialChars: number;
	potentialTokens: number;
}

export interface ReadPreviewReport {
	version: 1;
	/** A report measures text that was never sent. Nothing in it edits a request or a cached verdict. */
	mode: 'preview';
	note: typeof READ_PREVIEW_NOTE;
	/** False when the analyzer or a work bound here left pairs unexamined. */
	complete: boolean;
	limits: ReadPreviewLimits;
	previews: ReadPreview[];
	counts: ReadPreviewCounts;
}

export interface ReadPreviewInput {
	/** `analyzeReadOpportunities()` output. Only its `repeat` findings are previewed. */
	report: ReadOpportunityReport;
	/** The events that report was built from. The only source of text. */
	events: readonly ReadEvent[];
	/** By the event's `order`. See {@link resultDeliveries}. */
	deliveries: ReadonlyMap<number, ResultDelivery>;
	limits?: Partial<ReadPreviewLimits>;
}

// ---------------------------------------------------------------------------
// Delivery evidence
// ---------------------------------------------------------------------------

/** A request body and its `findToolResultDescriptors()` output. */
export interface RequestView {
	body: string;
	descriptors: readonly ToolResultDescriptor[];
}

function singleText(view: RequestView, order: number): string | undefined {
	const descriptor = view.descriptors[order];
	if (!descriptor || descriptor.contentStatus !== 'text' || descriptor.contentSpans.length !== 1) {
		return undefined;
	}
	return stringValue(view.body, descriptor.contentSpans[0]);
}

/**
 * What the model is shown for each tool result, from the request as the agent
 * sent it and the request as the proxy forwards it. Results are matched by
 * position, which holds because compression replaces the text of a result in
 * place and moves nothing. A forwarded body that is the sent body is `whole`
 * throughout; one whose results cannot be lined up proves nothing, and a result
 * whose text cannot be read on both sides has no entry.
 */
export function resultDeliveries(
	sent: RequestView,
	forwarded: RequestView
): Map<number, ResultDelivery> {
	const deliveries = new Map<number, ResultDelivery>();
	if (forwarded.body === sent.body) {
		for (let order = 0; order < sent.descriptors.length; order++) deliveries.set(order, 'whole');
		return deliveries;
	}
	if (forwarded.descriptors.length !== sent.descriptors.length) return deliveries;
	for (let order = 0; order < sent.descriptors.length; order++) {
		const before = singleText(sent, order);
		const after = singleText(forwarded, order);
		if (before !== undefined && after !== undefined) {
			deliveries.set(order, before === after ? 'whole' : 'replaced');
		}
	}
	return deliveries;
}

// ---------------------------------------------------------------------------
// Preview text
// ---------------------------------------------------------------------------

/** Hex characters of a SHA-256 that a marker names a version by. Shared by every preview kind. */
export const MARKER_HASH_CHARS = 12;

/** A call id a marker may carry as it stands; anything else is left out of the marker. */
const SAFE_CALL_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The part of a marker that names the baseline the preview refers to. */
function baselineRef(baseline: ReadVersion): string {
	const call =
		baseline.callId !== null && SAFE_CALL_ID.test(baseline.callId)
			? `baseline=${baseline.callId} `
			: '';
	return `${call}sha256=${baseline.hash.slice(0, MARKER_HASH_CHARS)}`;
}

function unchangedText(baseline: ReadVersion, target: ReadVersion): string {
	return `[maestro-preview unchanged-read ${baselineRef(baseline)} lines=${target.lines}]`;
}

type DeltaResult =
	| { ok: true; text: string; changes: ReadPreviewChanges }
	| { ok: false; reason: 'diff-too-large' | 'no-line-changes' };

/**
 * The lines that differ between two reads of one range, as unified-diff hunks.
 * A numbered read is diffed without its printed numbers, so lines that merely
 * moved are not changes, and its hunks carry the file's own line numbers. A plain
 * read has no line numbers to print: its hunks count lines of the returned text.
 */
function lineDelta(
	baseline: ReadVersion,
	target: ReadVersion,
	before: string,
	after: string,
	limits: ReadPreviewLimits
): DeltaResult {
	const printed = baseline.numbered;
	const patch = structuredPatch(
		'',
		'',
		printed ? withoutLineNumbers(before) : before,
		printed ? withoutLineNumbers(after) : after,
		undefined,
		undefined,
		{ context: limits.contextLines, maxEditLength: limits.maxEditLines }
	);
	if (!patch) return { ok: false, reason: 'diff-too-large' };
	if (patch.hunks.length === 0) return { ok: false, reason: 'no-line-changes' };

	let added = 0;
	let removed = 0;
	for (const hunk of patch.hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith('+')) added++;
			else if (line.startsWith('-')) removed++;
		}
	}
	const shift = printed ? printed.startLine - 1 : 0;
	const hunks = formatPatch(
		{
			...patch,
			hunks: patch.hunks.map((hunk) => ({
				...hunk,
				oldStart: hunk.oldStart + shift,
				newStart: hunk.newStart + shift,
			})),
		},
		OMIT_HEADERS
	);
	const header =
		`[maestro-preview read-delta ${baselineRef(baseline)} ` +
		`target-sha256=${target.hash.slice(0, MARKER_HASH_CHARS)} ` +
		`positions=${printed ? 'file' : 'text'} lines=+${added}/-${removed}]`;
	return {
		ok: true,
		text: `${header}\n${hunks}`,
		changes: { hunks: patch.hunks.length, added, removed },
	};
}

/**
 * The figure for one preview: the text it could stand in for, measured against
 * the preview with every marker line counted. Every kind of preview builds its
 * figure here, so the figures are measured the same way and mean the same thing.
 */
export function potentialReduction(full: string, preview: string): PotentialReduction {
	const fullTokens = estimateTokenCount(full);
	const previewTokens = estimateTokenCount(preview);
	return {
		kind: 'potential-reduction',
		realized: false,
		basis: 'text-as-sent',
		tokenCountKind: 'character-estimate',
		fullChars: full.length,
		fullTokens,
		previewChars: preview.length,
		previewTokens,
		reducibleChars: full.length - preview.length,
		reducibleTokens: Math.max(0, fullTokens - previewTokens),
	};
}

// ---------------------------------------------------------------------------
// Building the previews
// ---------------------------------------------------------------------------

type RepeatFinding = Extract<ReadFinding, { status: 'repeat' }>;

function emptyCounts(): ReadPreviewCounts {
	return {
		examined: 0,
		unchanged: 0,
		delta: 0,
		unsupported: 0,
		unsupportedByReason: {},
		potentialChars: 0,
		potentialTokens: 0,
	};
}

/**
 * Preview the repeated reads of one analysis. Pure and deterministic: the inputs
 * are not modified, and the same inputs give the same report.
 *
 * Every `repeat` finding gets exactly one entry, in the report's order: a
 * preview, or `unsupported` with the reason. `first` and `unsupported` findings
 * of the analyzer are not pairs and get none.
 */
export function buildReadPreviews(input: ReadPreviewInput): ReadPreviewReport {
	const limits: ReadPreviewLimits = { ...READ_PREVIEW_LIMITS, ...input.limits };
	const texts = new Map<number, string>();
	for (const event of input.events) if (event.status === 'read') texts.set(event.order, event.text);
	const hashes = new Map<number, string>();
	const hashOf = (order: number, text: string): string => {
		let hash = hashes.get(order);
		if (hash === undefined) hashes.set(order, (hash = contentHash(text)));
		return hash;
	};

	const previews: ReadPreview[] = [];
	const counts = emptyCounts();
	/** Targets of the previews built so far: replacing one would leave the model without its full text. */
	const previewedTargets = new Set<number>();
	let total = 0;
	let complete = input.report.complete;

	const evaluate = (finding: RepeatFinding): ReadPreview => {
		const { baseline, read: target } = finding;
		const refuse = (reason: ReadPreviewUnsupportedReason): ReadPreview => ({
			status: 'unsupported',
			reason,
			baseline,
			target,
		});

		if (counts.examined > limits.maxPairs) {
			complete = false;
			return refuse('over-budget');
		}
		const before = texts.get(baseline.order);
		const after = texts.get(target.order);
		if (before === undefined || after === undefined) return refuse('source-missing');
		if (
			before.length !== baseline.chars ||
			after.length !== target.chars ||
			(finding.relation === 'identical') !== (baseline.hash === target.hash) ||
			baseline.numbered?.startLine !== target.numbered?.startLine
		) {
			return refuse('source-mismatch');
		}

		const delivery = input.deliveries.get(baseline.order);
		if (delivery === 'replaced') return refuse('baseline-replaced');
		if (delivery !== 'whole') return refuse('baseline-unproven');
		if (previewedTargets.has(baseline.order)) return refuse('baseline-previewed');

		if (Math.max(baseline.chars, target.chars) > limits.maxPairChars) return refuse('too-large');
		if (Math.max(baseline.lines, target.lines) > limits.maxLines) return refuse('too-many-lines');
		if (total + baseline.chars + target.chars > limits.maxTotalChars) {
			complete = false;
			return refuse('over-budget');
		}
		total += baseline.chars + target.chars;

		if (hashOf(baseline.order, before) !== baseline.hash) return refuse('source-mismatch');
		if (hashOf(target.order, after) !== target.hash) return refuse('source-mismatch');

		let text: string;
		let changes: ReadPreviewChanges | null = null;
		if (finding.relation === 'identical') {
			text = unchangedText(baseline, target);
		} else {
			const delta = lineDelta(baseline, target, before, after, limits);
			if (!delta.ok) return refuse(delta.reason);
			text = delta.text;
			changes = delta.changes;
		}
		// The compressor's own bar, markers included: a replacement must be clearly smaller.
		const largestPreview = after.length * (1 - MIN_SAVING_RATIO);
		if (text.length > largestPreview) return refuse('insufficient-reduction');

		return {
			status: 'preview',
			kind: finding.relation === 'identical' ? 'unchanged' : 'delta',
			baseline,
			target,
			baselineBasis: 'same-request-delivered-whole',
			targetDelivery: input.deliveries.get(target.order) ?? 'unproven',
			potential: potentialReduction(after, text),
			changes,
			text,
		};
	};

	for (const finding of input.report.findings) {
		if (finding.status !== 'repeat') continue;
		counts.examined++;
		const preview = evaluate(finding);
		previews.push(preview);
		if (preview.status === 'preview') {
			previewedTargets.add(preview.target.order);
			counts[preview.kind]++;
			counts.potentialChars += preview.potential.reducibleChars;
			counts.potentialTokens += preview.potential.reducibleTokens;
		} else {
			counts.unsupported++;
			counts.unsupportedByReason[preview.reason] =
				(counts.unsupportedByReason[preview.reason] ?? 0) + 1;
		}
	}

	return {
		version: 1,
		mode: 'preview',
		note: READ_PREVIEW_NOTE,
		complete,
		limits,
		previews,
		counts,
	};
}
