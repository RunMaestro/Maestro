/**
 * @file local-models-user-models.test.ts
 *
 * Models the user adds from Hugging Face: what a repo id and file name may be,
 * how Hugging Face's description of a repo becomes a record, how a record
 * becomes a catalog entry, and how the stored file is read back. Both the
 * description and the stored file are untrusted text.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
	LOCAL_MODEL_CATALOG,
	QWEN3_1_7B_ID,
	allLocalModels,
	getLocalModel,
	isCuratedLocalModelId,
	isLocalModelId,
	localModelGgufFile,
	localModelsForRuntime,
	setUserLocalModels,
	userLocalModels,
} from '../../shared/local-models/model-catalog';
import { estimateKvBytesPer1kTokens, modelMemoryNeed } from '../../shared/local-models/model-fit';
import { MODEL_SERVER_AGENT_MIN_CONTEXT } from '../../shared/local-models/model-server';
import {
	USER_LOCAL_MODELS_VERSION,
	USER_MODEL_LICENSE_UNSTATED,
	huggingFaceModelApiUrl,
	huggingFaceModelRecord,
	parseHuggingFaceFileName,
	parseHuggingFaceRepoId,
	parseUserLocalModels,
	serializeUserLocalModels,
	userLocalModelEntry,
	userLocalModelId,
	type UserLocalModelRecord,
} from '../../shared/local-models/user-models';

const REPO = 'unsloth/Qwen3.5-2B-GGUF';
const FILE = 'Qwen3.5-2B-Q4_K_M.gguf';
const COMMIT = 'f6d5376be1edb4d416d56da11e5397a961aca8ae';
const SHA = 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223';

function sibling(rfilename: string, size: number, sha256: string | null = SHA) {
	return {
		rfilename,
		size,
		...(sha256 ? { lfs: { sha256, size, pointerSize: 135 } } : {}),
	};
}

/** Hugging Face's answer for a GGUF repo, as `?blobs=true` returns it. */
function repoInfo(over: Record<string, unknown> = {}) {
	return {
		id: REPO,
		sha: COMMIT,
		private: false,
		gated: false,
		tags: ['gguf', 'license:apache-2.0'],
		cardData: {
			license: 'apache-2.0',
			license_link: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE',
		},
		gguf: { total: 1_881_825_088, architecture: 'qwen35', context_length: 262_144 },
		siblings: [
			sibling('.gitattributes', 3060, null),
			sibling(FILE, 1_280_835_840),
			sibling('Qwen3.5-2B-Q8_0.gguf', 2_000_000_000, 'b'.repeat(64)),
			sibling('mmproj-F16.gguf', 600_000_000, 'c'.repeat(64)),
			sibling('README.md', 64_059, null),
		],
		...over,
	};
}

function record(over: Partial<UserLocalModelRecord> = {}): UserLocalModelRecord {
	const built = huggingFaceModelRecord(repoInfo(), REPO, FILE, 1_700_000_000_000);
	if (!built.ok) throw new Error(built.message);
	return { ...built.value, ...over };
}

afterEach(() => setUserLocalModels([]));

