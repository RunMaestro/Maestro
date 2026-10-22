/**
 * Pieces the chain of thought export tests share.
 *
 * A test of this feature reads back what a person opening the log folder
 * would see, so the reader lives here once and every suite reads the same way.
 */

import * as fs from 'fs';
import { listTurnFiles } from '../../../main/cot-export/layout';
import type { CotRecord } from '../../../shared/cotExport/types';

/** Every turn file under `folder`, oldest first, each as its records. */
export async function readTurnFiles(folder: string): Promise<CotRecord[][]> {
	const files = (await listTurnFiles(folder)).reverse();
	return files.map((file) =>
		fs
			.readFileSync(file, 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => JSON.parse(line) as CotRecord)
	);
}
