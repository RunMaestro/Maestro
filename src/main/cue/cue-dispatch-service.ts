import * as crypto from 'crypto';
import type { MainLogLevel } from '../../shared/logger-types';
import type { CueCommand, CueEvent, CueSubscription } from './cue-types';

export interface CueDispatchServiceDeps {
	getSessions: () => Array<{ id: string; name: string }>;
	executeRun: (
		sessionId: string,
		prompt: string,
		event: CueEvent,
		subscriptionName: string,
		outputPrompt?: string,
		chainDepth?: number,
		cliOutput?: { target: string },
		action?: CueSubscription['action'],
		command?: CueCommand
	) => void;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
}

export interface CueDispatchService {
	/**
	 * Dispatches a subscription and returns the number of runs actually queued.
	 * Callers (e.g. manual-trigger) use the count to tell the user when a
	 * trigger silently accomplished nothing — e.g. all fan-out targets had
	 * empty prompts. Previously this returned void and the user had no way
	 * to distinguish "no-op" from "running in the background".
	 */
	dispatchSubscription(
		ownerSessionId: string,
		sub: CueSubscription,
		event: CueEvent,
		sourceSessionName: string,
		chainDepth?: number,
		promptOverride?: string
	): number;
}

export function createCueDispatchService(deps: CueDispatchServiceDeps): CueDispatchService {
	return {
		dispatchSubscription(
			ownerSessionId: string,
			sub: CueSubscription,
			event: CueEvent,
			sourceSessionName: string,
			chainDepth?: number,
			promptOverride?: string
		): number {
			if (sub.fan_out && sub.fan_out.length > 0) {
				const targetNames = sub.fan_out.join(', ');
				deps.onLog('cue', `[CUE] Fan-out: "${sub.name}" → ${targetNames}`);

				const allSessions = deps.getSessions();
				let dispatched = 0;
				const skippedTargets: string[] = [];
				for (let i = 0; i < sub.fan_out.length; i++) {
					const targetName = sub.fan_out[i];
					// Prefer the stable id when present so a renamed agent still
					// resolves. Falls back to name-or-id match for legacy YAML
					// written before `fan_out_ids` existed.
					const targetId = sub.fan_out_ids?.[i];
					const targetSession =
						(targetId ? allSessions.find((s) => s.id === targetId) : undefined) ??
						allSessions.find((s) => s.name === targetName || s.id === targetName);

					if (!targetSession) {
						deps.onLog('cue', `[CUE] Fan-out target not found: "${targetName}" — skipping`);
						skippedTargets.push(`${targetName} (not found)`);
						continue;
					}

					const fanOutEvent: CueEvent = {
						...event,
						id: crypto.randomUUID(),
						payload: {
							...event.payload,
							fanOutSource: sourceSessionName,
							fanOutIndex: i,
						},
					};
					// The normalizer (cue-config-normalizer.ts) resolves prompt_file → prompt
					// content at config load time. sub.prompt is always a string post-normalization.
					const perTargetPrompt = sub.fan_out_prompts?.[i];
					const prompt = promptOverride ?? perTargetPrompt ?? sub.prompt;
					if (!prompt) {
						deps.onLog(
							'warn',
							`[CUE] Fan-out target ${i} of "${sub.name}" has no prompt — skipping dispatch`
						);
						skippedTargets.push(`${targetName} (empty prompt)`);
						continue;
					}
					deps.executeRun(
						targetSession.id,
						prompt,
						fanOutEvent,
						sub.name,
						sub.output_prompt,
						chainDepth,
						sub.cli_output,
						sub.action,
						sub.command
					);
					dispatched++;
				}
				// If every fan-out target was skipped the user sees nothing happen —
				// surface a loud error so they can fix the broken prompts. This was
				// the primary cause of "manual trigger doesn't start with 2 agents"
				// reports: the debounce race wiped prompts so both targets got skipped.
				if (dispatched === 0 && skippedTargets.length > 0) {
					deps.onLog(
						'error',
						`[CUE] "${sub.name}": no fan-out targets ran (${skippedTargets.join('; ')}). Check that each agent has a prompt configured.`
					);
				}
				return dispatched;
			}

			const prompt = promptOverride ?? sub.prompt;
			if (!prompt) {
				deps.onLog('warn', `[CUE] "${sub.name}" has no prompt — skipping dispatch`);
				return 0;
			}
			deps.executeRun(
				ownerSessionId,
				prompt,
				event,
				sub.name,
				sub.output_prompt,
				chainDepth,
				sub.cli_output,
				sub.action,
				sub.command
			);
			return 1;
		},
	};
}
