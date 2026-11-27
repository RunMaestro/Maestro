/**
 * Keeps this window's local model catalog in step with the models the user
 * added from Hugging Face.
 *
 * The catalog is a module each process holds its own copy of. The curated part
 * is compiled in; the user's part lives in the main process, which sends the
 * whole list after every add or remove. Until this runs, a user model's id
 * still resolves everywhere a listing carries its entry (the Library), but a
 * surface that looks a model up by id (an assignment's label) would show the
 * raw id.
 *
 * One memory read at startup and one subscription. No disk, no network.
 */

import { setUserLocalModels } from '../../shared/local-models/model-catalog';
import { logger } from '../utils/logger';

let started = false;

/** Start the sync. Safe to call more than once; the first call wins. */
export function startUserLocalModelsSync(): void {
	// The browser build and a test without the bridge have nothing to sync from.
	const api = window.maestro?.localModels?.huggingFace;
	if (started || !api) return;
	started = true;
	api.onChanged((entries) => setUserLocalModels(entries));
	api
		.list()
		.then((entries) => setUserLocalModels(entries))
		.catch((error: unknown) => {
			// The curated catalog still works; a user model shows by id until the
			// next change is pushed. Logged, since a rejected memory read is a bug.
			logger.error('Could not read the models added from Hugging Face', 'LocalModels', error);
		});
}
