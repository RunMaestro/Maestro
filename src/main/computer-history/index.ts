/**
 * Computer History - main-process entry point.
 *
 * `initComputerHistoryService()` is called once from `src/main/index.ts`; the
 * IPC handlers and the WS bridge handler look the instance up with
 * `getComputerHistoryService()`, so every surface reaches the same object.
 */

import {
	ComputerHistoryService,
	type ComputerHistoryServiceDeps,
} from './computer-history-service';
import {
	ObserverSupervisor,
	observerBinaryCandidates,
	resolveObserverBinary,
} from './observer-supervisor';

export { ComputerHistoryService } from './computer-history-service';
export { createComputerHistorySupervisorHooks } from './first-party';

let service: ComputerHistoryService | null = null;

export type ComputerHistoryInitDeps = Omit<
	ComputerHistoryServiceDeps,
	'createSupervisor' | 'resolveBinary'
> &
	Partial<Pick<ComputerHistoryServiceDeps, 'createSupervisor' | 'resolveBinary'>> & {
		/** `app.isPackaged`: packaged builds run only the bundled helper. */
		isPackaged: boolean;
	};

/** Construct the singleton (does not start it). */
export function initComputerHistoryService({
	isPackaged,
	...deps
}: ComputerHistoryInitDeps): ComputerHistoryService {
	service = new ComputerHistoryService({
		createSupervisor: (supervisorDeps) => new ObserverSupervisor(supervisorDeps),
		resolveBinary: () =>
			resolveObserverBinary(
				observerBinaryCandidates({
					packaged: isPackaged,
					resourcesPath:
						typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
							? process.resourcesPath
							: undefined,
					moduleDir: __dirname,
					cwd: process.cwd(),
				})
			),
		...deps,
	});
	return service;
}

/** The singleton, or null before init (headless boots, tests). */
export function getComputerHistoryService(): ComputerHistoryService | null {
	return service;
}

/** Test seam. */
export function setComputerHistoryServiceForTests(next: ComputerHistoryService | null): void {
	service = next;
}
