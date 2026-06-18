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

/** Shared history directory for cross-host history sync */
export const SHARED_HISTORY_DIR = '.maestro/history';

/** Cue configuration file */
export const CUE_CONFIG_PATH = '.maestro/cue.yaml';

/** Default directory for Cue prompt files */
export const CUE_PROMPTS_DIR = '.maestro/prompts';

// ── Legacy paths (backwards compatibility, read-only fallback) ───────────────

/** @deprecated Use PLAYBOOKS_DIR */
export const LEGACY_PLAYBOOKS_DIR = 'Auto Run Docs';

/** @deprecated Use CUE_CONFIG_PATH */
export const LEGACY_CUE_CONFIG_PATH = 'maestro-cue.yaml';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a prompt file path for a Cue pipeline agent.
 * Convention: .maestro/prompts/{agentName}-{pipelineName}.md
 * Spaces are replaced with underscores.
 */
export function cuePromptFilePath(
	agentName: string,
	pipelineName: string,
	suffix?: string
): string {
	const sanitize = (s: string) => s.replace(/\s+/g, '_').toLowerCase();
	const base = `${sanitize(agentName)}-${sanitize(pipelineName)}`;
	const filename = suffix ? `${base}-${suffix}.md` : `${base}.md`;
	return `${CUE_PROMPTS_DIR}/${filename}`;
}
