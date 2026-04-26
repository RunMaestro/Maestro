/**
 * Cue IPC Handlers
 *
 * Provides IPC handlers for the Maestro Cue event-driven automation system:
 * - Engine runtime controls (enable/disable, stop runs)
 * - Status and activity log queries
 * - YAML configuration management (read, write, validate)
 *
 * This module is a thin transport layer: business logic and filesystem I/O
 * live in domain modules (cue-engine, cue-config-repository,
 * pipeline-layout-store). Each handler should be a 1-line delegation.
 */

import { ipcMain } from 'electron';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { validateCueConfig } from '../../cue/cue-yaml-loader';
import { cueDebugLog } from '../../../shared/cueDebug';
import {
	deleteCueConfigFile,
	readCueConfigFile,
	pruneOrphanedPromptFiles,
	removeEmptyMaestroDir,
	removeEmptyPromptsDir,
	writeCueConfigFile,
	writeCuePromptFile,
} from '../../cue/config/cue-config-repository';
import { loadPipelineLayout, savePipelineLayout } from '../../cue/pipeline-layout-store';
import { captureException } from '../../utils/sentry';
import type { CueEngine } from '../../cue/cue-engine';
import type {
	CueGraphSession,
	CueRunResult,
	CueSessionStatus,
	CueSettings,
} from '../../cue/cue-types';
import type { PipelineLayoutState } from '../../../shared/cue-pipeline-types';

const LOG_CONTEXT = '[Cue]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for Cue handler registration
 */
export interface CueHandlerDependencies {
	getCueEngine: () => CueEngine | null;
}

/**
 * Register all Cue IPC handlers.
 *
 * These handlers provide:
 * - Engine status and activity log queries
 * - Runtime engine controls (enable/disable)
 * - Run management (stop individual or all)
 * - YAML configuration management
 */
