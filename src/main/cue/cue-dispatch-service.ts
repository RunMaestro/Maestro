import * as crypto from 'crypto';
import type { MainLogLevel } from '../../shared/logger-types';
import type { CueEvent, CueSubscription } from './cue-types';

export interface CueDispatchServiceDeps {
	getSessions: () => Array<{ id: string; name: string }>;
	executeRun: (
		sessionId: string,
		prompt: string,
		event: CueEvent,
		subscriptionName: string,
		outputPrompt?: string,
		chainDepth?: number
	) => void;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
}

export interface CueDispatchService {
	dispatchSubscription(
		ownerSessionId: string,
		sub: CueSubscription,
		event: CueEvent,
		sourceSessionName: string,
		chainDepth?: number,
		promptOverride?: string
	): void;
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
		): void {
			if (sub.fan_out && sub.fan_out.length > 0) {
				const targetNames = sub.fan_out.join(', ');
				deps.onLog('cue', `[CUE] Fan-out: "${sub.name}" → ${targetNames}`);

				const allSessions = deps.getSessions();
				for (let i = 0; i < sub.fan_out.length; i++) {
					const targetName = sub.fan_out[i];
					const targetSession = allSessions.find(
						(s) => s.name === targetName || s.id === targetName
					);

					if (!targetSession) {
						deps.onLog('cue', `[CUE] Fan-out target not found: "${targetName}" — skipping`);
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
						continue;
					}
					deps.executeRun(
						targetSession.id,
						prompt,
						fanOutEvent,
						sub.name,
						sub.output_prompt,
						chainDepth
					);
				}
				return;
			}

			const prompt = promptOverride ?? sub.prompt;
			if (!prompt) {
				deps.onLog('warn', `[CUE] "${sub.name}" has no prompt — skipping dispatch`);
				return;
			}
			deps.executeRun(ownerSessionId, prompt, event, sub.name, sub.output_prompt, chainDepth);
		},
	};
}
