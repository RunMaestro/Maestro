/**
 * @file local-models-download-base.test.ts
 *
 * The mirror setting's rules: what a download base may be, how a stored value
 * reads, and how a catalog URL is re-hosted. The same functions validate the
 * Settings field, the CLI verb and the main-process read, so a value one of them
 * accepts is a value the others honour.
 */

import { describe, expect, it } from 'vitest';

import {
	DEFAULT_DOWNLOAD_BASE,
	downloadBaseProblem,
	downloadSourceName,
	isMirrorDownloadBase,
	normalizeDownloadBase,
	rebaseSourceUrl,
	resolveDownloadBase,
} from '../../shared/local-models/download-base';
import {
	LOCAL_MODEL_CATALOG,
	HUGGING_FACE_BASE_URL,
} from '../../shared/local-models/model-catalog';

const FILE_URL =
	'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/0123456789abcdef0123456789abcdef01234567/Qwen3.5-4B-Q4_K_M.gguf';

describe('downloadBaseProblem', () => {
	it('accepts an empty value and the word default, which both mean Hugging Face', () => {
		expect(downloadBaseProblem('')).toBeNull();
		expect(downloadBaseProblem('   ')).toBeNull();
		expect(downloadBaseProblem('default')).toBeNull();
		expect(downloadBaseProblem('DEFAULT')).toBeNull();
	});

	it('accepts http and https hosts, with or without a path', () => {
		expect(downloadBaseProblem('https://hf-mirror.com')).toBeNull();
		expect(downloadBaseProblem('http://10.0.0.5:8080/hf')).toBeNull();
		expect(downloadBaseProblem('  https://mirror.example/models/  ')).toBeNull();
	});

	it('refuses what is not a base URL, by name', () => {
		expect(downloadBaseProblem('not a url')).toContain('not a valid URL');
		expect(downloadBaseProblem('ftp://mirror.example')).toContain('http and https');
		expect(downloadBaseProblem('https://mirror.example?token=1')).toContain(
			'query string or fragment'
		);
		expect(downloadBaseProblem('https://mirror.example/#x')).toContain('query string or fragment');
	});

	it('refuses credentials in the URL, which would be written to settings in the clear', () => {
		expect(downloadBaseProblem('https://user:secret@mirror.example')).toBe(
			'Do not put credentials in the URL.'
		);
		expect(downloadBaseProblem('https://token@mirror.example')).toBe(
			'Do not put credentials in the URL.'
		);
	});

	it('words a rejection for the download base, not an endpoint', () => {
		expect(downloadBaseProblem('https://')).not.toContain('Base URL');
	});
});

describe('normalizeDownloadBase and resolveDownloadBase', () => {
	it('drops the trailing slash and keeps the path', () => {
		expect(normalizeDownloadBase('https://hf-mirror.com/')).toBe('https://hf-mirror.com');
		expect(normalizeDownloadBase(' http://10.0.0.5:8080/hf// ')).toBe('http://10.0.0.5:8080/hf');
	});

	it('spells empty and default as the default base', () => {
		expect(normalizeDownloadBase('')).toBe(DEFAULT_DOWNLOAD_BASE);
		expect(normalizeDownloadBase('default')).toBe(DEFAULT_DOWNLOAD_BASE);
	});

	it('reads a stored value that fails validation as the default', () => {
		expect(resolveDownloadBase(undefined)).toBe(DEFAULT_DOWNLOAD_BASE);
		expect(resolveDownloadBase(42)).toBe(DEFAULT_DOWNLOAD_BASE);
		expect(resolveDownloadBase('ftp://x')).toBe(DEFAULT_DOWNLOAD_BASE);
		expect(resolveDownloadBase('https://u:p@x.example')).toBe(DEFAULT_DOWNLOAD_BASE);
		expect(resolveDownloadBase('https://hf-mirror.com/')).toBe('https://hf-mirror.com');
	});

	it('defaults to the host the catalog is pinned to', () => {
		expect(DEFAULT_DOWNLOAD_BASE).toBe(HUGGING_FACE_BASE_URL);
	});
});

describe('rebaseSourceUrl', () => {
	it('swaps only the host and leaves the pinned path alone', () => {
		expect(rebaseSourceUrl(FILE_URL, 'https://hf-mirror.com')).toBe(
			'https://hf-mirror.com/unsloth/Qwen3.5-4B-GGUF/resolve/0123456789abcdef0123456789abcdef01234567/Qwen3.5-4B-Q4_K_M.gguf'
		);
		expect(rebaseSourceUrl(FILE_URL, 'http://10.0.0.5:8080/hf')).toBe(
			'http://10.0.0.5:8080/hf/unsloth/Qwen3.5-4B-GGUF/resolve/0123456789abcdef0123456789abcdef01234567/Qwen3.5-4B-Q4_K_M.gguf'
		);
	});

	it('returns the catalog URL for the default base and for an unusable one', () => {
		expect(rebaseSourceUrl(FILE_URL, DEFAULT_DOWNLOAD_BASE)).toBe(FILE_URL);
		expect(rebaseSourceUrl(FILE_URL, 'ftp://nope')).toBe(FILE_URL);
	});

	it('leaves a URL that is not under the catalog base unchanged', () => {
		expect(rebaseSourceUrl('https://example.invalid/tiny.bin', 'https://hf-mirror.com')).toBe(
			'https://example.invalid/tiny.bin'
		);
	});

	it('re-hosts every file of every curated model without touching the revision or path', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			for (const file of entry.files) {
				const rebased = rebaseSourceUrl(file.sourceUrl, 'https://mirror.example/hf');
				expect(rebased.startsWith('https://mirror.example/hf/')).toBe(true);
				expect(rebased.slice('https://mirror.example/hf'.length)).toBe(
					file.sourceUrl.slice(DEFAULT_DOWNLOAD_BASE.length)
				);
			}
		}
	});
});

describe('isMirrorDownloadBase and downloadSourceName', () => {
	it('names Hugging Face for the default and the host for a mirror', () => {
		expect(isMirrorDownloadBase(DEFAULT_DOWNLOAD_BASE)).toBe(false);
		expect(isMirrorDownloadBase('default')).toBe(false);
		expect(isMirrorDownloadBase('https://hf-mirror.com')).toBe(true);
		expect(downloadSourceName(DEFAULT_DOWNLOAD_BASE)).toBe('Hugging Face');
		expect(downloadSourceName('https://hf-mirror.com/')).toBe('hf-mirror.com');
		expect(downloadSourceName('http://10.0.0.5:8080/hf')).toBe('10.0.0.5:8080');
	});
});
