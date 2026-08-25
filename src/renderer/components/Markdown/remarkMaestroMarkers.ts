/**
 * Turn Maestro's Auto Run markers into renderable nodes so a document preview
 * can show what they do.
 *
 * The markers are HTML comments, which is right for the file format - they are
 * invisible to every other markdown tool, and an agent editing the document
 * leaves them alone. It is wrong for the reader: a gate that will pause the
 * next run, or a halt that will refuse to start it, renders as nothing at all.
 * The user sees a playbook that will not go and no reason why.
 *
 * This plugin runs on the DOCUMENT preset only. A chat message explaining the
 * marker syntax must keep rendering as prose - a pill there would assert that
 * something is configured when there is nothing to configure. See
 * `createMarkdownComponents` for where that line is drawn.
 *
 * Implementation note: markers arrive as mdast `html` nodes whether they sit on
 * their own line (block) or trail a task (inline), so one visitor covers both.
 * The node is replaced with a `paragraph`/`emphasis` carrying `data.hName` and
 * `data.hProperties`, which is mdast's documented hook for choosing the output
 * element. That is deliberately not `rehype-raw`: raw HTML passthrough is off
 * on most document surfaces, and turning it on to render a pill would let every
 * other comment in the file through with it.
 */

import { visit } from 'unist-util-visit';
import type { Root, Html, Parent, RootContent } from 'mdast';
import type { VFile } from 'vfile';
import {
	scanMaestroMarkers,
	hasMaestroMarker,
	type ScannedMarker,
} from '../../../shared/autorunMarkers';

/** Attribute names the pill component reads back off the rendered element. */
export const MARKER_DATA_ATTRIBUTES = {
	kind: 'dataMaestroMarker',
	status: 'dataMaestroMarkerStatus',
	scope: 'dataMaestroMarkerScope',
	label: 'dataMaestroMarkerLabel',
	detail: 'dataMaestroMarkerDetail',
	artifact: 'dataMaestroMarkerArtifact',
} as const;

/**
 * The pill's visible label. Deliberately says what the marker DOES rather than
 * naming the marker: "Pauses here" is actionable, "HITL" is jargon the reader
 * has to have already learned.
 */
function labelFor(marker: ScannedMarker): string {
	if (marker.kind === 'halt') return 'Halted';
	if (marker.kind === 'hitl') return marker.status === 'live' ? 'Pauses here' : 'Approved';
	if (marker.status === 'invalid') return 'Unknown setting';

	const parts: string[] = [];
	// `default` reads as an explicit opt-out rather than a level, so it is shown
	// as such instead of being silently dropped.
	if (marker.hint?.tier) parts.push(`${marker.hint.tier} model`);
	if (marker.hint?.effort) parts.push(`${marker.hint.effort} effort`);
	return parts.length > 0 ? parts.join(', ') : 'Agent default';
}

/** Secondary text: the reason a human is needed, or what was misspelled. */
function detailFor(marker: ScannedMarker): string | undefined {
	if (marker.kind === 'model') {
		const invalid = marker.hint?.invalid;
		if (!invalid?.length) return undefined;
		return invalid.map((entry) => `${entry.attribute}="${entry.value}"`).join(', ');
	}
	return marker.reason;
}

/**
 * Index the document's markers by line so each visited node can find its own.
 * Re-scanning the source rather than parsing the node's text is what gives the
 * pill its STATUS - whether a gate still stands is a property of the document,
 * not of the marker's own characters.
 */
function indexMarkers(source: string): Map<string, ScannedMarker> {
	const byLineAndKind = new Map<string, ScannedMarker>();
	for (const marker of scanMaestroMarkers(source)) {
		// Scanner lines are 0-indexed; mdast positions are 1-indexed.
		byLineAndKind.set(`${marker.line + 1}:${marker.kind}`, marker);
	}
	return byLineAndKind;
}

function markerKindOf(value: string): ScannedMarker['kind'] | undefined {
	if (/<!--\s*MAESTRO:HITL\b/i.test(value)) return 'hitl';
	if (/<!--\s*maestro:halt\b/i.test(value)) return 'halt';
	if (/<!--\s*MAESTRO:MODEL\b/i.test(value)) return 'model';
	return undefined;
}

export function remarkMaestroMarkers() {
	return (tree: Root, file: VFile) => {
		const source = String(file?.value ?? '');
		if (!source || !hasMaestroMarker(source)) return;

		const markers = indexMarkers(source);
		if (markers.size === 0) return;

		visit(tree, 'html', (node: Html, index: number | undefined, parent: Parent | undefined) => {
			if (parent === undefined || index === undefined) return;
			const kind = markerKindOf(node.value);
			if (!kind) return;

			const line = node.position?.start?.line;
			if (typeof line !== 'number') return;
			const marker = markers.get(`${line}:${kind}`);
			// No entry means the scanner skipped it - almost always because it sits
			// inside a fence. Leaving the node untouched keeps it invisible, which
			// is the correct rendering for a documentation example.
			if (!marker) return;

			const detail = detailFor(marker);
			const properties: Record<string, string> = {
				[MARKER_DATA_ATTRIBUTES.kind]: marker.kind,
				[MARKER_DATA_ATTRIBUTES.status]: marker.status,
				[MARKER_DATA_ATTRIBUTES.scope]: marker.scope,
				[MARKER_DATA_ATTRIBUTES.label]: labelFor(marker),
			};
			if (detail) properties[MARKER_DATA_ATTRIBUTES.detail] = detail;
			if (marker.artifact) properties[MARKER_DATA_ATTRIBUTES.artifact] = marker.artifact;

			// A task-scoped marker sits inside the task's own paragraph, so it must
			// stay phrasing content; a standalone one is a block of its own.
			const isInline = marker.scope === 'task';
			const replacement = {
				type: isInline ? 'emphasis' : 'paragraph',
				children: [],
				data: { hName: isInline ? 'span' : 'div', hProperties: properties },
			} as unknown as RootContent;

			parent.children[index] = replacement;
		});
	};
}
