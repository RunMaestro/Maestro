// Image files named on the command line, read into the data URLs Maestro takes.
//
// Every verb that attaches an image (`feedback --attach`, `quick-chat send
// --image`) checks the same things before anything is sent: the path exists,
// it is a kind of image an agent and the UI can show, and it is not too big.

import * as fs from 'fs';
import * as path from 'path';
import { resolveCliPath } from './parse';
import { getImageMimeType } from '../../shared/gitUtils';
import { formatSize } from '../../shared/formatters';

/** Image types a composer accepts: what a paste into the chat can carry. */
const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export interface CliImageFile {
	name: string;
	dataUrl: string;
}

/**
 * Read one image file the user named. Throws a message that names the file,
 * so a bad one fails before anything is sent rather than halfway through.
 */
export function readCliImageFile(input: string, maxBytes: number): CliImageFile {
	const filePath = resolveCliPath(input);
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (!IMAGE_FILE_EXTENSIONS.has(ext)) {
		throw new Error(`${input}: images must be PNG, JPG, GIF, or WebP.`);
	}
	let size: number;
	try {
		size = fs.statSync(filePath).size;
	} catch {
		throw new Error(`${input}: file not found.`);
	}
	if (size > maxBytes) {
		throw new Error(`${input}: ${formatSize(size)} exceeds the ${formatSize(maxBytes)} limit.`);
	}
	const base64 = fs.readFileSync(filePath).toString('base64');
	return {
		name: path.basename(filePath),
		dataUrl: `data:${getImageMimeType(ext)};base64,${base64}`,
	};
}