describe('what the user types', () => {
	it('accepts an owner/name repo id, bare or as its Hugging Face URL', () => {
		expect(parseHuggingFaceRepoId(` ${REPO} `)).toEqual({ ok: true, value: REPO });
		expect(parseHuggingFaceRepoId(`https://huggingface.co/${REPO}`)).toEqual({
			ok: true,
			value: REPO,
		});
	});

	it('refuses anything that is not one repo id', () => {
		for (const bad of [
			'',
			'qwen',
			'a/b/c',
			'../etc/passwd',
			'owner/..',
			'owner/na me',
			'owner/name?x=1',
			'https://evil.example/owner/name',
			42,
			null,
		]) {
			expect(parseHuggingFaceRepoId(bad).ok, String(bad)).toBe(false);
		}
	});

	it('accepts a GGUF file path inside the repo', () => {
		expect(parseHuggingFaceFileName(FILE)).toEqual({ ok: true, value: FILE });
		expect(parseHuggingFaceFileName('BF16/Model-BF16-00001-of-00004.gguf').ok).toBe(true);
	});

	it('refuses a path that escapes, a file that is not GGUF, and a vision projector', () => {
		for (const bad of ['', '/abs.gguf', '../x.gguf', 'a/../x.gguf', './x.gguf', 'x y.gguf', 7]) {
			expect(parseHuggingFaceFileName(bad).ok, String(bad)).toBe(false);
		}
		const notGguf = parseHuggingFaceFileName('model.safetensors');
		expect(notGguf).toEqual({ ok: false, message: expect.stringContaining('not a GGUF file') });
		const projector = parseHuggingFaceFileName('mmproj-F16.gguf');
		expect(projector).toEqual({ ok: false, message: expect.stringContaining('vision projector') });
	});

	it('gives a repo file a deterministic, filename-safe id', () => {
		expect(userLocalModelId(REPO, FILE)).toBe('hf-unsloth-qwen3.5-2b-q4_k_m');
		// A split part and its siblings are one model.
		expect(userLocalModelId('Org/X-GGUF', 'BF16/X-BF16-00002-of-00004.gguf')).toBe('hf-org-x-bf16');
		expect(userLocalModelId('a/b', `${'Long'.repeat(80)}.gguf`).length).toBeLessThanOrEqual(120);
		expect(userLocalModelId('a/b', 'We+ird  Name.gguf')).toMatch(/^hf-[a-z0-9._-]+$/);
	});

	it('asks the API for the commit, the files and their hashes in one call', () => {
		expect(huggingFaceModelApiUrl(REPO)).toBe(
			`https://huggingface.co/api/models/${REPO}?blobs=true`
		);
		expect(huggingFaceModelApiUrl(REPO, 'https://mirror.example/')).toBe(
			`https://mirror.example/api/models/${REPO}?blobs=true`
		);
	});
});

