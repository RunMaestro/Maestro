/**
 * The spec-driven Auto Run engine: process a playbook's documents task by task and yield events.
 *
 * This is the CLI engine moved into the library (`Plans/maestro-tui-autorun-engine.md`, AE1). It
 * runs on the ports in `AutoRunDeps` and nothing else, so the CLI and the runtime run the same
 * loop. Behavior is the CLI's, field for field: the same events in the same order, the same
 * History rows, the same exits.
 */

import {
	describeUnresolvedHaltMarker,
	detectHaltMarker,
	findPendingHitlGate,
} from '../../autorunMarkers';
import {
	aggregateAutoRunHistoryTotals,
	mergeFinalSummaryTotals,
	type FinalSummaryTotals,
} from '../../autoRunHistoryReconciliation';
import { findActiveModelHint, countTasksUnderActiveHint } from '../../autorunModelHints';
import { describeStall, evaluateStall, MAX_CONSECUTIVE_NO_CHANGES } from '../../autorunStall';
import { resolveTurnSettings, describeTurnSettings } from '../../autorunTurnSettings';
import { countMarkdownTasks } from '../../markdownTaskScan';
import { cheapTurnSettings } from '../../modelTiers';
import { prependNewSessionMessage } from '../../newSessionMessage';
import { PROMPT_IDS } from '../../promptDefinitions';
import { parseSynopsis } from '../../synopsis';
import { substituteTemplateVariables, type TemplateContext } from '../../templateVariables';
import type { Playbook, SessionInfo, UsageStats } from '../../types';
import type { AutoRunDeps, AutoRunEvent } from './engine-types';
import {
	buildAutoRunSummaryEntry,
	buildFinalLoopEntry,
	buildLoopEntry,
	buildTaskHistoryEntry,
	summaryUsageStats,
} from './history-entries';
import { preflightPlaybook } from './preflight';

export interface RunPlaybookOptions {
	dryRun?: boolean;
	writeHistory?: boolean;
	debug?: boolean;
	verbose?: boolean;
	skipSynopsis?: boolean;
	/**
	 * Run-scoped model override. Wins over `session.customModel` for every
	 * spawn this run makes; the stored session is never modified.
	 */
	model?: string;
	/** Run-scoped reasoning effort override (same contract as `model`). */
	effort?: string;
	/**
	 * Skip the documents' MAESTRO:MODEL markers, so every task runs at the run
	 * override, then the agent's settings. Same run-scoped contract.
	 */
	ignoreModelHints?: boolean;
	/**
	 * Stop the run. The agent turn in flight is aborted, the run records
	 * "stopped" (never a failure) and ends cleanly.
	 */
	signal?: AbortSignal;
}

const OPERATOR_STOP_OUTCOME = 'stopped: by operator';

/**
 * Process a playbook and yield events.
 */
