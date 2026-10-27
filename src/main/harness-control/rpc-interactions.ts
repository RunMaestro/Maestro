import type {
	NdJsonRecord,
	NdJsonServerResponse,
} from '../../shared/maestro-lib/harness/rpc/connection';
import type { HarnessInteractionOption } from '../../shared/harness-control/types';
import type { InteractionBroker } from './InteractionBroker';
import { harnessInteractionBroker } from './integration';

const DIALOG_METHODS: Record<string, true> = {
	select: true,
	confirm: true,
	input: true,
	editor: true,
};

/** Broker a Pi/OMP extension UI request through the process-wide interaction owner. */
export function answerRpcExtensionRequest(
	record: NdJsonRecord,
	context: { sessionId: string; tabId?: string; spawnGeneration: number; provider: string }
): Promise<NdJsonServerResponse> {
	return answerRpcExtensionRequestWithBroker(record, context, harnessInteractionBroker);
}

/** Translate extension dialogs with an injectable broker for isolated protocol tests. */
export async function answerRpcExtensionRequestWithBroker(
	record: NdJsonRecord,
	context: { sessionId: string; tabId?: string; spawnGeneration: number; provider: string },
	broker: InteractionBroker
): Promise<NdJsonServerResponse> {
	if (record.type !== 'extension_ui_request' || typeof record.method !== 'string') {
		return {
			kind: 'error',
			code: -32601,
			message: `Maestro does not handle ${String(record.type)}`,
		};
	}
	if (!DIALOG_METHODS[record.method]) return { kind: 'ignore' };
	const method = record.method;
	const rawOptions = Array.isArray(record.options) ? record.options : [];
	const options: HarnessInteractionOption[] = rawOptions.flatMap((value, index) => {
		if (typeof value !== 'string' || !value) return [];
		return [{ optionId: `option-${index}`, label: value, kind: 'choice' as const }];
	});
	if (method === 'confirm' && options.length === 0) {
		options.push(
			{ optionId: 'confirm', label: 'Confirm', kind: 'allow-once' },
			{ optionId: 'cancel', label: 'Cancel', kind: 'reject-once' }
		);
	}
	const opened = broker.open({
		sessionId: context.sessionId,
		tabId: context.tabId,
		spawnGeneration: context.spawnGeneration,
		kind: method === 'confirm' ? 'permission' : 'question',
		provider: context.provider,
		title: typeof record.title === 'string' ? record.title : `${context.provider} requests input`,
		detail: typeof record.message === 'string' ? record.message : undefined,
		toolName: method,
		input: record,
		options,
		secret: typeof record.title === 'string' && /password|secret|token/i.test(record.title),
	});
	const resolution = await opened.completion;
	if (resolution.outcome === 'cancelled') return { kind: 'extension', value: { cancelled: true } };
	if (resolution.outcome === 'selected') {
		if (method === 'confirm') {
			return { kind: 'extension', value: { confirmed: resolution.optionId === 'confirm' } };
		}
		const index = Number(resolution.optionId.slice('option-'.length));
		const value = rawOptions[index];
		if (typeof value === 'string') return { kind: 'extension', value: { value } };
		return { kind: 'extension', value: { cancelled: true } };
	}
	const answer = resolution.answers.answer ?? Object.values(resolution.answers)[0];
	return { kind: 'extension', value: { value: answer ?? '' } };
}
