/**
 * Pipeline color utilities for the visual Cue pipeline editor.
 */

import type { CuePipeline } from '../../../shared/cue-pipeline-types';

/** 12 visually distinct colors suitable for dark backgrounds */
export const PIPELINE_COLORS: string[] = [
	'#ef4444', // red
	'#f97316', // orange
	'#eab308', // yellow
	'#22c55e', // green
	'#06b6d4', // cyan
	'#3b82f6', // blue
	'#8b5cf6', // violet
	'#d946ef', // fuchsia
	'#ec4899', // pink
	'#f43f5e', // rose
	'#14b8a6', // teal
	'#84cc16', // lime
];

/** Returns the first unused color from the palette, cycling if all used. */
export function getNextPipelineColor(pipelines: CuePipeline[]): string {
	const usedColors = new Set(pipelines.map((p) => p.color));
	for (const color of PIPELINE_COLORS) {
		if (!usedColors.has(color)) {
			return color;
		}
	}
	return PIPELINE_COLORS[pipelines.length % PIPELINE_COLORS.length];
}

/** Returns array of pipeline colors that reference the given agent session ID. */
export function getPipelineColorForAgent(
	agentSessionId: string,
	pipelines: CuePipeline[]
): string[] {
	const colors: string[] = [];
	for (const pipeline of pipelines) {
		for (const node of pipeline.nodes) {
			if (
				node.type === 'agent' &&
				'sessionId' in node.data &&
				node.data.sessionId === agentSessionId
			) {
				if (!colors.includes(pipeline.color)) {
					colors.push(pipeline.color);
				}
				break;
			}
		}
	}
	return colors;
}