export async function* runPlaybook(
	session: SessionInfo,
	playbook: Playbook,
	folderPath: string,
	options: RunPlaybookOptions,
	deps: AutoRunDeps
): AsyncGenerator<AutoRunEvent> {
	const {
		dryRun = false,
		writeHistory = true,
		debug = false,
		verbose = false,
		skipSynopsis = false,
		model: runModel,
		effort: runEffort,
		ignoreModelHints = false,
		signal,
	} = options;
	const { clock, log } = deps;
	const batchStartTime = clock.now();
	// Bottom of both ladders for every synopsis turn in this run. Resolved once:
	// it depends only on the provider, which cannot change mid-run.
	const cheapSynopsis = cheapTurnSettings(session.toolType);

	// Get git branch and group name for template variable substitution
	const gitBranch = await deps.environment.gitBranch(session.cwd);
	const isGit = await deps.environment.isGitRepo(session.cwd);
	const groupName = await deps.environment.groupName(session.groupId);

	// Register activity so the desktop app knows this agent is busy
	deps.activity.begin({
		agentId: session.id,
		playbookId: playbook.id,
		playbookName: playbook.name,
		startedAt: clock.now(),
	});

	try {
		// Emit start event
		yield {
			type: 'start',
			timestamp: clock.now(),
			playbook: { id: playbook.id, name: playbook.name },
			session: { id: session.id, name: session.name, cwd: session.cwd },
		};

		// AUTORUN LOG: Start
		log.autorun(`Auto Run started`, session.name, {
			playbook: playbook.name,
			documents: playbook.documents.map((d) => d.filename),
			loopEnabled: playbook.loopEnabled,
			maxLoops: playbook.maxLoops ?? 'unlimited',
		});

		// Emit debug info about playbook configuration
		if (debug) {
			yield {
				type: 'debug',
				timestamp: clock.now(),
				category: 'config',
				message: `Playbook config: loopEnabled=${playbook.loopEnabled}, maxLoops=${playbook.maxLoops ?? 'unlimited'}`,
			};
			yield {
				type: 'debug',
				timestamp: clock.now(),
				category: 'config',
				message: `Documents (${playbook.documents.length}): ${playbook.documents.map((d) => `${d.filename}${d.resetOnCompletion ? ' [RESET]' : ''}`).join(', ')}`,
			};
			yield {
				type: 'debug',
				timestamp: clock.now(),
				category: 'config',
				message: `Folder path: ${folderPath}`,
			};
		}

		// Count the tasks and look for a halt marker an earlier run left behind. We
		// refuse to start on a stale marker: the previous run halted intentionally
		// and the user must resolve it before running again.
		const { initialTotalTasks, scanned, preExistingHalt } = await preflightPlaybook(
			playbook,
			folderPath,
			deps.documents
		);
		if (debug) {
			for (const { document, unchecked } of scanned) {
				yield {
					type: 'debug',
					timestamp: clock.now(),
					category: 'scan',
					message: `${document}: ${unchecked} unchecked task${unchecked !== 1 ? 's' : ''}`,
				};
			}
			yield {
				type: 'debug',
				timestamp: clock.now(),
				category: 'scan',
				message: `Total unchecked tasks: ${initialTotalTasks}`,
			};
		}

		if (initialTotalTasks === 0) {
			deps.activity.end(session.id);
			yield {
				type: 'error',
				timestamp: clock.now(),
				message: 'No unchecked tasks found in any documents',
				code: 'NO_TASKS',
			};
			return;
		}

		if (preExistingHalt) {
			deps.activity.end(session.id);
			yield {
				type: 'error',
				timestamp: clock.now(),
				message: describeUnresolvedHaltMarker(preExistingHalt.document, preExistingHalt.halt),
				code: 'HALT_MARKER_PRESENT',
			};
			return;
		}

		if (dryRun) {
			// Dry run - show detailed breakdown of what would be executed
			for (let docIndex = 0; docIndex < playbook.documents.length; docIndex++) {
				const docEntry = playbook.documents[docIndex];
				const { tasks } = await deps.documents.readTasks(folderPath, docEntry.filename);

				if (tasks.length === 0) {
					continue;
				}

				// Emit document start event
				yield {
					type: 'document_start',
					timestamp: clock.now(),
					document: docEntry.filename,
					index: docIndex,
					taskCount: tasks.length,
					dryRun: true,
				};

				// Emit each task that would be processed
				for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
					yield {
						type: 'task_preview',
						timestamp: clock.now(),
						document: docEntry.filename,
						taskIndex,
						task: tasks[taskIndex],
					};
				}

				// Emit document complete event
				yield {
					type: 'document_complete',
					timestamp: clock.now(),
					document: docEntry.filename,
					tasksCompleted: tasks.length,
					dryRun: true,
				};
			}

			deps.activity.end(session.id);
			yield {
				type: 'complete',
				timestamp: clock.now(),
				success: true,
				totalTasksCompleted: 0,
				totalElapsedMs: 0,
				dryRun: true,
				wouldProcess: initialTotalTasks,
			};
			return;
		}

		// Build the Maestro system prompt once per playbook run. It's identical
		// for every task in the loop (session/branch/conductor don't change
		// between tasks), so caching avoids repeating the prompt-load + git
		// branch probe per task. Failure is non-fatal: tasks run without the
		// system prompt rather than aborting the playbook.
		await deps.turns.prepare?.();

		// Track totals
		let totalCompletedTasks = 0;
		let totalCost = 0;
		let loopIteration = 0;

		// Per-loop tracking
		let loopStartTime = clock.now();
		let loopTasksCompleted = 0;
		let loopTotalInputTokens = 0;
		let loopTotalOutputTokens = 0;
		let loopTotalCost = 0;

		// Total tracking across all loops
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		// Helper to create final loop entry with exit reason
		const createFinalLoopEntry = async (exitReason: string): Promise<void> => {
			// AUTORUN LOG: Exit
			log.autorun(`Auto Run exiting: ${exitReason}`, session.name, {
				reason: exitReason,
				totalTasksCompleted: totalCompletedTasks,
				loopsCompleted: loopIteration + 1,
			});

			if (!writeHistory) return;
			// Only write if looping was enabled and we did some work
			if (!playbook.loopEnabled && loopIteration === 0) return;
			if (loopTasksCompleted === 0 && loopIteration === 0) return;

			await deps.history.append(
				buildFinalLoopEntry(
					session,
					clock.now(),
					loopIteration + 1,
					{
						tasksCompleted: loopTasksCompleted,
						elapsedMs: clock.now() - loopStartTime,
						inputTokens: loopTotalInputTokens,
						outputTokens: loopTotalOutputTokens,
						cost: loopTotalCost,
					},
					exitReason
				)
			);
		};

		// Reconcile in-memory counters with persisted history entries.
		//
		// In-memory counters (totalCompletedTasks/tokens/cost) reset whenever the
		// Auto Run spans a process boundary: an app/CLI restart, a resume, or a
		// kill mid-run. The per-task history entries persist on disk, so we
		// reconstruct cumulative totals from history and take Math.max with the
		// live counters. This uses the exact same shared logic as desktop Auto Run
		// (aggregateAutoRunHistoryTotals scopes to entries after the last final
		// "Auto Run ..." summary, so it spans restarts without absorbing earlier
		// completed runs on the same session). Reading history is an expected,
		// recoverable failure mode: fall back to the in-memory counters and warn.
		const reconcileTotals = async (): Promise<FinalSummaryTotals> => {
			const runtimeTotals: FinalSummaryTotals = {
				totalCompletedTasks,
				totalElapsedMs: clock.now() - batchStartTime,
				totalInputTokens,
				totalOutputTokens,
				totalCost,
			};
			try {
				const historyEntries = await deps.history.readAll(session.id);
				return mergeFinalSummaryTotals(
					runtimeTotals,
					aggregateAutoRunHistoryTotals(historyEntries)
				);
			} catch (historyError) {
				log.warn('History reconciliation failed, using in-memory counters', session.name, {
					sessionId: session.id,
					error: String(historyError),
				});
				return runtimeTotals;
			}
		};

		// Helper to create total Auto Run summary from reconciled totals.
		//
		// Written for EVERY run, including a single-pass non-looping one. Besides
		// matching desktop Auto Run (`buildFinalSummary` is unconditional there),
		// this row is the run BOUNDARY that `aggregateAutoRunHistoryTotals` scans
		// back to. Skipping it for non-loop runs - as this did - left the next run
		// with no boundary, so its aggregation swept up the previous run's task
		// rows and reported the two runs added together.
		const createAutoRunSummary = async (
			reconciled: FinalSummaryTotals,
			outcome?: string
		): Promise<void> => {
			if (!writeHistory) return;
			await deps.history.append(
				buildAutoRunSummaryEntry(session, clock.now(), reconciled, loopIteration + 1, outcome)
			);
		};

		// Main processing loop
		while (true) {
			let anyTasksProcessedThisIteration = false;

			// Process each document in order
			for (let docIndex = 0; docIndex < playbook.documents.length; docIndex++) {
				const docEntry = playbook.documents[docIndex];

				// Read document and count tasks
				const { unchecked: initialTaskCount, content: docHeadContent } = await deps.documents.read(
					folderPath,
					docEntry.filename
				);
				let remainingTasks = initialTaskCount;

				// Skip documents with no tasks
				if (remainingTasks === 0) {
					continue;
				}

				// Emit document start event
				yield {
					type: 'document_start',
					timestamp: clock.now(),
					document: docEntry.filename,
					index: docIndex,
					taskCount: remainingTasks,
				};

				// AUTORUN LOG: Document processing
				log.autorun(`Processing document: ${docEntry.filename}`, session.name, {
					document: docEntry.filename,
					tasksRemaining: remainingTasks,
					loopNumber: loopIteration + 1,
				});

				// A gate asks for a human, and a batch run does not have one. Report it
				// and move on rather than dispatching a task nobody can finish. The
				// desktop engine pauses here instead, because there IS someone to wait
				// for; the marker means the same thing on both, only the response
				// differs.
				const gate = findPendingHitlGate(docHeadContent);
				if (gate) {
					log.autorun(`Document gated on a human: ${docEntry.filename}`, session.name, {
						document: docEntry.filename,
						reason: gate.reason,
						line: gate.line + 1,
						loopNumber: loopIteration + 1,
					});

					yield {
						type: 'document_gated',
						timestamp: clock.now(),
						document: docEntry.filename,
						reason: gate.reason,
						artifact: gate.artifact,
						line: gate.line + 1,
					};
					continue;
				}

				let docTasksCompleted = 0;
				let taskIndex = 0;
				// Consecutive dispatches that moved no checkbox. Reset per document so
				// one stuck document does not condemn the next. Without this the loop
				// below has exactly one exit - the count reaching zero - so a task the
				// agent cannot finish is re-dispatched forever.
				let consecutiveNoChangeCount = 0;
				let documentStalled: { reason: string; remainingTasks: number } | null = null;

				// Process tasks in this document
				while (remainingTasks > 0) {
					// Emit task start
					yield {
						type: 'task_start',
						timestamp: clock.now(),
						document: docEntry.filename,
						taskIndex,
					};

					const taskStartTime = clock.now();

					const docFilePath = `${folderPath}/${docEntry.filename}.md`;

					// Build template context for this task
					const templateContext: TemplateContext = {
						session: {
							...session,
							isGitRepo: isGit,
						},
						gitBranch,
						groupName,
						groupId: session.groupId,
						autoRunFolder: folderPath,
						loopNumber: loopIteration + 1, // 1-indexed
						documentName: docEntry.filename,
						documentPath: docFilePath,
					};

					// Read document content and expand template variables in it. Read
					// BEFORE the prompt is built: the selection block depends on where
					// the document's model hints change, so the content has to exist
					// first.
					const { content: docContent } = await deps.documents.read(folderPath, docEntry.filename);
					const expandedDocContent = docContent
						? substituteTemplateVariables(docContent, templateContext)
						: '';

					// Write expanded content back to document (so agent edits have correct paths)
					if (expandedDocContent && expandedDocContent !== docContent) {
						await deps.documents.write(folderPath, `${docEntry.filename}.md`, expandedDocContent);
					}

					// Resolve the task-selection block BEFORE the template-variable pass,
					// so variables inside the swapped-in block expand too. The desktop
					// engine has always done this (useDocumentProcessor -> batchUtils);
					// the CLI never did, so `{{TASK_SELECTION_BLOCK}}` reached the agent
					// as a literal placeholder in step 2 of the default prompt. The
					// agent was being handed a template, not an instruction.
					const rawBasePrompt =
						playbook.prompt || (await deps.prompts.get(PROMPT_IDS.AUTORUN_DEFAULT));
					// Same content and baseline the model hint is resolved from below, so
					// the boundary the prompt names and the settings the run uses cannot
					// disagree.
					const hintSegment = ignoreModelHints
						? undefined
						: countTasksUnderActiveHint(
								expandedDocContent,
								session.toolType,
								runModel ?? session.customModel,
								runEffort ?? session.customEffort
							);
					const selectionBlock = await deps.prompts.taskSelectionBlock(
						playbook.taskSelectionMode,
						hintSegment
					);
					const basePrompt = substituteTemplateVariables(
						rawBasePrompt.replace(/\{\{TASK_SELECTION_BLOCK\}\}/gi, selectionBlock),
						templateContext
					);

					// Combine prompt with document content - agent works on what it's given
					// Include explicit file path so agent knows where to save changes.
					// Each task spawns a fresh provider session, so prefix the agent's
					// New Session Message onto every spawn (matches interactive behavior).
					const finalPrompt = prependNewSessionMessage(
						`${basePrompt}\n\n---\n\n# Current Document: ${docFilePath}\n\nProcess tasks from this document and save changes back to the file above.\n\n${expandedDocContent}`,
						session.newSessionMessage
					);

					// Emit verbose event with full prompt
					if (verbose) {
						yield {
							type: 'verbose',
							timestamp: clock.now(),
							category: 'prompt',
							document: docEntry.filename,
							taskIndex,
							prompt: finalPrompt,
						};
					}

					// Resolve the document's model hint for THIS task. Recomputed per
					// dispatch rather than carried as run state, so editing the document
					// mid-run takes effect on the next task. The run-scoped --model /
					// --effort goes in as the baseline the hint overrides, matching the
					// desktop engine's precedence: document hint, then run override, then
					// the agent's own value.
					const turnSettings = resolveTurnSettings(
						session.toolType,
						ignoreModelHints ? null : findActiveModelHint(expandedDocContent),
						runModel ?? session.customModel,
						runEffort ?? session.customEffort
					);
					// Its own event type rather than `verbose`: a hint that could not be
					// honored has to reach the operator whether or not they passed
					// --verbose, and a distinct type lets consumers filter for it.
					const turnSettingsNote = describeTurnSettings(turnSettings);
					if (turnSettingsNote) {
						yield {
							type: 'model_resolution',
							timestamp: clock.now(),
							document: docEntry.filename,
							taskIndex,
							model: turnSettings.model ?? null,
							effort: turnSettings.effort ?? null,
							notes: turnSettings.notes,
							warnings: turnSettings.warnings,
							message: turnSettingsNote,
						};
					}

					// The Maestro system prompt rides the adapter's task turns, so the agent
					// sees the same Maestro context as a desktop Auto Run task. The synopsis
					// turn below intentionally omits it: it resumes into the same agent that
					// already has the prompt, and re-sending would waste tokens.
					const result = await deps.turns.run({
						purpose: 'task',
						prompt: finalPrompt,
						model: turnSettings.model,
						effort: turnSettings.effort,
						document: docEntry.filename,
						signal,
					});

					const elapsedMs = clock.now() - taskStartTime;

					// Re-read document to get new task count and check for halt marker
					const { unchecked: newRemainingTasks, content: postContent } = await deps.documents.read(
						folderPath,
						docEntry.filename
					);
					const tasksCompletedThisRun = remainingTasks - newRemainingTasks;
					const haltMarker = detectHaltMarker(postContent);

					// Did anything actually move? Compared by CHECKBOX, never by document
					// bytes: an agent that cannot do the task usually writes an
					// explanation into the file instead, and a byte comparison would read
					// that as progress and let the loop run forever.
					const stall = evaluateStall({
						before: countMarkdownTasks(expandedDocContent || docContent),
						after: countMarkdownTasks(postContent),
						consecutiveNoChangeCount,
					});
					consecutiveNoChangeCount = stall.consecutiveNoChangeCount;

					if (debug) {
						yield {
							type: 'debug',
							timestamp: clock.now(),
							category: 'stall',
							message: `${docEntry.filename}: no-progress counter ${consecutiveNoChangeCount}/${MAX_CONSECUTIVE_NO_CHANGES} (tasks completed this run: ${tasksCompletedThisRun})`,
						};
					}

					// Update counters
					docTasksCompleted += tasksCompletedThisRun;
					totalCompletedTasks += tasksCompletedThisRun;
					loopTasksCompleted += tasksCompletedThisRun;
					anyTasksProcessedThisIteration = true;

					// Track usage
					if (result.usageStats) {
						loopTotalInputTokens += result.usageStats.inputTokens || 0;
						loopTotalOutputTokens += result.usageStats.outputTokens || 0;
						loopTotalCost += result.usageStats.totalCostUsd || 0;
						totalCost += result.usageStats.totalCostUsd || 0;
						totalInputTokens += result.usageStats.inputTokens || 0;
						totalOutputTokens += result.usageStats.outputTokens || 0;
					}

					// Generate synopsis
					let shortSummary = `[${docEntry.filename}] Task completed`;
					let fullSynopsis = shortSummary;

					if (result.success && result.agentSessionId && !skipSynopsis) {
						// Request synopsis from the agent. A synopsis is a throwaway
						// summarization of work that already happened, so it runs at the
						// bottom of both ladders regardless of what the task ran at. On a
						// long playbook this is one premium turn per task saved. Safe
						// because the synopsis is a leaf: its returned agentSessionId is
						// discarded, so the downgrade cannot follow the conversation into
						// the next real turn. The `??` fallbacks matter on providers with
						// no tier mapping (codex, opencode): there is nothing to downgrade
						// TO, so the synopsis inherits, and it must inherit the same value
						// the task ran under - the run override, not just the session's.
						const synopsisResult = await deps.turns.run({
							purpose: 'synopsis',
							prompt: await deps.prompts.get(PROMPT_IDS.AUTORUN_SYNOPSIS),
							resumeSessionId: result.agentSessionId,
							model: cheapSynopsis.model ?? runModel ?? session.customModel,
							effort: cheapSynopsis.effort ?? runEffort ?? session.customEffort,
							document: docEntry.filename,
							signal,
						});

						if (synopsisResult.success && synopsisResult.response) {
							const parsed = parseSynopsis(synopsisResult.response);
							shortSummary = parsed.shortSummary;
							fullSynopsis = parsed.fullSynopsis;
						}
					} else if (result.outcome === 'interrupted') {
						shortSummary = `[${docEntry.filename}] Task interrupted`;
						fullSynopsis = 'Interrupted by the operator before the task finished.';
					} else if (!result.success) {
						shortSummary = `[${docEntry.filename}] Task failed`;
						fullSynopsis = result.error || shortSummary;
					}

					// Emit task complete event
					yield {
						type: 'task_complete',
						timestamp: clock.now(),
						document: docEntry.filename,
						taskIndex,
						success: result.success,
						summary: shortSummary,
						fullResponse: fullSynopsis,
						elapsedMs,
						usageStats: result.usageStats,
						agentSessionId: result.agentSessionId,
					};

					// Add history entry if enabled
					if (writeHistory) {
						// Stamp the checkbox count so cross-restart reconciliation can
						// reconstruct exact cumulative totals (matches desktop Auto Run).
						const historyEntry = buildTaskHistoryEntry(session, {
							now: clock.now(),
							summary: shortSummary,
							fullResponse: fullSynopsis,
							agentSessionId: result.agentSessionId,
							success: result.success,
							usageStats: result.usageStats,
							elapsedMs,
							completedTaskCount: tasksCompletedThisRun,
						});
						await deps.history.append(historyEntry);
						if (debug) {
							yield {
								type: 'history_write',
								timestamp: clock.now(),
								entryId: historyEntry.id,
							};
						}
					}

					// The operator stopped the run (Ctrl+C). The interrupted task was
					// recorded above as "interrupted", not as a failure, and the run
					// reconciles and closes exactly like a halt so the next run's
					// aggregation does not absorb this one's task entries.
					if (result.outcome === 'interrupted' || signal?.aborted) {
						log.autorun(`Auto Run stopped by operator`, session.name, {
							document: docEntry.filename,
							taskIndex,
							loopNumber: loopIteration + 1,
						});

						await createFinalLoopEntry('Stopped by operator');
						deps.activity.end(session.id);

						const stopReconciled = await reconcileTotals();
						await createAutoRunSummary(stopReconciled, OPERATOR_STOP_OUTCOME);

						yield {
							type: 'complete',
							timestamp: clock.now(),
							success: false,
							totalTasksCompleted: stopReconciled.totalCompletedTasks,
							totalElapsedMs: stopReconciled.totalElapsedMs,
							totalCost: stopReconciled.totalCost,
							stopped: true,
						};
						return;
					}

					// Halt marker detected - agent has signaled early exit. Stop the
					// entire playbook now: no further tasks in this document, no
					// further documents, no further loop iterations.
					if (haltMarker.halted) {
						const haltReason = haltMarker.reason || 'Halted by agent';

						log.autorun(`Auto Run halted by agent`, session.name, {
							document: docEntry.filename,
							taskIndex,
							reason: haltReason,
							loopNumber: loopIteration + 1,
						});

						yield {
							type: 'halt',
							timestamp: clock.now(),
							document: docEntry.filename,
							taskIndex,
							reason: haltReason,
						};

						await createFinalLoopEntry(`Halted by agent: ${haltReason}`);
						deps.activity.end(session.id);

						// A halt is still an end-of-run, so it reconciles like one. Emitting
						// the raw in-memory counters here would undercount any run that
						// crossed a restart before halting, and - because the halt returns
						// early - would also leave no final summary row, so the NEXT run's
						// aggregation would absorb this one's task entries.
						const haltReconciled = await reconcileTotals();
						await createAutoRunSummary(haltReconciled, `halted: ${haltReason}`);

						yield {
							type: 'complete',
							timestamp: clock.now(),
							success: false,
							totalTasksCompleted: haltReconciled.totalCompletedTasks,
							totalElapsedMs: haltReconciled.totalElapsedMs,
							totalCost: haltReconciled.totalCost,
							halted: true,
							haltReason,
						};
						return;
					}

					remainingTasks = newRemainingTasks;
					taskIndex++;

					// The document made no progress often enough that dispatching it again
					// would just spend tokens on the same wall. Give up on THIS document
					// and move to the next one - unlike a halt, the playbook continues.
					if (stall.stalled) {
						documentStalled = {
							reason: stall.reason ?? describeStall(consecutiveNoChangeCount),
							remainingTasks,
						};
						break;
					}
				}

				if (documentStalled) {
					const hasNextDocument = docIndex < playbook.documents.length - 1;

					log.autorun(`Document stalled: ${docEntry.filename}`, session.name, {
						document: docEntry.filename,
						reason: documentStalled.reason,
						remainingTasks: documentStalled.remainingTasks,
						loopNumber: loopIteration + 1,
					});

					yield {
						type: 'document_stalled',
						timestamp: clock.now(),
						document: docEntry.filename,
						reason: documentStalled.reason,
						remainingTasks: documentStalled.remainingTasks,
						hasNextDocument,
					};

					// Skipped, not completed: emitting document_complete here would tell
					// every consumer the tasks got done.
					continue;
				}

				// Document complete - handle reset-on-completion
				if (docEntry.resetOnCompletion && docTasksCompleted > 0) {
					// AUTORUN LOG: Document reset
					log.autorun(`Resetting document: ${docEntry.filename}`, session.name, {
						document: docEntry.filename,
						tasksCompleted: docTasksCompleted,
						loopNumber: loopIteration + 1,
					});

					const { content: currentContent } = await deps.documents.read(
						folderPath,
						docEntry.filename
					);
					const resetContent = deps.documents.uncheckAll(currentContent);
					await deps.documents.write(folderPath, docEntry.filename + '.md', resetContent);
					if (debug) {
						const { unchecked: newTaskCount } = await deps.documents.read(
							folderPath,
							docEntry.filename
						);
						yield {
							type: 'debug',
							timestamp: clock.now(),
							category: 'reset',
							message: `Reset ${docEntry.filename}: unchecked all tasks (${newTaskCount} tasks now open)`,
						};
					}
				}

				// Emit document complete event
				yield {
					type: 'document_complete',
					timestamp: clock.now(),
					document: docEntry.filename,
					tasksCompleted: docTasksCompleted,
				};
			}

			// Check if we should continue looping
			if (!playbook.loopEnabled) {
				if (debug) {
					yield {
						type: 'debug',
						timestamp: clock.now(),
						category: 'loop',
						message: 'Exiting: loopEnabled is false',
					};
				}
				await createFinalLoopEntry('Looping disabled');
				break;
			}

			// Check max loop limit
			if (
				playbook.maxLoops !== null &&
				playbook.maxLoops !== undefined &&
				loopIteration + 1 >= playbook.maxLoops
			) {
				if (debug) {
					yield {
						type: 'debug',
						timestamp: clock.now(),
						category: 'loop',
						message: `Exiting: reached max loops (${playbook.maxLoops})`,
					};
				}
				await createFinalLoopEntry(`Reached max loop limit (${playbook.maxLoops})`);
				break;
			}

			// Check if any non-reset documents have remaining tasks
			const hasAnyNonResetDocs = playbook.documents.some((doc) => !doc.resetOnCompletion);
			if (debug) {
				const nonResetDocs = playbook.documents
					.filter((d) => !d.resetOnCompletion)
					.map((d) => d.filename);
				const resetDocs = playbook.documents
					.filter((d) => d.resetOnCompletion)
					.map((d) => d.filename);
				yield {
					type: 'debug',
					timestamp: clock.now(),
					category: 'loop',
					message: `Checking loop condition: ${nonResetDocs.length} non-reset docs [${nonResetDocs.join(', ')}], ${resetDocs.length} reset docs [${resetDocs.join(', ')}]`,
				};
			}

			if (hasAnyNonResetDocs) {
				let anyNonResetDocsHaveTasks = false;
				for (const doc of playbook.documents) {
					if (doc.resetOnCompletion) continue;
					const { unchecked: taskCount } = await deps.documents.read(folderPath, doc.filename);
					if (debug) {
						yield {
							type: 'debug',
							timestamp: clock.now(),
							category: 'loop',
							message: `Non-reset doc ${doc.filename}: ${taskCount} unchecked task${taskCount !== 1 ? 's' : ''}`,
						};
					}
					if (taskCount > 0) {
						anyNonResetDocsHaveTasks = true;
						break;
					}
				}
				if (!anyNonResetDocsHaveTasks) {
					if (debug) {
						yield {
							type: 'debug',
							timestamp: clock.now(),
							category: 'loop',
							message: 'Exiting: all non-reset documents have 0 remaining tasks',
						};
					}
					await createFinalLoopEntry('All tasks completed');
					break;
				}
			} else {
				// All documents are reset docs - exit after one pass
				if (debug) {
					yield {
						type: 'debug',
						timestamp: clock.now(),
						category: 'loop',
						message:
							'Exiting: ALL documents have resetOnCompletion=true (loop requires at least one non-reset doc to drive iterations)',
					};
				}
				await createFinalLoopEntry('All documents have reset-on-completion');
				break;
			}

			// Safety check
			if (!anyTasksProcessedThisIteration) {
				if (debug) {
					yield {
						type: 'debug',
						timestamp: clock.now(),
						category: 'loop',
						message: 'Exiting: no tasks were processed this iteration (safety check)',
					};
				}
				await createFinalLoopEntry('No tasks processed this iteration');
				break;
			}

			if (debug) {
				yield {
					type: 'debug',
					timestamp: clock.now(),
					category: 'loop',
					message: `Continuing to next loop iteration (current: ${loopIteration + 1})`,
				};
			}

			// Emit loop complete event
			const loopElapsedMs = clock.now() - loopStartTime;
			const loopUsageStats: UsageStats | undefined = summaryUsageStats(
				loopTotalInputTokens,
				loopTotalOutputTokens,
				loopTotalCost
			);

			yield {
				type: 'loop_complete',
				timestamp: clock.now(),
				iteration: loopIteration + 1,
				tasksCompleted: loopTasksCompleted,
				elapsedMs: loopElapsedMs,
				usageStats: loopUsageStats,
			};

			// AUTORUN LOG: Loop completion
			log.autorun(`Loop ${loopIteration + 1} completed`, session.name, {
				loopNumber: loopIteration + 1,
				tasksCompleted: loopTasksCompleted,
			});

			// Add loop summary history entry
			if (writeHistory) {
				await deps.history.append(
					buildLoopEntry(
						session,
						clock.now(),
						loopIteration + 1,
						loopTasksCompleted,
						loopElapsedMs,
						loopUsageStats
					)
				);
			}

			// Reset per-loop tracking
			loopStartTime = clock.now();
			loopTasksCompleted = 0;
			loopTotalInputTokens = 0;
			loopTotalOutputTokens = 0;
			loopTotalCost = 0;

			loopIteration++;
		}

		// The run is no longer busy
		deps.activity.end(session.id);

		// Reconcile cumulative totals against persisted history so a run that
		// spanned a restart/resume reports its full stats, not just this
		// process's in-memory slice.
		const reconciled = await reconcileTotals();

		// A stop that lands after the last task is still a stop. The only other
		// abort check sits inside the task loop, so a Ctrl+C arriving once the
		// loop was done fell through to the success block below and exited 0
		// instead of 130. The loop has already written its own final entry by
		// now ("All tasks completed" and the like), so history records why the
		// LOOP ended while this records why the RUN did.
		if (signal?.aborted) {
			await createAutoRunSummary(reconciled, OPERATOR_STOP_OUTCOME);

			yield {
				type: 'complete',
				timestamp: clock.now(),
				success: false,
				totalTasksCompleted: reconciled.totalCompletedTasks,
				totalElapsedMs: reconciled.totalElapsedMs,
				totalCost: reconciled.totalCost,
				stopped: true,
			};
			return;
		}

		// Add total Auto Run summary
		await createAutoRunSummary(reconciled);

		// Emit complete event with the reconciled totals so resumed runs report
		// cumulative stats to consumers, not just the persisted summary entry.
		yield {
			type: 'complete',
			timestamp: clock.now(),
			success: true,
			totalTasksCompleted: reconciled.totalCompletedTasks,
			totalElapsedMs: reconciled.totalElapsedMs,
			totalCost: reconciled.totalCost,
		};
	} finally {
		// Ensure activity is always cleared even if the generator throws
		deps.activity.end(session.id);
	}
}
