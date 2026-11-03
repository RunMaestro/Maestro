import type { MemoryRerankConfig } from '../../shared/pianola/memory';
import type { MemoryCandidate } from './memory-candidates';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
const TIMEOUT_MS = 30_000;

const LOOPBACK: Record<string, true> = {
	'127.0.0.1': true,
	localhost: true,
	'[::1]': true,
	'::1': true,
};

export const DEFAULT_RERANK: MemoryRerankConfig = {
	provider: 'hosted',
	model: 'rerank',
	endpoint: 'https://api.nan.builders',
	apiKeyEnv: 'NAN_API_KEY',
};

export class MemoryRerankError extends Error {
	readonly cause: unknown;
	constructor(message: string, options?: { cause?: unknown }) {
		super('Memory rerank capability: ' + message);
		this.cause = options?.cause;
		this.name = 'MemoryRerankError';
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveRerank(config: MemoryRerankConfig | undefined): MemoryRerankConfig {
	const resolved = config ?? DEFAULT_RERANK;
	if (resolved.provider !== 'hosted')
		throw new MemoryRerankError('only hosted rerank is supported');
	if (typeof resolved.model !== 'string' || !resolved.model.trim())
		throw new MemoryRerankError('model is required');
	if (typeof resolved.endpoint !== 'string') throw new MemoryRerankError('endpoint is required');
	let endpoint: URL;
	try {
		endpoint = new URL(resolved.endpoint);
	} catch {
		throw new MemoryRerankError('endpoint is not a valid URL');
	}
	if (
		endpoint.protocol !== 'https:' &&
		!(endpoint.protocol === 'http:' && LOOPBACK[endpoint.hostname])
	)
		throw new MemoryRerankError('remote endpoints require HTTPS');
	if (resolved.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resolved.apiKeyEnv))
		throw new MemoryRerankError('invalid credential environment variable');
	return { ...resolved, endpoint: endpoint.origin };
}

/** A hosted cross-encoder orders an existing shortlist; it never adds or admits candidates. */
export class MemoryReranker {
	private config = DEFAULT_RERANK;
	constructor(private readonly request: typeof fetchWithTimeout = fetchWithTimeout) {}
	configure(config: MemoryRerankConfig | undefined): void {
		this.config = resolveRerank(config);
	}

	get model(): string {
		return this.config.model;
	}

	private credential(): string {
		const primary = this.config.apiKeyEnv ?? 'NAN_API_KEY';
		const key =
			process.env[primary] ??
			(primary === 'NAN_API_KEY' ? process.env.NAN_BUILDERS_API_KEY : undefined);
		if (!key) throw new MemoryRerankError(primary + ' is required');
		return key;
	}

	async assertAvailable(): Promise<void> {
		this.credential();
	}

	async score(query: string, candidates: readonly MemoryCandidate[]): Promise<number[]> {
		await this.assertAvailable();
		if (!candidates.length) return [];
		let response: Response;
		try {
			response = await this.request(
				this.config.endpoint + '/v1/rerank',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: 'Bearer ' + this.credential(),
					},
					body: JSON.stringify({
						model: this.config.model,
						query,
						documents: candidates.map((candidate) => candidate.memory.text),
					}),
				},
				TIMEOUT_MS
			);
		} catch (error) {
			throw new MemoryRerankError('unavailable hosted response', { cause: error });
		}
		if (!response.ok) throw new MemoryRerankError('hosted HTTP ' + response.status);
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			throw new MemoryRerankError('invalid hosted JSON', { cause: error });
		}
		if (!record(body) || !Array.isArray(body.results) || body.results.length !== candidates.length)
			throw new MemoryRerankError('incomplete result coverage');
		const scores: number[] = [];
		for (const row of body.results) {
			if (
				!record(row) ||
				typeof row.index !== 'number' ||
				!Number.isInteger(row.index) ||
				(row.index as number) < 0 ||
				(row.index as number) >= candidates.length ||
				scores[row.index as number] !== undefined ||
				typeof row.relevance_score !== 'number' ||
				!Number.isFinite(row.relevance_score)
			)
				throw new MemoryRerankError('invalid or duplicate result');
			scores[row.index as number] = row.relevance_score;
		}
		return scores;
	}
}
