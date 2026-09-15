import type { MaestroCliStatus } from '../../../../../shared/maestro-cli';

/**
 * CLI install/check state shared by Settings -> General and the first-run
 * Updates step. Extracted so those two surfaces cannot disagree about what an
 * install reported. The rest of GeneralTab's types stay inline on this branch.
 */
export interface MaestroCliState {
	status: MaestroCliStatus | null;
	statusError: string | null;
	checking: boolean;
	installing: boolean;
	installMessage: string | null;
	checkStatus: () => Promise<void>;
	installOrUpdate: () => Promise<void>;
}