describe('a record from Hugging Face', () => {
	it('pins the commit and records the hash and size Hugging Face reports', () => {
		expect(record()).toEqual({
			id: 'hf-unsloth-qwen3.5-2b-q4_k_m',
			displayName: 'Qwen3.5-2B-Q4_K_M',
			repo: REPO,
			revision: COMMIT,
			license: {
				spdx: 'apache-2.0',
				url: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE',
			},
			files: [{ path: FILE, sha256: SHA, bytes: 1_280_835_840 }],
			parametersB: 1.88,
			contextLength: 262_144,
			addedAt: 1_700_000_000_000,
		});
	});

	it('reads the license from the card, its other-license name, or a tag, and says when none is stated', () => {
		const license = (over: Record<string, unknown>) => {
			const built = huggingFaceModelRecord(repoInfo(over), REPO, FILE, 0);
			if (!built.ok) throw new Error(built.message);
			return built.value.license;
		};
		expect(
			license({ cardData: { license: 'other', license_name: 'nvidia-open-model-license' } })
		).toEqual({ spdx: 'nvidia-open-model-license', url: `https://huggingface.co/${REPO}` });
		expect(license({ cardData: {}, tags: ['license:mit'] }).spdx).toBe('mit');
		expect(license({ cardData: undefined, tags: [] })).toEqual({
			spdx: USER_MODEL_LICENSE_UNSTATED,
			url: `https://huggingface.co/${REPO}`,
		});
		// A link that is not https is not a link Maestro will render.
		expect(license({ cardData: { license: 'mit', license_link: 'javascript:alert(1)' } }).url).toBe(
			`https://huggingface.co/${REPO}`
		);
		// The name reaches a terminal: control characters and escapes are dropped.
		expect(license({ cardData: { license: 'mit\u001b[31m\nred' } }).spdx).toBe('mit[31mred');
	});

	it('adds every part of a split GGUF, in order, whichever part was named', () => {
		const parts = [1, 2, 3].map((index) =>
			sibling(`BF16/M-BF16-0000${index}-of-00003.gguf`, 1000 * index, String(index).repeat(64))
		);
		const info = repoInfo({ siblings: [parts[2], parts[0], parts[1]] });
		const built = huggingFaceModelRecord(info, REPO, 'BF16/M-BF16-00002-of-00003.gguf', 0);
		expect(built.ok && built.value.files.map((file) => file.path)).toEqual(
			parts.map((part) => part.rfilename)
		);
		expect(built.ok && built.value.displayName).toBe('M-BF16');

		const missing = huggingFaceModelRecord(
			repoInfo({ siblings: [parts[0], parts[2]] }),
			REPO,
			parts[0].rfilename,
			0
		);
		expect(missing).toEqual({ ok: false, message: expect.stringContaining('missing part 2') });
	});

	it('names the GGUF files a repo does have when the file is not one of them', () => {
		const built = huggingFaceModelRecord(repoInfo(), REPO, 'Nope.gguf', 0);
		expect(built.ok).toBe(false);
		const message = built.ok ? '' : built.message;
		expect(message).toContain('no file named Nope.gguf');
		expect(message).toContain(FILE);
		expect(message).toContain('Qwen3.5-2B-Q8_0.gguf');
		// A projector is not offered as a model.
		expect(message).not.toContain('mmproj');
	});

	it('refuses, by name, what it could not download or check', () => {
		const refusal = (over: Record<string, unknown>) => {
			const built = huggingFaceModelRecord(repoInfo(over), REPO, FILE, 0);
			return built.ok ? null : built.message;
		};
		expect(refusal({ gated: 'manual' })).toContain('gated');
		expect(refusal({ private: true })).toContain('gated');
		expect(refusal({ sha: 'main' })).toContain('no commit');
		expect(refusal({ siblings: [sibling(FILE, 1000, null)] })).toContain('no SHA-256');
		expect(refusal({ siblings: [sibling(FILE, 1000, 'not-a-hash')] })).toContain('no SHA-256');
		expect(refusal({ gguf: undefined })).toContain('no GGUF metadata');
		expect(refusal({ siblings: [sibling('README.md', 10, null)] })).toContain('no GGUF file');
		expect(huggingFaceModelRecord('nope', REPO, FILE, 0).ok).toBe(false);
	});

	it('guesses the size from the file when the parameter count is missing', () => {
		const built = huggingFaceModelRecord(
			repoInfo({ gguf: { context_length: 8192 } }),
			REPO,
			FILE,
			0
		);
		// 1.28 GB at 4.85 bits per weight is about 2.1B parameters.
		expect(built.ok && built.value.parametersB).toBeCloseTo(2.11, 1);
	});
});

describe('a user entry', () => {
	it("is a text model with no measured role, marked as the user's own", () => {
		const entry = userLocalModelEntry(record());
		expect(entry).toMatchObject({
			id: 'hf-unsloth-qwen3.5-2b-q4_k_m',
			kind: 'text-gen',
			runtime: 'llama',
			userAdded: true,
			roles: [],
			source: { repo: REPO, revision: COMMIT },
			parameters: { totalB: 1.88, activeB: 1.88 },
			contextLength: 262_144,
			defaultContext: MODEL_SERVER_AGENT_MIN_CONTEXT,
			bytes: 1_280_835_840,
		});
		expect(entry.agentHarnesses).toBeUndefined();
		expect(entry.files[0].sourceUrl).toBe(
			`https://huggingface.co/${REPO}/resolve/${COMMIT}/${FILE}`
		);
		expect(localModelGgufFile(entry)?.path).toBe(FILE);
		expect(Object.isFrozen(entry)).toBe(true);
		// A curated entry carries no such mark.
		expect(getLocalModel(QWEN3_1_7B_ID)!.userAdded).toBeUndefined();
	});

	it('sizes its context from the typical shape for its size, and says it is an estimate', () => {
		const entry = userLocalModelEntry(record());
		expect(entry.memoryHint).toMatchObject({
			estimated: true,
			kvBytesPer1kTokens: estimateKvBytesPer1kTokens(1.88),
		});
		expect(modelMemoryNeed(entry).kvEstimated).toBe(true);
		expect(modelMemoryNeed(getLocalModel(QWEN3_1_7B_ID)!).kvEstimated).toBe(false);
	});

	it('never runs past the context the model was trained for', () => {
		expect(userLocalModelEntry(record({ contextLength: 8192 })).defaultContext).toBe(8192);
	});
});

