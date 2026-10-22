import { canonicalJson } from '../../canonicalJson';
import { extractNativeConversation } from './native-records';
import { translationArtifact } from './identity';
import type { TranslationRpc, TranslationIdentity, PortableConversation } from './types';

export interface ScopedCodexImportItem {
	cwd: string;
	description: string;
	itemType: 'MEMORY' | 'SESSIONS' | 'SKILLS' | 'SUBAGENTS';
	details: {
		memory?: string[];
		sessions?: Array<{ cwd: string; path: string; title?: string }>;
		skills?: Array<{ name: string }>;
		subagents?: Array<{ name: string }>;
	};
}
export interface CodexImportCompletion {
	importId: string;
	itemTypeResults: Array<{
		itemType: string;
		successes: Array<{ source?: string; target?: string }>;
		failures: unknown[];
	}>;
}

/** The host must approve exact targets first; no config, hooks, credentials or home-wide item. */
export async function importSelectedCodexResources(
	rpc: TranslationRpc,
	projectRoot: string,
	items: ScopedCodexImportItem[]
): Promise<CodexImportCompletion> {
	if (!items.length) throw new Error('Empty native import selection');
	for (const item of items) {
		if (
			!projectRoot ||
			item.cwd !== projectRoot ||
			!['MEMORY', 'SESSIONS', 'SKILLS', 'SUBAGENTS'].includes(item.itemType)
		)
			throw new Error('Unsafe broad Codex import');
		const details = item.details;
		const selected =
			item.itemType === 'MEMORY'
				? details.memory
				: item.itemType === 'SESSIONS'
					? details.sessions
					: item.itemType === 'SKILLS'
						? details.skills
						: details.subagents;
		if (!selected?.length || details.sessions?.some((s) => s.cwd !== projectRoot))
			throw new Error('Native import requires explicit project selections');
	}
	const completions = new Map<string, CodexImportCompletion>();
	let expectedId: string | undefined;
	let resolveCompletion!: (completion: CodexImportCompletion) => void;
	let rejectCompletion!: (error: Error) => void;
	const completed = new Promise<CodexImportCompletion>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});
	const unsubscribe = rpc.onNotification((method, params) => {
		if (method !== 'externalAgentConfig/import/completed') return;
		const completion = params as CodexImportCompletion;
		if (!completion || typeof completion.importId !== 'string') return;
		completions.set(completion.importId, completion);
		if (completion.importId === expectedId) resolveCompletion(completion);
	});
	const timer = setTimeout(
		() =>
			rejectCompletion(
				new Error('Native import completion missing; inspect import history before retrying')
			),
		30000
	);
	// Attach a rejection handler before awaiting the request, which may outlive the timer.
	void completed.catch(() => {});
	try {
		const response = await rpc.request<{ importId: string }>('externalAgentConfig/import', {
			migrationItems: items,
			migrationSource: 'claude-code',
			providerId: 'maestro',
			source: 'maestro',
		});
		if (!response?.importId) throw new Error('Native importer did not return an identity');
		expectedId = response.importId;
		const early = completions.get(expectedId);
		if (early) resolveCompletion(early);
		const completion = await completed;
		if (
			!Array.isArray(completion.itemTypeResults) ||
			completion.itemTypeResults.some((r) => r.failures.length)
		)
			throw new Error(`Native import ${expectedId} has per-artifact failures`);
		return completion;
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}

/** Paginated provider-supported read. No active SQLite database copying. */
export async function readCodexThreadItems(
	rpc: TranslationRpc,
	threadId: string
): Promise<unknown[]> {
	const items: unknown[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await rpc.request<{ data: unknown[]; nextCursor?: string | null }>(
			'thread/items/list',
			{ threadId, cursor, sortDirection: 'asc', limit: 100 }
		);
		if (!Array.isArray(page.data)) throw new Error('Invalid paginated Codex history');
		items.push(...page.data);
		cursor = page.nextCursor ?? undefined;
		if (cursor && seen.has(cursor)) throw new Error('Codex pagination cursor repeated');
		if (cursor) seen.add(cursor);
	} while (cursor);
	return items;
}

/** Current SQLite-backed projection reads are not a substitute for missing native reasoning evidence. */
export function extractCodexItemHistory(
	identity: TranslationIdentity,
	tabId: string,
	sessionId: string,
	entries: unknown[],
	nativeBytes?: Buffer
): PortableConversation {
	const bytes = Buffer.from(canonicalJson(entries));
	const base = nativeBytes
		? extractNativeConversation(identity, tabId, sessionId, nativeBytes)
		: ({
				tabId,
				nativeSessionId: sessionId,
				identity,
				records: [],
				artifacts: [],
				limitations: [],
			} as PortableConversation);
	base.artifacts.push(
		translationArtifact(
			'transcript',
			`codex:thread/items/list:${sessionId}`,
			'paginated-items.json',
			bytes
		)
	);
	if (!nativeBytes)
		base.limitations.push({
			code: 'missing-native-rollout',
			severity: 'block',
			tabId,
			message:
				'Paginated ThreadItem entries preserve the provider projection, but do not include complete raw Responses/tool linkage or opaque native reasoning. Obtain a consistent native rollout before conversion.',
		});
	return base;
}
