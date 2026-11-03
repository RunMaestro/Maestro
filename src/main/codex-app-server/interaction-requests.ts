import type { CodexAppServerRequest } from '../../shared/maestro-lib/codex/protocol';
import type { CodexServerRequestAnswer } from '../../shared/maestro-lib/codex/server-requests';
import type {
	HarnessInteractionOption,
	HarnessInteractionOpenRequest,
	HarnessInteractionQuestion,
	HarnessInteractionResolution,
} from '../../shared/harness-control/types';

export interface CodexInteractionContext {
	sessionId: string;
	tabId?: string;
	spawnGeneration: number;
}

export interface CodexServerInteraction {
	request: HarnessInteractionOpenRequest;
	answer: (resolution: HarnessInteractionResolution) => CodexServerRequestAnswer;
}

const DECISION_PRESENTATION: Record<
	string,
	{ label: string; kind: HarnessInteractionOption['kind'] }
> = {
	accept: { label: 'Allow once', kind: 'allow-once' },
	acceptForSession: { label: 'Allow for this session', kind: 'allow-always' },
	decline: { label: 'Deny', kind: 'reject-once' },
	cancel: { label: 'Cancel turn', kind: 'reject-once' },
	acceptWithExecpolicyAmendment: { label: 'Allow and update exec policy', kind: 'allow-always' },
	applyNetworkPolicyAmendment: { label: 'Apply network policy', kind: 'allow-always' },
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decisionKey(decision: unknown): string | null {
	if (typeof decision === 'string') return decision;
	if (!isObject(decision)) return null;
	const keys = Object.keys(decision);
	return keys.length === 1 ? keys[0] : null;
}

function approvalRequest(
	request: CodexAppServerRequest,
	context: CodexInteractionContext,
	decisions: unknown[]
): CodexServerInteraction | null {
	const params = isObject(request.params) ? request.params : {};
	const options: HarnessInteractionOption[] = [];
	const nativeDecisions: unknown[] = [];
	for (const decision of decisions) {
		const key = decisionKey(decision);
		if (!key || !DECISION_PRESENTATION[key]) continue;
		options.push({
			optionId: `decision-${options.length}`,
			...DECISION_PRESENTATION[key],
		});
		nativeDecisions.push(decision);
	}
	if (options.length === 0) return null;
	return {
		request: {
			sessionId: context.sessionId,
			tabId: context.tabId,
			spawnGeneration: context.spawnGeneration,
			turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
			toolCallId: typeof params.itemId === 'string' ? params.itemId : undefined,
			kind: 'permission',
			provider: 'codex',
			title:
				(typeof params.reason === 'string' && params.reason) ||
				(typeof params.title === 'string' && params.title) ||
				'Codex requests approval',
			toolName: request.method,
			input: params,
			options,
		},
		answer: (resolution) => {
			if (resolution.outcome === 'selected') {
				const index = Number(resolution.optionId.slice('decision-'.length));
				if (Number.isSafeInteger(index) && index >= 0 && index < nativeDecisions.length) {
					return { result: { decision: nativeDecisions[index] } };
				}
			}
			return { result: { decision: 'cancel' } };
		},
	};
}

function questionOptions(raw: unknown): HarnessInteractionOption[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((value, index) => {
		if (!isObject(value) || typeof value.label !== 'string' || value.label.length === 0) return [];
		return [
			{
				optionId: `option-${index}`,
				label: value.label,
				kind: 'choice' as const,
				...(typeof value.description === 'string' ? { description: value.description } : {}),
			},
		];
	});
}

function userInputRequest(
	request: CodexAppServerRequest,
	context: CodexInteractionContext
): CodexServerInteraction {
	const params = isObject(request.params) ? request.params : {};
	const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
	const questions: HarnessInteractionQuestion[] = rawQuestions.flatMap((value, index) => {
		if (!isObject(value) || typeof value.question !== 'string') return [];
		return [
			{
				id: typeof value.id === 'string' ? value.id : `question-${index}`,
				question: value.question,
				header: typeof value.header === 'string' ? value.header : undefined,
				options: questionOptions(value.options),
				allowCustom: value.isOther === true,
				secret: value.isSecret === true,
			},
		];
	});
	return {
		request: {
			sessionId: context.sessionId,
			tabId: context.tabId,
			spawnGeneration: context.spawnGeneration,
			turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
			toolCallId: typeof params.itemId === 'string' ? params.itemId : undefined,
			kind: 'question',
			provider: 'codex',
			title: 'Codex has a question',
			input: params,
			options: [],
			questions,
			secret: questions.some((question) => question.secret),
		},
		answer: (resolution) => {
			if (resolution.outcome !== 'answers') return { result: { answers: {} } };
			const answers: Record<string, { answers: string[] }> = {};
			for (const question of questions) {
				const answer = resolution.answers[question.id];
				if (answer === undefined) continue;
				answers[question.id] = { answers: Array.isArray(answer) ? answer : [answer] };
			}
			return { result: { answers } };
		},
	};
}

function elicitationRequest(
	request: CodexAppServerRequest,
	context: CodexInteractionContext
): CodexServerInteraction {
	const params = isObject(request.params) ? request.params : {};
	const message = typeof params.message === 'string' ? params.message : 'MCP server requests input';
	return {
		request: {
			sessionId: context.sessionId,
			tabId: context.tabId,
			spawnGeneration: context.spawnGeneration,
			kind: 'elicitation',
			provider: 'codex',
			title: message,
			detail: JSON.stringify(params.requestedSchema ?? {}, null, 2),
			input: params,
			options: [],
			questions: [
				{
					id: 'content',
					question: 'Enter the requested JSON content, or Cancel to decline.',
					options: [],
					allowCustom: true,
				},
			],
		},
		answer: (resolution) => {
			if (resolution.outcome === 'cancelled') return { result: { action: 'cancel' } };
			if (resolution.outcome !== 'answers') return { result: { action: 'decline' } };
			try {
				const rawContent = resolution.answers.content;
				if (typeof rawContent !== 'string') return { result: { action: 'decline' } };
				const content = JSON.parse(rawContent);
				return { result: { action: 'accept', content } };
			} catch {
				return { result: { action: 'decline' } };
			}
		},
	};
}

/** Returns null when the method should retain its non-interactive policy answer. */
export function codexServerInteraction(
	request: CodexAppServerRequest,
	context: CodexInteractionContext
): CodexServerInteraction | null {
	const params = isObject(request.params) ? request.params : {};
	switch (request.method) {
		case 'item/commandExecution/requestApproval':
		case 'item/fileChange/requestApproval':
			return approvalRequest(
				request,
				context,
				Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0
					? params.availableDecisions
					: ['accept', 'decline', 'cancel']
			);
		case 'item/permissions/requestApproval':
			return {
				request: {
					sessionId: context.sessionId,
					tabId: context.tabId,
					spawnGeneration: context.spawnGeneration,
					turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
					toolCallId: typeof params.itemId === 'string' ? params.itemId : undefined,
					kind: 'permission',
					provider: 'codex',
					title: 'Codex requests additional permissions',
					input: params,
					options: [
						{ optionId: 'grant', label: 'Grant for this turn', kind: 'allow-once' },
						{ optionId: 'deny', label: 'Deny', kind: 'reject-once' },
					],
				},
				answer: (resolution) => ({
					result: {
						permissions:
							resolution.outcome === 'selected' && resolution.optionId === 'grant'
								? (params.permissions ?? {})
								: {},
						...(resolution.outcome === 'selected' && resolution.optionId === 'grant'
							? { scope: 'turn' }
							: {}),
					},
				}),
			};
		case 'execCommandApproval':
		case 'applyPatchApproval':
			return {
				request: {
					sessionId: context.sessionId,
					tabId: context.tabId,
					spawnGeneration: context.spawnGeneration,
					kind: 'permission',
					provider: 'codex',
					title: 'Codex requests approval',
					input: params,
					options: [
						{ optionId: 'approved', label: 'Allow once', kind: 'allow-once' },
						{ optionId: 'denied', label: 'Deny', kind: 'reject-once' },
					],
				},
				answer: (resolution) => ({
					result: {
						decision:
							resolution.outcome === 'selected' && resolution.optionId === 'approved'
								? 'approved'
								: 'denied',
					},
				}),
			};
		case 'item/tool/requestUserInput':
			return userInputRequest(request, context);
		case 'mcpServer/elicitation/request':
			return elicitationRequest(request, context);
		default:
			return null;
	}
}
