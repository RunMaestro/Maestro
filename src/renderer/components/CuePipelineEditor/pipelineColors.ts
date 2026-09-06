/**
 * Pipeline color utilities for the visual Cue pipeline editor.
 *
 * The palette and next-color assignment live in `shared/cue-pipeline-types.ts`
 * so the YAML load path and the renderer creation path share a single source
 * of truth. This module re-exports those primitives.
 *
 * Per-agent pipeline lookup lives in `utils/pipelineMembership.ts`. It has to
 * match command nodes and cue.yaml ownership as well as agent nodes, which is
 * a membership question rather than a color one.
 */

export { PIPELINE_COLORS, getNextPipelineColor } from '../../../shared/cue-pipeline-types';
