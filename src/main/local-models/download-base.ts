/**
 * The download base in force, read from settings at the moment a request is
 * made, so a change in Settings or from `maestro-cli models config set` applies
 * to the next transfer without a restart. See
 * `src/shared/local-models/download-base.ts` for the rules.
 */

import {
	LOCAL_MODELS_DOWNLOAD_BASE_SETTING,
	resolveDownloadBase,
} from '../../shared/local-models/download-base';
import { getSettingsStore } from '../stores/getters';

/** The base URL model files and Hugging Face metadata are requested from. */
export function currentDownloadBase(): string {
	return resolveDownloadBase(getSettingsStore().get(LOCAL_MODELS_DOWNLOAD_BASE_SETTING));
}
