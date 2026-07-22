/**
 * Loader facade for Time-Traveling Stream Rules configuration.
 *
 * Mirrors `src/main/cue/cue-yaml-loader.ts`: the repository owns fs access,
 * the normalizer owns coercion/validation, and this module composes them into
 * the single entrypoint the rest of main uses.
 */

import * as yaml from 'js-yaml';
import {
	DEFAULT_TTSR_PROJECT_SETTINGS,
	type LoadedTtsrRule,
	type TtsrProjectSettings,
} from '../../../shared/ttsr-types';
import {
	listTtsrRuleFiles,
	readTtsrConfigFile,
	readTtsrRuleFile,
	watchTtsrConfigFiles,
} from './ttsr-config-repository';
import { normalizeTtsrSettings, parseTtsrRule } from './ttsr-config-normalizer';

export {
	resolveTtsrConfigPath,
	listTtsrRuleFiles,
	readTtsrRuleFile,
	writeTtsrRuleFile,
	deleteTtsrRuleFile,
	readTtsrConfigFile,
	writeTtsrConfigFile,
	deleteTtsrConfigFile,
} from './ttsr-config-repository';

/**
 * Outcome of {@link loadTtsrConfigDetailed}.
 *
 * `rules` and `settings` are always present (empty / defaulted on failure) so
 * callers never have to branch before reading them.
 *
 * - `missing` - the project has neither `.maestro/ttsr.yaml` nor any rule files
 * - `unparseable` - `.maestro/ttsr.yaml` is not valid YAML
 * - `invalid` - the YAML parsed but its root is not a mapping
 */
export interface LoadTtsrConfigResult {
	ok: boolean;
	reason?: 'missing' | 'unparseable' | 'invalid';
	/** Fatal detail for `unparseable` / `invalid`. */
	errors: string[];
	/** Non-fatal problems: dropped rules, bad regexes, shadowed names. */
	warnings: string[];
	rules: LoadedTtsrRule[];
	/**
	 * Rules that parsed fine but are named in `settings.disabledRules`, so they
	 * are absent from {@link LoadTtsrConfigResult.rules}. Kept so the management
	 * surface can show a disabled rule (and let the user re-enable it) without
	 * ever handing it to the matcher.
	 */
	disabledRules: LoadedTtsrRule[];
	settings: TtsrProjectSettings;
}

function emptyResult(
	reason: LoadTtsrConfigResult['reason'],
	errors: string[],
	warnings: string[]
): LoadTtsrConfigResult {
	return {
		ok: false,
		reason,
		errors,
		warnings,
		rules: [],
		disabledRules: [],
		settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS },
	};
}

/**
 * Load, validate, and normalize a project's TTSR rules and settings.
 *
 * Rules are read from `.maestro/rules/*.md` in sorted filename order.
 * Precedence is name-based first-wins: a later file whose rule name collides
 * with an earlier one is shadowed with a warning (mirroring OMP).
 *
 * Rules named in `settings.disabledRules` are loaded but excluded from `rules`,
 * so a disabled rule cannot fire without also disappearing from the collision
 * bookkeeping. They are still returned under `disabledRules` for the management
 * surface, which has to show what it can turn back on.
 */
export function loadTtsrConfigDetailed(projectRoot: string): LoadTtsrConfigResult {
	const warnings: string[] = [];

	// ── Settings ───────────────────────────────────────────────────────────
	const configFile = readTtsrConfigFile(projectRoot);
	let settings: TtsrProjectSettings = { ...DEFAULT_TTSR_PROJECT_SETTINGS };

	if (configFile) {
		let parsed: unknown;
		try {
			parsed = yaml.load(configFile.raw);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return emptyResult('unparseable', [message], warnings);
		}
		const normalized = normalizeTtsrSettings(parsed);
		if (normalized.errors.length > 0) {
			return emptyResult('invalid', normalized.errors, [...warnings, ...normalized.warnings]);
		}
		settings = normalized.settings;
		warnings.push(...normalized.warnings);
	}

	// ── Rules ──────────────────────────────────────────────────────────────
	const ruleFiles = listTtsrRuleFiles(projectRoot);
	if (!configFile && ruleFiles.length === 0) {
		return emptyResult('missing', [], warnings);
	}

	const disabled = new Set(settings.disabledRules);
	const byName = new Map<string, LoadedTtsrRule>();

	for (const relativePath of ruleFiles) {
		const raw = readTtsrRuleFile(projectRoot, relativePath);
		if (raw === null) {
			warnings.push(`${relativePath}: could not be read; rule skipped`);
			continue;
		}
		const { rule, warnings: ruleWarnings } = parseTtsrRule(raw, relativePath);
		warnings.push(...ruleWarnings);
		if (!rule) continue;

		const existing = byName.get(rule.name);
		if (existing) {
			warnings.push(
				`${relativePath}: rule name "${rule.name}" already defined by ${existing.path}; this file is shadowed`
			);
			continue;
		}
		byName.set(rule.name, rule);
	}

	const loaded = [...byName.values()];
	const rules = loaded.filter((rule) => !disabled.has(rule.name));
	const disabledRules = loaded.filter((rule) => disabled.has(rule.name));

	return { ok: true, errors: [], warnings, rules, disabledRules, settings };
}

/**
 * Watch a project's TTSR config file and rule files, invoking `onChange`
 * (debounced 1s) whenever one is added, changed, or removed.
 * Returns a cleanup function.
 */
export function watchTtsrConfig(
	projectRoot: string,
	onChange: () => void,
	opts?: { onReady?: () => void }
): () => void {
	return watchTtsrConfigFiles(projectRoot, onChange, opts);
}