describe('the stored file', () => {
	it('round-trips what Maestro wrote', () => {
		const stored = serializeUserLocalModels([record()]);
		expect(stored.version).toBe(USER_LOCAL_MODELS_VERSION);
		const parsed = parseUserLocalModels(JSON.parse(JSON.stringify(stored)));
		expect(parsed.dropped).toBe(0);
		expect(parsed.records).toEqual([record()]);
		expect(parsed.entries.map((entry) => entry.id)).toEqual(['hf-unsloth-qwen3.5-2b-q4_k_m']);
	});

	it('reads nothing from a file that is not the expected shape', () => {
		for (const raw of [null, 7, 'x', [], {}, { models: 'no' }]) {
			expect(parseUserLocalModels(raw)).toEqual({ records: [], entries: [], dropped: 0 });
		}
	});

	it('drops a record that fails any check, and keeps the good ones', () => {
		const good = record();
		const bad: unknown[] = [
			null,
			{ ...good, id: '../../etc' },
			{ ...good, id: 'no-prefix' },
			{ ...good, id: QWEN3_1_7B_ID },
			{ ...good, repo: 'not a repo' },
			{ ...good, revision: 'main' },
			{ ...good, license: { spdx: 'mit', url: 'javascript:alert(1)' } },
			{ ...good, license: { spdx: '', url: 'https://example.com' } },
			{ ...good, files: [] },
			{ ...good, files: [{ path: '../x.gguf', sha256: SHA, bytes: 10 }] },
			{ ...good, files: [{ path: FILE, sha256: 'short', bytes: 10 }] },
			{ ...good, files: [{ path: FILE, sha256: SHA, bytes: -1 }] },
			{ ...good, files: [{ path: FILE, sha256: SHA, bytes: 1.5 }] },
			{ ...good, parametersB: 0 },
			{ ...good, contextLength: 0 },
			{ ...good, displayName: '' },
			// One part of a split set alone would verify clean and never load.
			{ ...good, files: [{ path: 'M-00001-of-00002.gguf', sha256: SHA, bytes: 10 }] },
			// The same id twice: the first one wins.
			good,
		];
		const parsed = parseUserLocalModels({ version: 1, models: [good, ...bad] });
		expect(parsed.records).toEqual([good]);
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.dropped).toBe(bad.length);
	});
});

describe('the catalog a process holds', () => {
	it("lists curated models first, then the user's, and finds both by id", () => {
		const entry = userLocalModelEntry(record());
		expect(allLocalModels()).toBe(LOCAL_MODEL_CATALOG);
		expect(getLocalModel(entry.id)).toBeUndefined();

		setUserLocalModels([entry]);
		expect(userLocalModels()).toEqual([entry]);
		expect(allLocalModels()).toEqual([...LOCAL_MODEL_CATALOG, entry]);
		expect(getLocalModel(entry.id)).toBe(entry);
		expect(isLocalModelId(entry.id)).toBe(true);
		expect(isCuratedLocalModelId(entry.id)).toBe(false);
		expect(isCuratedLocalModelId(QWEN3_1_7B_ID)).toBe(true);
		expect(localModelsForRuntime('llama')).toContain(entry);
		// The curated table itself never grows.
		expect(LOCAL_MODEL_CATALOG).not.toContain(entry);

		setUserLocalModels([]);
		expect(getLocalModel(entry.id)).toBeUndefined();
		expect(allLocalModels()).toBe(LOCAL_MODEL_CATALOG);
	});

	it('never lets a user entry shadow a curated model, repeat, or pass as one', () => {
		const entry = userLocalModelEntry(record());
		const curated = getLocalModel(QWEN3_1_7B_ID)!;
		setUserLocalModels([
			entry,
			entry,
			// A curated entry handed in as if the user had added it.
			curated,
			// A user entry wearing a curated id.
			{ ...entry, id: QWEN3_1_7B_ID },
		]);
		expect(userLocalModels()).toEqual([entry]);
		expect(getLocalModel(QWEN3_1_7B_ID)).toBe(curated);
	});
});
