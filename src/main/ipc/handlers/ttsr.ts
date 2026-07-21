/**
 * TTSR IPC handlers - rule and per-project settings CRUD.
 *
 * Thin transport over `src/main/ttsr/config/`, which already owns every
 * filesystem concern (path containment, `mkdir -p`, YAML). The runtime itself
 * stays push-only: matching and interrupting are main-authoritative (Gate B),
 * so nothing here touches the live stream. These handlers exist purely so the
 * Right Bar can show a project its rules instead of the user hand-writing files
 * they have no way to discover.
 *
 * Everything is project-scoped: every call takes the `projectRoot` of the agent
 * the user is looking at. There is deliberately no "write to every known
 * project" fan-out - the global layer is the `ttsr*` settings, and the two
 * compose by read-time precedence (project file, then global setting).
 */

import { ipcMain } from 'electron';
import * as yaml from 'js-yaml';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	deleteTtsrRuleFile,
	listTtsrRuleFiles,
	loadTtsrConfigDetailed,
	readTtsrConfigFile,
	readTtsrRuleFile,
	writeTtsrConfigFile,
	writeTtsrRuleFile,
} from '../../ttsr';
import { parseTtsrRule } from '../../ttsr/config/ttsr-config-normalizer';
import { ttsrRuleFilePath } from '../../../shared/maestro-paths';
import type {
	TtsrProjectSettings,
	TtsrRule,
	TtsrRuleListEntry,
	TtsrRuleListResult,
	TtsrRuleValidation,
} from '../../../shared/ttsr-types';

const LOG_CONTEXT = '[TTSR]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface TtsrHandlerDependencies {
	/**
	 * Drop the runtime's cached rules for a project after a write. The rule-file
	 * watcher would get there on its own, but it debounces by a second and the
	 * user just clicked something - the list must not lie in the meantime.
	 */
	onRulesChanged?: (projectRoot: string) => void;
}

/** Strip the compiled regexes so the rule survives structured cloning. */
function toSerializable(rule: TtsrRule & { compiledCondition?: RegExp[] }): TtsrRule {
	const { compiledCondition: _compiled, ...serializable } = rule;
	return serializable;
}

export function registerTtsrHandlers(deps: TtsrHandlerDependencies = {}): void {
	// Every rule in a project, plus the load warnings. The warnings are the only
	// feedback a user gets for a rule that parsed but can never fire (bad regex,
	// an agent that cannot evaluate it), so they are surfaced, not swallowed.
	ipcMain.handle(
		'ttsr:listRules',
		withIpcErrorLogging(
			handlerOpts('listRules'),
			async (args: { projectRoot: string }): Promise<TtsrRuleListResult> => {
				const result = loadTtsrConfigDetailed(args.projectRoot);
				// Disabled rules are listed, not filtered: one the panel cannot show is
				// one the user cannot turn back on. Only the runtime's rule cache
				// filters, so the matcher is unaffected by this.
				const listed: TtsrRuleListEntry[] = [
					...result.rules.map((rule) => ({ ...toSerializable(rule), disabled: false })),
					...result.disabledRules.map((rule) => ({ ...toSerializable(rule), disabled: true })),
				];
				return {
					rules: listed.sort((a, b) => a.path.localeCompare(b.path)),
					settings: result.settings,
					warnings: result.warnings,
					errors: result.errors,
					// `missing` just means the project has no rules yet, which the panel
					// renders as an empty state rather than an error.
					configExists: result.reason !== 'missing',
				};
			}
		)
	);

	ipcMain.handle(
		'ttsr:readRule',
		withIpcErrorLogging(
			handlerOpts('readRule'),
			async (args: { projectRoot: string; path: string }): Promise<string | null> => {
				return readTtsrRuleFile(args.projectRoot, args.path);
			}
		)
	);

	ipcMain.handle(
		'ttsr:writeRule',
		withIpcErrorLogging(
			handlerOpts('writeRule'),
			async (args: {
				projectRoot: string;
				path: string;
				content: string;
			}): Promise<{ path: string }> => {
				writeTtsrRuleFile(args.projectRoot, args.path, args.content);
				deps.onRulesChanged?.(args.projectRoot);
				return { path: args.path };
			}
		)
	);

	ipcMain.handle(
		'ttsr:deleteRule',
		withIpcErrorLogging(
			handlerOpts('deleteRule'),
			async (args: { projectRoot: string; path: string }): Promise<{ deleted: boolean }> => {
				const deleted = deleteTtsrRuleFile(args.projectRoot, args.path);
				if (deleted) deps.onRulesChanged?.(args.projectRoot);
				return { deleted };
			}
		)
	);

	// Dry-run a rule's markdown without writing it, so the editor can show what
	// the loader would make of it (and what it would drop) before committing.
	ipcMain.handle(
		'ttsr:validateRule',
		withIpcErrorLogging(
			handlerOpts('validateRule'),
			async (args: { content: string; path?: string }): Promise<TtsrRuleValidation> => {
				const path = args.path || ttsrRuleFilePath('draft');
				const { rule, warnings } = parseTtsrRule(args.content, path);
				return { valid: rule !== null, rule: rule ? toSerializable(rule) : null, warnings };
			}
		)
	);

	ipcMain.handle(
		'ttsr:readProjectSettings',
		withIpcErrorLogging(
			handlerOpts('readProjectSettings'),
			async (args: { projectRoot: string }): Promise<TtsrProjectSettings> => {
				return loadTtsrConfigDetailed(args.projectRoot).settings;
			}
		)
	);

	// Merge rather than overwrite: `.maestro/ttsr.yaml` is a user-editable file
	// that may carry keys this build does not know about, and clobbering them
	// because the user flicked a toggle would be a rude way to lose their config.
	ipcMain.handle(
		'ttsr:writeProjectSettings',
		withIpcErrorLogging(
			handlerOpts('writeProjectSettings'),
			async (args: {
				projectRoot: string;
				settings: Partial<TtsrProjectSettings>;
			}): Promise<{ path: string }> => {
				const existingFile = readTtsrConfigFile(args.projectRoot);
				let parsed: Record<string, unknown> = {};
				if (existingFile) {
					const loaded = yaml.load(existingFile.raw);
					if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
						parsed = loaded as Record<string, unknown>;
					}
				}

				for (const [key, value] of Object.entries(args.settings)) {
					// `undefined` means "say nothing", which for contextMode is what
					// hands the decision back to the global setting.
					if (value === undefined) delete parsed[key];
					else parsed[key] = value;
				}

				const dumped = yaml.dump(parsed, {
					indent: 2,
					lineWidth: 120,
					noRefs: true,
					quotingType: "'",
					forceQuotes: false,
				});
				const path = writeTtsrConfigFile(args.projectRoot, dumped);
				deps.onRulesChanged?.(args.projectRoot);
				return { path };
			}
		)
	);

	// Absolute paths for the "open in editor" affordance, which needs a real
	// path rather than the project-relative one the rule list carries.
	ipcMain.handle(
		'ttsr:listRuleFiles',
		withIpcErrorLogging(
			handlerOpts('listRuleFiles'),
			async (args: { projectRoot: string }): Promise<string[]> => {
				return listTtsrRuleFiles(args.projectRoot);
			}
		)
	);
}
