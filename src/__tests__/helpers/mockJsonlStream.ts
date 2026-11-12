import { vi } from 'vitest';

type FsPromises = typeof import('fs/promises');

/**
 * The suite's `fs/promises` mock, imported once. Two reads that start in the
 * same tick (a storage parsing several transcripts with `Promise.all`) must not
 * each race a dynamic import: the second one can resolve to the REAL module and
 * read the real disk.
 */
let fsPromisesModule: Promise<FsPromises & { default?: FsPromises }> | null = null;

/** The non-blank lines of a stubbed `readFile`, as the real stream yields them. */
async function nonBlankLines(filePath: string): Promise<string[]> {
	// Suites mock fs/promises with a default export, named exports, or both.
	fsPromisesModule ??= import('fs/promises') as Promise<FsPromises & { default?: FsPromises }>;
	const fsModule = await fsPromisesModule;
	const fs = fsModule.default ?? fsModule;
	const content = String(await fs.readFile(filePath, 'utf-8'));
	return content.split('\n').filter((line) => line.trim());
}

/**
 * A `forEachJsonlLine` stand-in fed by a mocked `fs/promises.readFile`.
 *
 * Session storages stream transcripts instead of reading them whole (#1862).
 * Suites that already stub `readFile` with a transcript string keep doing so:
 *
 *   vi.mock('../../../main/utils/jsonl-stream', async () =>
 *     (await import('../../helpers/mockJsonlStream')).jsonlStreamFromReadFileMock()
 *   );
 *
 * The stub's content is handed over line by line with blank lines skipped, as
 * the real stream does. The streaming itself is covered against real files in
 * `main/utils/jsonl-stream.test.ts`. `readFirstJsonlLine` is a `vi.fn` so a
 * suite can assert on the header lookups or answer them itself.
 */
export function jsonlStreamFromReadFileMock() {
	return {
		forEachJsonlLine: async (filePath: string, onLine: (line: string) => void): Promise<void> => {
			for (const line of await nonBlankLines(filePath)) onLine(line);
		},
		readFirstJsonlLine: vi.fn(
			async (filePath: string): Promise<string | null> => (await nonBlankLines(filePath))[0] ?? null
		),
	};
}
