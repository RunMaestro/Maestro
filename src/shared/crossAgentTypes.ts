/**
 * Cross-agent shared constants.
 *
 * SUBSET FILE. On the rc line this module also carries the transcript and
 * context-strategy types for the cross-agent `@mention` pipeline, which pulls
 * in `crossAgentContext.ts` and `mentionPatterns.ts` behind it. That subsystem
 * is not on this branch, and dragging ~430 lines of it across to obtain one
 * color constant would be contamination, not parity. Director's Notes and the
 * shared widget library import `AGENT_COLOR` and nothing else from here.
 *
 * The import path and symbol match the rc definition exactly, so the consuming
 * files stay byte-identical across branches. When the cross-agent pipeline
 * lands here this file is superseded wholesale by the full version - it is a
 * strict subset, so nothing importing it has to change.
 */

/**
 * Display color for cross-agent (AGENT) history entries and graph segments.
 *
 * A fixed hue rather than a theme token, matching the `CUE_COLOR` precedent:
 * the theme-derived slots are already spoken for (accent = USER, warning =
 * AUTO, success/error = the run indicator), so a token would collide in some
 * palette. Magenta sits far from CUE's cyan and AUTO's orange everywhere.
 * Lives here (not in a renderer module) so the shared widget library and the
 * History surfaces can both reach it.
 */
export const AGENT_COLOR = '#ec4899';
