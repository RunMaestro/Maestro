import * as fs from 'fs';
import * as path from 'path';
const commentJson = require('comment-json');
import { atomicWriteFile } from '../../utils/atomic-json-store';

/**
 * Persistence boundary for installer-owned changes to comment-json config files.
 *
 * Installers retain ownership of their config path and the keys they mutate. This
 * store only preserves the user file's comment-aware structure and delegates
 * replacement to the established atomic writer, so a failed replacement cannot
 * truncate existing user bytes.
 */
export function createCommentJsonConfigStore(
	getConfigPath: () => string,
	writeAtomically: (filePath: string, contents: string) => Promise<void> = atomicWriteFile
) {
	async function readConfig(): Promise<unknown> {
		try {
			const raw = await fs.promises.readFile(getConfigPath(), 'utf8');
			return commentJson.parse(raw);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return commentJson.parse('{}');
			}
			throw err;
		}
	}

	async function writeConfig(config: unknown): Promise<void> {
		const configPath = getConfigPath();
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		await writeAtomically(configPath, commentJson.stringify(config, null, 2) + '\n');
	}

	return { readConfig, writeConfig };
}
