/**
 * Canonical project-relative paths for Maestro-managed files.
 *
 * All Maestro files live under `.maestro/` in the project root.
 * Legacy paths are retained for backwards compatibility (read-only fallback).
 */

// ── Current (canonical) paths ────────────────────────────────────────────────

/** Root directory for all Maestro project files */
export const MAESTRO_DIR = '.maestro';

/** Playbook (Auto Run) documents folder */
export const PLAYBOOKS_DIR = '.maestro/playbooks';

/** Just the folder name (for display and path construction) */
export const PLAYBOOKS_FOLDER_NAME = 'playbooks';

/** Working copies created during Auto Run loops */
export const PLAYBOOKS_RUNS_DIR = '.maestro/playbooks/runs';

/** Cue configuration file */
export const CUE_CONFIG_PATH = '.maestro/cue.yaml';

/** Default directory for Cue prompt files */
export const CUE_PROMPTS_DIR = '.maestro/prompts';

/** Default pipeline input prompt filename */
export const PIPELINE_INPUT_PROMPT = 'pipeline-in.md';

/** Default pipeline output prompt filename */
export const PIPELINE_OUTPUT_PROMPT = 'pipeline-out.md';

// ── Legacy paths (backwards compatibility, read-only fallback) ───────────────

/** @deprecated Use PLAYBOOKS_DIR */
export const LEGACY_PLAYBOOKS_DIR = 'Auto Run Docs';

/** @deprecated Use PLAYBOOKS_RUNS_DIR */
export const LEGACY_PLAYBOOKS_RUNS_DIR = 'Auto Run Docs/Runs';

/** @deprecated Use CUE_CONFIG_PATH */
export const LEGACY_CUE_CONFIG_PATH = 'maestro-cue.yaml';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return all directory names within .maestro that should always be visible
 * in the file explorer (regardless of gitignore).
 */
export const ALWAYS_VISIBLE_ENTRIES = new Set([MAESTRO_DIR]);
