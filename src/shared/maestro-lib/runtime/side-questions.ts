/**
 * `/btw` side questions, answered by a headless host about one of its tabs (M6).
 *
 * A side question asks the tab's own model something about the conversation, while the tab may
 * still be working, and keeps the exchange out of that conversation. A desktop host answers it in
 * its main process (`sideQuestion:ask`, through `groomContext`); a headless host answers it here,
 * over the same shared pieces, so the card a hosted agent's `/btw` fills reads as a local one:
 *
 * | Piece | Shared with the desktop |
 * | --- | --- |
 * | Which tab, and Claude Code only | `resolveSideQuestionTarget` |
 * | Whether the provider can fork | `sideQuestionForkRefusal` |
 * | The prompt | `buildSideQuestionPrompt` (inside `assembleSideQuestionTurn`) |
 * | The turn: read-only throwaway fork, tools off, no system prompt, `claude --print` | `assembleSideQuestionTurn`, the runner's `sideQuestion` mode |
 * | How long it may take | `SIDE_QUESTION_TIMEOUT_MS` |
 *
 * It is never queued and never waits for the tab's turn: a fork only reads the session, so it
 * runs beside a turn that writes it, as on the desktop. Nothing is written to the tab, its
 * History, or the usage stats. Its process is registered beside the tab (`sideQuestionSlot`), so
 * shutdown and fencing stop it and the tab does not read busy for it.
 */

import { SIDE_QUESTION_TIMEOUT_MS, resolveSideQuestionTarget } from '../../sideQuestion';
import type { AgentRepository } from '../agents/repository';
import type { RuleContext } from '../agents/rules';
import type {
	ClientError,
	ClientErrorCode,
	ClientResult,
	ConsultAnswer,
	ConsultAskInput,
} from '../client/types';
import type { MaestroPaths } from '../paths/resolve';
import type { StatsRecordResult } from '../turns/stats';
import { createAutoRunTurnRunner } from './autorun-turns';
import type { ProcessRegistry } from './processes';
import type { RuntimeTurnDeps, RuntimeTurnOptions } from './turns';

/**
 * The registry slot one side question's process runs under: beside the tab, never on it, and one
 * per question, so two questions about one tab do not share a slot.
 */
export function sideQuestionSlot(tabId: string, requestId: string): string {
	return `btw:${tabId}:${requestId}`;
}

export interface RuntimeSideQuestionsOptions {
	paths: MaestroPaths;
	repository: AgentRepository;
	registry: ProcessRegistry;
	host: RuntimeTurnOptions;
	deps: Pick<RuntimeTurnDeps, 'runAgentTurn' | 'probeBinary' | 'readGitBranch' | 'now'>;
	rules: Pick<RuleContext, 'newId'>;
	/** Test seam: how long a question may take. Default `SIDE_QUESTION_TIMEOUT_MS`, the desktop's. */
	timeoutMs?: number;
}

export interface RuntimeSideQuestions {
	/** `consults.ask` with `sideQuestion`: the answer, or a failure that says why. Never rejects. */
	ask(input: ConsultAskInput): Promise<ClientResult<ConsultAnswer>>;
	/** Stop every question in flight and refuse more: the host is closing or lost its data directory. */
	dispose(): void;
}

const METHOD = 'consults.ask' as const;

/** What the runner is handed for usage in this mode, which it never calls. */
const NO_USAGE_ROW: StatsRecordResult = {
	ok: false,
	reason: 'disabled',
	message: 'A side question writes no usage row.',
};

function fail<T = never>(code: ClientErrorCode, message: string): ClientResult<T> {
	const error: ClientError = { code, message, method: METHOD };
	return { ok: false, error };
}

const str = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

export function createRuntimeSideQuestions(
	options: RuntimeSideQuestionsOptions
): RuntimeSideQuestions {
	const { repository, rules } = options;
	const timeoutMs = options.timeoutMs ?? SIDE_QUESTION_TIMEOUT_MS;
	const inFlight = new Set<AbortController>();
	let disposed = false;

	async function ask(input: ConsultAskInput): Promise<ClientResult<ConsultAnswer>> {
		if (disposed) return fail('host-unavailable', 'The runtime is closing.');
		const question = typeof input.question === 'string' ? input.question.trim() : '';
		if (!question) return fail('invalid', 'Type a question after /btw.');
		const record = repository.getAgent(input.targetAgentId);
		if (!record) return fail('not-found', `No agent with id ${input.targetAgentId}`);
		const name = str(record.name) ?? input.targetAgentId;
		const tabs = Array.isArray(record.aiTabs) ? record.aiTabs : [];
		const target = resolveSideQuestionTarget(
			{
				name,
				toolType: String(record.toolType),
				activeTabId: str(record.activeTabId),
				tabIds: tabs.map((tab) => tab.id),
			},
			str(input.targetTabId)
		);
		if (!target.ok) return fail('rejected', target.error);
		const tab = repository.getTab(record.id, target.tabId);
		if (!tab) return fail('rejected', `No AI tab ${target.tabId} on ${name}`);

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		timer.unref?.();
		inFlight.add(controller);
		try {
			const runner = createAutoRunTurnRunner({
				agentId: record.id,
				paths: options.paths,
				repository,
				registry: options.registry,
				// The desktop writes no usage row for a side question; the runner skips it in this mode.
				statsRecorder: { recordQuery: async () => NO_USAGE_ROW },
				host: options.host,
				deps: options.deps,
				onStream: () => undefined,
				processTabId: sideQuestionSlot(target.tabId, rules.newId()),
				sideQuestion: true,
			});
			// The tab's model and effort now: a change while the question runs applies to the next one.
			const result = await runner.run({
				purpose: 'task',
				prompt: question,
				...(str(tab.agentSessionId) ? { resumeSessionId: str(tab.agentSessionId) } : {}),
				model: str(tab.customModel) ?? str(record.customModel),
				effort: str(tab.customEffort) ?? str(record.customEffort),
				signal: controller.signal,
			});
			if (timedOut) {
				return fail(
					'timeout',
					`${name} did not answer within ${Math.round(timeoutMs / 1000)}s and was stopped.`
				);
			}
			if (controller.signal.aborted) return fail('host-unavailable', 'The runtime is closing.');
			if (!result.success) return fail('failed', result.error ?? 'No answer came back.');
			const answer = result.response?.trim() ?? '';
			if (!answer) return fail('failed', 'The model returned an empty answer.');
			return { ok: true, value: { answer, agentName: name } };
		} catch (error) {
			return fail('failed', error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(timer);
			inFlight.delete(controller);
		}
	}

	return {
		ask,
		dispose() {
			disposed = true;
			for (const controller of inFlight) controller.abort();
		},
	};
}
