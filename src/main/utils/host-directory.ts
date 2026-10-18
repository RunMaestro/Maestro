import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/** Paths and parent navigation are resolved on the host, never in client OS syntax. */
export async function getHostDirectoryInfo(input?: string): Promise<{
	path: string;
	parent: string | null;
	roots: string[];
}> {
	const requested = input ?? os.homedir();
	if (typeof requested !== 'string' || requested.includes('\0') || !path.isAbsolute(requested)) {
		throw new Error('Choose an absolute directory path on the host');
	}
	const directory = await fs.realpath(requested);
	if (!(await fs.stat(directory)).isDirectory())
		throw new Error('The host path is not a directory');
	const parent = path.dirname(directory);
	const roots =
		process.platform === 'win32'
			? (
					await Promise.all(
						Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`).map(
							async (root) => {
								try {
									await fs.access(root);
									return root;
								} catch {
									return null;
								}
							}
						)
					)
				).filter((root): root is string => root !== null)
			: ['/'];
	return { path: directory, parent: parent === directory ? null : parent, roots };
}
