import path from 'node:path';
import fs from 'node:fs/promises';
import { MaestroClient } from '../services/maestro-client';
import { ensurePianolaEnabled } from './pianola';
import type {
	MemoryConfig,
	MemoryKind,
	MemoryPacket,
	MemoryQualificationConfig,
	MemoryRecallIntent,
	MemoryRequest,
	MemoryState,
} from '../../shared/pianola/memory';
import { validateMemoryRecallIntent } from '../../main/pianola/memory-lifecycle';
interface MemoryBridgeResponse<T> {
	ok: boolean;
	result: T;
	error?: string;
}
export async function requestPianolaMemory<T>(request: MemoryRequest): Promise<T> {
	const client = new MaestroClient();
	await client.connect();
	try {
		const response = await client.sendCommand<MemoryBridgeResponse<T>>(
			{
				type: 'bridge.invoke',
				channel: 'pianola:memory',
				args: [
					(request.action === 'remember' || request.action === 'correct') &&
					process.env.MAESTRO_AGENT_ID
						? { ...request, actor: 'agent' }
						: request,
				],
			},
			'bridge.response',
			300000
		);
		if (!response.ok) throw new Error(response.error ?? 'Memory request failed');
		return response.result;
	} finally {
		client.disconnect();
	}
}
interface MemoryCliOptions {
	project?: string;
	provider?: string;
	root?: string;
	mine?: boolean;
	mode?: MemoryConfig['mode'];
	hostedProvider?: MemoryConfig['hostedProvider'];
	model?: string;
	endpoint?: string;
	/** The model that answers recall qualification questions. */
	qualifyModel?: string;
	/** Where the qualification model is reached. */
	qualifyProvider?: MemoryQualificationConfig['provider'];
	qualifyEndpoint?: string;
	rerankModel?: string;
	rerankEndpoint?: string;
	tokens?: string;
	dollars?: string;
	exclude?: string[];
	consentHosted?: boolean;
	kind?: MemoryKind;
	json?: boolean;
	out?: string;
	history?: boolean;
	intent?: MemoryRecallIntent['mode'];
	qualify?: boolean;
	rerank?: boolean;
	at?: string;
}
export async function pianolaMemory(action: string, words: string[], options: MemoryCliOptions) {
	ensurePianolaEnabled(options.json);
	const value = words.join(' ');
	let request: MemoryRequest;
	switch (action) {
		case 'configure':
		case 'enable': {
			const state = await requestPianolaMemory<MemoryState>({ action: 'status' });
			const config: Partial<MemoryConfig> = { enabled: true };
			if (options.mode) config.mode = options.mode;
			if (options.hostedProvider) {
				config.hostedProvider = options.hostedProvider;
				config.model = options.hostedProvider === 'nan' ? 'qwen3.6' : 'gpt-5.4-mini';
				config.inputPrice = options.hostedProvider === 'nan' ? 0 : 0.75;
				config.outputPrice = options.hostedProvider === 'nan' ? 0 : 4.5;
			}
			if (options.model) config.model = options.model;
			if (options.endpoint) config.endpoint = options.endpoint;
			if (options.qualifyModel || options.qualifyProvider || options.qualifyEndpoint) {
				// The qualification gate has its own provider and model, so it can be
				// pointed at a different service than extraction without touching it.
				const current = state.config.qualification;
				config.qualification = {
					provider: options.qualifyProvider ?? current?.provider ?? 'local',
					model: options.qualifyModel ?? current?.model ?? 'qwen3:8b',
					endpoint: options.qualifyEndpoint ?? current?.endpoint ?? 'http://127.0.0.1:11434',
					...(current?.apiKeyEnv ? { apiKeyEnv: current.apiKeyEnv } : {}),
				};
			}
			if (options.rerankModel || options.rerankEndpoint) {
				const current = state.config.rerank;
				config.rerank = {
					provider: 'hosted',
					model: options.rerankModel ?? current?.model ?? 'rerank',
					endpoint: options.rerankEndpoint ?? current?.endpoint ?? 'https://api.nan.builders',
					...(current?.apiKeyEnv ? { apiKeyEnv: current.apiKeyEnv } : {}),
				};
			}
			if (options.tokens) config.tokenBudget = Number(options.tokens);
			if (options.dollars) config.dollarBudget = Number(options.dollars);
			if (options.consentHosted) config.hostedConsent = true;
			if (options.exclude) config.exclusions = options.exclude.map((p) => path.resolve(p));
			if (options.root) {
				if (!options.provider) throw new Error('--root requires --provider');
				const root = path.resolve(options.root);
				config.roots = [
					...state.config.roots.filter(
						(r) => !(r.provider === options.provider && path.resolve(r.path) === root)
					),
					{
						provider: options.provider,
						path: root,
						userId: options.mine ? state.config.userId : null,
						authorship: options.mine ? 'human' : 'unknown',
						enabled: true,
					},
				];
			} else if (options.mine)
				config.roots = state.config.roots.map((r) =>
					r.enabled ? { ...r, userId: state.config.userId, authorship: 'human' } : r
				);
			request = { action: 'configure', config };
			break;
		}
		case 'disable':
			request = { action: 'configure', config: { enabled: false } };
			break;
		case 'status':
		case 'discover':
		case 'sources':
		case 'start':
		case 'pause':
		case 'resume':
		case 'retry':
		case 'export':
			request = { action };
			break;
		case 'list':
			request = { action: 'list', projectPath: options.project, includeHistory: options.history };
			break;
		case 'recall':
			if (options.history)
				throw new Error('--history is list-only; recall requires --intent history');
			if (options.at !== undefined && options.intent !== 'as-of')
				throw new Error('--at requires --intent as-of');
			request = {
				action: 'recall',
				query: {
					query: value,
					projectPath: options.project,
					qualify: options.qualify,
					rerank: options.rerank,
					intent:
						options.intent === undefined
							? undefined
							: validateMemoryRecallIntent(
									options.intent === 'as-of'
										? { mode: options.intent, at: options.at }
										: { mode: options.intent }
								),
				},
			};
			break;
		case 'remember':
			request = {
				action: 'remember',
				text: value,
				projectPath: options.project,
				kind: options.kind,
			};
			break;
		case 'correct':
			if (words.length < 2) throw new Error('correct requires memory ID and replacement text');
			request = {
				action: 'correct',
				id: words[0],
				text: words.slice(1).join(' '),
				projectPath: options.project,
			};
			break;
		case 'evidence':
		case 'forget':
			request = { action, id: value };
			break;
		case 'pin':
		case 'unpin':
			request = { action: 'pin', id: value, pinned: action === 'pin' };
			break;
		default:
			throw new Error('Unknown memory operation: ' + action);
	}
	const result = await requestPianolaMemory<unknown>(request);
	if (options.out) {
		await fs.writeFile(path.resolve(options.out), JSON.stringify(result, null, 2), 'utf8');
		console.log('Memory export written to ' + path.resolve(options.out));
	} else if (action === 'recall' && !options.json)
		console.log((result as MemoryPacket).context || 'No applicable memories found.');
	else console.log(JSON.stringify(result, null, options.json ? undefined : 2));
}
