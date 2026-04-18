/**
 * Pipeline color utilities for the visual Cue pipeline editor.
 *
 * The palette and next-color assignment live in `shared/cue-pipeline-types.ts`
 * so the YAML load path and the renderer creation path share a single source
 * of truth. This module re-exports those primitives and owns renderer-only
 * helpers (e.g. per-agent color lookup).
 */

import type { CuePipeline } from '../../../shared/cue-pipeline-types';

export { PIPELINE_COLORS, getNextPipelineColor } from '../../../shared/cue-pipeline-types';

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
