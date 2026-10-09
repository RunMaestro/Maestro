import * as fs from 'fs';
import * as path from 'path';
import { MaestroClient } from '../services/maestro-client';
import { readSettingValue } from '../services/storage';
import { _getBundledPromptCandidatesForTests } from '../services/prompt-loader';
import { readAgentRuns } from '../services/agent-run-store';
import { pianolaTaskAgentRunId } from '../../shared/agent-run';
import { generateUUID } from '../../shared/uuid';
import { runDispatch } from './dispatch';
import { ensurePianolaEnabled } from './pianola';
import { briefRunsForPlans, derivePianolaBrief } from '../../shared/pianola/pianola-programs';
import {
	runProgramLoopTick,
	shouldLogProgramLoopDecision,
} from '../../shared/pianola/pianola-program-loop';
import {
	readPianolaPrograms,
	readPianolaPlans,
	readPianolaAsks,
	readPianolaDecisions,
	readPianolaSupervisorTargets,
	updatePianolaSupervisorTargets,
	readPianolaProgramLoopMemo,
	updatePianolaProgramLoopMemo,
	appendPianolaDecision,
	withProgramLoopLock,
} from '../services/pianola-store';

export async function pianolaProgramLoop(
	programId: string,
	options: { interval?: string; once?: boolean; json?: boolean }
): Promise<void> {
	ensurePianolaEnabled(options.json);
	const seconds = options.interval === undefined ? 120 : Number(options.interval.replace(/s$/, ''));
	if (!Number.isInteger(seconds) || seconds < 1) throw new Error('Invalid program-loop interval');
	if (!readPianolaPrograms().some((program) => program.id === programId))
		throw new Error(`Unknown program: ${programId}`);
	const client = new MaestroClient();
	await client.connect();
	let stopped = false;
	const onSignal = () => {
		stopped = true;
	};
	process.on('SIGINT', onSignal);
	try {
		while (!stopped) {
			const flags = readSettingValue('encoreFeatures') as Record<string, unknown> | undefined;
			if (flags?.pianola !== true) break;
			try {
				await withProgramLoopLock(programId, async () => {
					const program = readPianolaPrograms().find((item) => item.id === programId);
					if (!program) return;
					const plans = readPianolaPlans();
					const asks = readPianolaAsks();
					const targets = readPianolaSupervisorTargets();
					const memo = readPianolaProgramLoopMemo();
					const sessions = await client.sendCommand<{
						sessions?: { agentId: string; tabId: string; state: string }[];
					}>({ type: 'list_desktop_sessions' }, 'desktop_sessions_list');
					const leadSession =
						sessions.sessions?.find(
							(session) => session.agentId === program.leadAgentId && session.state === 'busy'
						) ?? sessions.sessions?.find((session) => session.agentId === program.leadAgentId);
					const runs = briefRunsForPlans(plans, readAgentRuns(), pianolaTaskAgentRunId);
					const brief = derivePianolaBrief([program], plans, asks, readPianolaDecisions(), runs);
					const now = new Date().toISOString();
					const result = await runProgramLoopTick(
						{
							program,
							plans,
							asks,
							brief,
							targets,
							leadSession,
							memo: memo[programId] ?? { notifiedTaskIds: [] },
							now,
						},
						{
							persistMemo: (entry) => updatePianolaProgramLoopMemo(programId, entry),
							ensureOrchestrate: (plan, concurrency) => {
								updatePianolaSupervisorTargets((current) => {
									if (
										readPianolaPrograms().find((entry) => entry.id === programId)?.status !==
										'active'
									)
										return current;
									const existing = current.find(
										(target) => target.kind === 'orchestrate' && target.planId === plan.id
									);
									if (existing && !existing.enabled) return current;
									const target = {
										id: existing?.id ?? generateUUID(),
										kind: 'orchestrate' as const,
										enabled: true,
										createdAt: existing?.createdAt ?? Date.now(),
										planId: plan.id,
										concurrency,
										intervalSeconds: 5,
									};
									return existing
										? current.map((entry) => (entry.id === existing.id ? target : entry))
										: [...current, target];
								});
							},
							findWake: async (agentId, wakeId) => {
								const marker = '[Pianola wake ' + wakeId + ']';
								for (const session of sessions.sessions ?? []) {
									if (session.agentId !== agentId) continue;
									const history = await client.sendCommand<{
										success: boolean;
										error?: string;
										messages?: { role?: string; content?: string }[];
									}>(
										{ type: 'get_session_history', tabId: session.tabId },
										'session_history_result'
									);
									if (!history.success)
										throw new Error(history.error ?? 'Cannot reconcile pending lead wake');
									if (
										history.messages?.some(
											(message) => message.role === 'user' && message.content?.includes(marker)
										)
									)
										return { success: true as const, tabId: session.tabId };
								}
								return undefined;
							},
							wake: async (agentId, prompt) => {
								if (
									readPianolaPrograms().find((entry) => entry.id === programId)?.status !== 'active'
								)
									return { success: false, error: 'Program paused' };
								const response = await runDispatch(agentId, prompt, { newTab: true });
								let tabId = response.tabId ?? response.sessionId ?? undefined;
								if (response.success && !tabId) {
									const updated = await client.sendCommand<{
										sessions?: { agentId: string; tabId: string }[];
									}>({ type: 'list_desktop_sessions' }, 'desktop_sessions_list');
									tabId = updated.sessions?.find((session) => session.agentId === agentId)?.tabId;
								}
								return { success: response.success, tabId, error: response.error };
							},
							ensureWatch: (agentId, tabId) => {
								updatePianolaSupervisorTargets((current) => {
									if (
										readPianolaPrograms().find((entry) => entry.id === programId)?.status !==
										'active'
									)
										return current;
									const existing = current.find(
										(target) => target.kind === 'watch' && target.agentId === agentId
									);
									if (existing && !existing.enabled) return current;
									const target = {
										id: existing?.id ?? generateUUID(),
										kind: 'watch' as const,
										enabled: true,
										createdAt: existing?.createdAt ?? Date.now(),
										agentId,
										tabId,
										intervalSeconds: 5,
									};
									return existing
										? current.map((entry) => (entry.id === existing.id ? target : entry))
										: [...current, target];
								});
							},
							prompt: (kind, variables) => {
								const candidate = _getBundledPromptCandidatesForTests(
									path.join('pianola-program-loop', kind + '.md')
								).find((file) => fs.existsSync(file));
								if (!candidate) throw new Error(`Missing program loop prompt: ${kind}`);
								return fs
									.readFileSync(candidate, 'utf8')
									.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => variables[key] ?? '');
							},
						}
					);
					updatePianolaProgramLoopMemo(programId, result.memo);
					if (shouldLogProgramLoopDecision(memo[programId], result)) {
						appendPianolaDecision({
							id: generateUUID(),
							timestamp: now,
							tabId: result.tabId ?? leadSession?.tabId ?? '',
							agentId: program.leadAgentId ?? '',
							projectPath: program.root,
							dispatched: result.dispatched,
							dryRun: false,
							classification: {
								kind: 'none',
								risk: 'low',
								topic: program.title,
								confidence: 'high',
								evidence: { messageId: null, reason: result.reason, structured: false },
							},
							decision: { action: 'ignore', matchedRuleId: null, reason: result.reason },
							...(result.error ? { error: result.error } : {}),
						});
						updatePianolaProgramLoopMemo(programId, {
							...result.memo,
							lastLoggedReason: result.reason,
						});
					}
					if (options.json) console.log(JSON.stringify(result));
					else console.log(result.reason);
				});
			} catch (error) {
				console.error(`[program-loop] ${error instanceof Error ? error.message : String(error)}`);
				if (options.once) throw error;
			}
			if (options.once || stopped) break;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, seconds * 1000);
			await promise;
		}
	} finally {
		process.off('SIGINT', onSignal);
		client.disconnect();
	}
}
