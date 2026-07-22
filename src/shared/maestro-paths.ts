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

/** Time-Traveling Stream Rules (TTSR) configuration file */
export const TTSR_CONFIG_PATH = '.maestro/ttsr.yaml';

/** Directory holding one frontmatter-markdown TTSR rule per file */
export const TTSR_RULES_DIR = '.maestro/rules';

/**
 * Where rendered diagrams (agent-authored inline SVG, Mermaid charts) are saved.
 * Every "Save Image" surface writes here so diagrams land next to the project
 * that produced them instead of scattering into ~/Downloads.
 */
export const DIAGRAMS_DIR = '.maestro/diagrams';

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

/**
 * Generate a rule file path for a TTSR rule.
 * Convention: .maestro/rules/{ruleName}.md
 * Spaces are replaced with underscores.
 */
export function ttsrRuleFilePath(ruleName: string): string {
	const sanitized = ruleName.replace(/\s+/g, '_').toLowerCase();
	return `${TTSR_RULES_DIR}/${sanitized}.md`;
}