export function registerCueHandlers(deps: CueHandlerDependencies): void {
	const { getCueEngine } = deps;

	const requireEngine = (): CueEngine => {
		const engine = getCueEngine();
		if (!engine) {
			throw new Error('Cue engine not initialized');
		}
		return engine;
	};

	// Get global Cue settings (merged from engine state)
	ipcMain.handle(
		'cue:getSettings',
		withIpcErrorLogging(handlerOpts('getSettings'), async (): Promise<CueSettings> => {
			return requireEngine().getSettings();
		})
	);

	// Get status of all Cue-enabled sessions
	ipcMain.handle(
		'cue:getStatus',
		withIpcErrorLogging(handlerOpts('getStatus'), async (): Promise<CueSessionStatus[]> => {
			return requireEngine().getStatus();
		})
	);

	// Get currently active Cue runs
	ipcMain.handle(
		'cue:getActiveRuns',
		withIpcErrorLogging(handlerOpts('getActiveRuns'), async (): Promise<CueRunResult[]> => {
			return requireEngine().getActiveRuns();
		})
	);

	// Get activity log (recent completed/failed runs)
	ipcMain.handle(
		'cue:getActivityLog',
		withIpcErrorLogging(
			handlerOpts('getActivityLog'),
			async (options: { limit?: number }): Promise<CueRunResult[]> => {
				return requireEngine().getActivityLog(options?.limit);
			}
		)
	);

	// Enable the Cue engine (runtime control)
	ipcMain.handle(
		'cue:enable',
		withIpcErrorLogging(handlerOpts('enable'), async (): Promise<void> => {
			requireEngine().start('system-boot');
		})
	);

	// Disable the Cue engine (runtime control)
	ipcMain.handle(
		'cue:disable',
		withIpcErrorLogging(handlerOpts('disable'), async (): Promise<void> => {
			requireEngine().stop();
		})
	);

	// Stop a specific running Cue execution
	ipcMain.handle(
		'cue:stopRun',
		withIpcErrorLogging(
			handlerOpts('stopRun'),
			async (options: { runId: string }): Promise<boolean> => {
				return requireEngine().stopRun(options.runId);
			}
		)
	);

	// Stop all running Cue executions
	ipcMain.handle(
		'cue:stopAll',
		withIpcErrorLogging(handlerOpts('stopAll'), async (): Promise<void> => {
			requireEngine().stopAll();
		})
	);

	// Manually trigger a subscription by name (Run Now)
	ipcMain.handle(
		'cue:triggerSubscription',
		withIpcErrorLogging(
			handlerOpts('triggerSubscription'),
			async (options: {
				subscriptionName: string;
				prompt?: string;
				sourceAgentId?: string;
			}): Promise<boolean> => {
				return requireEngine().triggerSubscription(
					options.subscriptionName,
					options.prompt,
					options.sourceAgentId
				);
			}
		)
	);

	// Get queue status per session
	ipcMain.handle(
		'cue:getQueueStatus',
		withIpcErrorLogging(
			handlerOpts('getQueueStatus'),
			async (): Promise<Record<string, number>> => {
				const queueMap = requireEngine().getQueueStatus();
				const result: Record<string, number> = {};
				for (const [sessionId, count] of queueMap) {
					result[sessionId] = count;
				}
				return result;
			}
		)
	);

	// Get engine metrics snapshot (runsStarted, eventsDropped, etc.)
	ipcMain.handle(
		'cue:getMetrics',
		withIpcErrorLogging(handlerOpts('getMetrics'), async () => {
			return requireEngine().getMetrics();
		})
	);

	// Get fan-in health — stalled trackers > 50% timeout (empty = healthy).
	ipcMain.handle(
		'cue:getFanInHealth',
		withIpcErrorLogging(handlerOpts('getFanInHealth'), async () => {
			return requireEngine().getFanInHealth();
		})
	);

	// Refresh a session's Cue configuration
	ipcMain.handle(
		'cue:refreshSession',
		withIpcErrorLogging(
			handlerOpts('refreshSession'),
			async (options: { sessionId: string; projectRoot: string }): Promise<void> => {
				requireEngine().refreshSession(options.sessionId, options.projectRoot);
			}
		)
	);

	// Remove a session from Cue tracking
	ipcMain.handle(
		'cue:removeSession',
		withIpcErrorLogging(
			handlerOpts('removeSession'),
			async (options: { sessionId: string }): Promise<void> => {
				requireEngine().removeSession(options.sessionId);
			}
		)
	);

	// Get all sessions with their subscriptions (for graph visualization)
	ipcMain.handle(
		'cue:getGraphData',
		withIpcErrorLogging(handlerOpts('getGraphData'), async (): Promise<CueGraphSession[]> => {
			return requireEngine().getGraphData();
		})
	);

	// Read raw YAML content from a session's cue config (checks .maestro/cue.yaml then legacy)
	ipcMain.handle(
		'cue:readYaml',
		withIpcErrorLogging(
			handlerOpts('readYaml'),
			async (options: { projectRoot: string }): Promise<string | null> => {
				const file = readCueConfigFile(options.projectRoot);
				return file ? file.raw : null;
			}
		)
	);

	// Write YAML content to .maestro/cue.yaml (canonical path, creates .maestro/ if needed)
	// Optionally writes external prompt files alongside the YAML.
	ipcMain.handle(
		'cue:writeYaml',
		withIpcErrorLogging(
			handlerOpts('writeYaml'),
			async (options: {
				projectRoot: string;
				content: string;
				promptFiles?: Record<string, string>;
			}): Promise<void> => {
				cueDebugLog('main:writeYaml:received', {
					projectRoot: options.projectRoot,
					yamlBytes: options.content.length,
					promptFileCount: Object.keys(options.promptFiles ?? {}).length,
				});
				const keepPaths = new Set<string>();
				if (options.promptFiles) {
					const promptsBase = path.resolve(options.projectRoot, '.maestro/prompts');
					for (const [relativePath, content] of Object.entries(options.promptFiles)) {
						// Reject obviously malformed keys before path.resolve — empty
						// strings would resolve to the project root itself, and
						// pre-normalized `..` segments make the containment check
						// harder to reason about even though resolve normalizes them.
						if (typeof relativePath !== 'string' || relativePath.length === 0) {
							throw new Error('cue:writeYaml: promptFiles key must be a non-empty string');
						}
						if (path.isAbsolute(relativePath)) {
							throw new Error(
								`cue:writeYaml: promptFiles key must be a relative path, got "${relativePath}"`
							);
						}
						// Normalize backslashes to forward-slashes BEFORE path.resolve on
						// non-Windows. A Windows-authored YAML shipping with a key like
						// `prompts\sub.md` would otherwise create a literal file called
						// `prompts\sub.md` on macOS/Linux, silently orphaning the real
						// prompts/ directory next save.
						const normalizedKey =
							path.sep === '/' ? relativePath.replace(/\\/g, '/') : relativePath;
						// Reject both '..' (escapes the prompts dir) and '.' (harmless
						// but ambiguous — `foo/.` and `foo` refer to the same file,
						// so accepting both breaks the keep-set invariant that
						// distinct keys map to distinct files on disk).
						if (
							normalizedKey.split(/[/\\]/).some((segment) => segment === '..' || segment === '.')
						) {
							throw new Error(
								`cue:writeYaml: promptFiles key "${relativePath}" contains "." or ".." segment`
							);
						}
						const target = path.resolve(options.projectRoot, normalizedKey);
						// Must resolve strictly INSIDE .maestro/prompts/. The earlier
						// check allowed `target === promptsBase` which would attempt
						// to write to the directory path itself.
						if (!target.startsWith(promptsBase + path.sep)) {
							throw new Error(
								`cue:writeYaml: promptFiles key "${relativePath}" resolves outside the .maestro/prompts directory`
							);
						}
						// Must be a .md file. pruneOrphanedPromptFiles only deletes
						// .md files, so accepting other extensions here would let
						// non-markdown junk accumulate forever (it's never on the
						// prune keep-set's enforcement path).
						if (path.extname(target).toLowerCase() !== '.md') {
							throw new Error(`cue:writeYaml: promptFiles key "${relativePath}" must end with .md`);
						}
						writeCuePromptFile(options.projectRoot, normalizedKey, content);
						keepPaths.add(normalizedKey);
					}
				}

				// Parse the YAML BEFORE writing so we can derive the full
				// referenced-paths keep-set up front — and so a parse failure
				// becomes a hard skip on pruning instead of a partial keep-set
				// that could mass-delete prompt files referenced only inside
				// options.content (and not duplicated in options.promptFiles).
				let parseSucceeded = true;
				try {
					const parsed = yaml.load(options.content) as
						| { subscriptions?: Array<Record<string, unknown>> }
						| null
						| undefined;
					const subs = parsed?.subscriptions;
					if (Array.isArray(subs)) {
						for (const sub of subs) {
							if (!sub || typeof sub !== 'object') continue;
							const rec = sub as Record<string, unknown>;
							const pf = rec.prompt_file;
							const opf = rec.output_prompt_file;
							if (typeof pf === 'string' && pf.length > 0 && !path.isAbsolute(pf)) {
								keepPaths.add(pf);
							}
							if (typeof opf === 'string' && opf.length > 0 && !path.isAbsolute(opf)) {
								keepPaths.add(opf);
							}
							// `fan_out_prompt_files` is a positional array of per-agent
							// prompt files. Each entry must survive the prune or the
							// next save would re-create it unnecessarily.
							const fopf = rec.fan_out_prompt_files;
							if (Array.isArray(fopf)) {
								for (const entry of fopf) {
									if (typeof entry === 'string' && entry.length > 0 && !path.isAbsolute(entry)) {
										keepPaths.add(entry);
									}
								}
							}
						}
					}
				} catch (parseErr) {
					parseSucceeded = false;
					captureException(parseErr, {
						operation: 'cue:writeYaml.parseForPrune',
						projectRoot: options.projectRoot,
					});
				}

				writeCueConfigFile(options.projectRoot, options.content);

				try {
					const validation = validateCueConfig(yaml.load(options.content));
					const parsed = yaml.load(options.content) as
						| { subscriptions?: Array<Record<string, unknown>>; settings?: Record<string, unknown> }
						| null
						| undefined;
					const subs = Array.isArray(parsed?.subscriptions) ? parsed!.subscriptions! : [];
					cueDebugLog('main:writeYaml:parsed', {
						projectRoot: options.projectRoot,
						parseSucceeded,
						validation,
						subscriptionCount: subs.length,
						subscriptions: subs.map((s) => {
							const r = s as Record<string, unknown>;
							return {
								name: r.name,
								event: r.event,
								enabled: r.enabled,
								agent_id: r.agent_id,
								source_session: r.source_session,
								fan_out: r.fan_out,
								forward_output_from: r.forward_output_from,
							};
						}),
						settings: parsed?.settings ?? null,
					});
				} catch (err) {
					cueDebugLog('main:writeYaml:parsed:error', {
						projectRoot: options.projectRoot,
						message: err instanceof Error ? err.message : String(err),
					});
				}

				// Only prune when we have an authoritative keep-set. If the YAML
				// failed to parse, the keep-set may be missing prompt files the
				// YAML actually references — running prune anyway risks
				// mass-deleting files we'd lose forever. The next successful save
				// (with valid YAML) will catch up.
				if (parseSucceeded) {
					pruneOrphanedPromptFiles(options.projectRoot, keepPaths);
					// If the user saved an empty pipeline state (no prompts left)
					// collapse `.maestro/prompts/` too so the on-disk footprint
					// matches the empty UI. Non-empty dirs are left alone.
					if (keepPaths.size === 0) {
						removeEmptyPromptsDir(options.projectRoot);
					}
				}
			}
		)
	);

	// Delete a session's cue.yaml config file. Also prunes every `.md` file
	// under `.maestro/prompts/` (keep-set is empty since there are no
	// subscriptions left to reference any prompt) and removes the prompts
	// directory if it ends up empty. Without this, "Remove Cue configuration"
	// left orphaned prompt files behind and the `.maestro` footprint never
	// shrank.
	ipcMain.handle(
		'cue:deleteYaml',
		withIpcErrorLogging(
			handlerOpts('deleteYaml'),
			async (options: { projectRoot: string }): Promise<boolean> => {
				const deleted = deleteCueConfigFile(options.projectRoot);
				// Run prompt cleanup regardless of whether the yaml file was
				// present — if the user deleted cue.yaml by hand and then
				// invokes this, we still want orphaned prompts cleaned up.
				pruneOrphanedPromptFiles(options.projectRoot, []);
				removeEmptyPromptsDir(options.projectRoot);
				// Collapse .maestro/ itself if nothing else lives there.
				removeEmptyMaestroDir(options.projectRoot);
				return deleted;
			}
		)
	);

	// Validate YAML content as a Cue configuration
	ipcMain.handle(
		'cue:validateYaml',
		withIpcErrorLogging(
			handlerOpts('validateYaml'),
			async (options: { content: string }): Promise<{ valid: boolean; errors: string[] }> => {
				try {
					const parsed = yaml.load(options.content);
					return validateCueConfig(parsed);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { valid: false, errors: [`YAML parse error: ${message}`] };
				}
			}
		)
	);

	// Save pipeline layout (node positions, viewport, selected pipeline)
	ipcMain.handle(
		'cue:savePipelineLayout',
		withIpcErrorLogging(
			handlerOpts('savePipelineLayout'),
			async (options: { layout: PipelineLayoutState }): Promise<void> => {
				savePipelineLayout(options.layout);
			}
		)
	);

	// Load saved pipeline layout
	ipcMain.handle(
		'cue:loadPipelineLayout',
		withIpcErrorLogging(
			handlerOpts('loadPipelineLayout'),
			async (): Promise<PipelineLayoutState | null> => {
				return loadPipelineLayout();
			}
		)
	);
}
