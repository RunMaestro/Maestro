/**
 * The query worker's side of `query-worker-protocol.ts`: a mirror of one root's `VaultIndex`, kept in step
 * by the runner's updates, and the DQL it runs against that mirror. The mirror is a `PageIndex`, finished
 * from the same cached raw parse with the same link resolution as `VaultIndex.commit`, so a query answers
 * here exactly as it would in main.
 *
 * Kept apart from the worker entry so tests can drive it in-process. Nothing here, or reachable from here,
 * may import `electron`.
 */

import {
	PageIndex,
	Transferable,
	VaultPaths,
	executeDql,
	executeInlineDql,
	finishPage,
	type DataviewInlineResult,
	type DataviewResult,
} from '../../shared/dataview';
import type {
	QueryMirrorPage,
	QueryWorkerQuery,
	QueryWorkerRequest,
	QueryWorkerResponse,
} from './query-worker-protocol';

/** The worker's copy of a root's index. Changes only through {@link applyBegin}, {@link applyPages}, {@link applyEnd}. */
export class QueryMirrorIndex extends PageIndex {
	applyBegin(request: Extract<QueryWorkerRequest, { type: 'begin' }>): void {
		for (const path of request.removed) this.unindexPage(path);
		if (request.paths) {
			this.prefix = new VaultPaths(request.paths.files, request.paths.folders);
			// Rebuilt lazily from the new file set, as `VaultIndex` resolves an update's pages.
			this.resolver = null;
		}
		this.stars = new Set(request.stars);
		this.revision = request.revision;
	}

	applyPages(pages: QueryMirrorPage[]): void {
		const resolver = this.linkResolver();
		for (const { path, data } of pages) {
			// `finishPage` mutates its input; `Transferable.value` decodes a fresh copy.
			this.indexPage(path, finishPage(Transferable.value(data), resolver));
		}
	}

	applyEnd(): void {
		this.resolvedLinks = null;
		// Main drops its CSV cache on a change; a fresh read here keeps the two from disagreeing.
		this.csvCache.clear();
	}
}

/**
 * Handle one request from the runner. `post` sends a response back. Updates apply synchronously; a query
 * answers when it finishes, after any `read` it needed.
 */
export function createQueryWorkerHost(
	post: (response: QueryWorkerResponse) => void
): (request: QueryWorkerRequest) => void {
	let nextReadId = 1;
	const reads = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();
	const readText = (path: string): Promise<string> =>
		new Promise<string>((resolve, reject) => {
			const id = nextReadId++;
			reads.set(id, { resolve, reject });
			post({ type: 'read', id, path });
		});
	let index = new QueryMirrorIndex(readText);
	let seq = -1;

	const run = (query: QueryWorkerQuery): Promise<DataviewResult | DataviewInlineResult> =>
		query.kind === 'dql'
			? executeDql(query.source, query.thisPath, index)
			: Promise.resolve(executeInlineDql(query.expression, query.thisPath, index));

	return (request) => {
		switch (request.type) {
			case 'begin':
				if (request.reset) index = new QueryMirrorIndex(readText);
				index.applyBegin(request);
				seq = request.seq;
				return;
			case 'pages':
				index.applyPages(request.pages);
				return;
			case 'end':
				index.applyEnd();
				post({ type: 'applied', seq });
				return;
			case 'query':
				// `executeDql` and `executeInlineDql` turn every failure into an error result.
				void run(request.query).then((result) => post({ type: 'result', id: request.id, result }));
				return;
			case 'readResult': {
				const pending = reads.get(request.id);
				if (!pending) return;
				reads.delete(request.id);
				if ('error' in request) pending.reject(new Error(request.error));
				else pending.resolve(request.text);
				return;
			}
		}
	};
}
