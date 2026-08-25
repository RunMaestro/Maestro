/**
 * Kilo Session Storage
 *
 * Kilo (KiloCode) is a fork of OpenCode: same session/message/part layout, same
 * SQLite schema, same remote paths. Only the data directory and the database
 * file are renamed, so this subclass supplies the brand and inherits the rest.
 *
 * @see https://github.com/Kilo-Org/kilocode
 */

import type { ToolType } from '../../shared/types';
import { OpenCodeSessionStorage, type OpenCodeStorageBrand } from './opencode-session-storage';

const KILO_BRAND: OpenCodeStorageBrand = {
	dirName: 'kilo',
	dbFileName: 'kilo.db',
};

export class KiloSessionStorage extends OpenCodeSessionStorage {
	readonly agentId: ToolType = 'kilo';

	protected get brand(): OpenCodeStorageBrand {
		return KILO_BRAND;
	}
}
