import { MANAGED_OMP_PACKAGE, MANAGED_OMP_VERSION } from './integrity';

export interface ThirdPartyNoticeInput {
	packageName: string;
	version: string;
	license: string;
	requiredFiles: readonly string[];
}

/** License aggregation input retained with each managed OMP runtime installation. */
export const MANAGED_OMP_NOTICE_INPUT: ThirdPartyNoticeInput = Object.freeze({
	packageName: MANAGED_OMP_PACKAGE,
	version: MANAGED_OMP_VERSION,
	license: 'MIT',
	requiredFiles: Object.freeze(['LICENSE']),
});
