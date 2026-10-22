/**
 * MaestroRun - main-process entry point.
 *
 * `initMaestroRunService()` is called once from `src/main/index.ts`; the IPC
 * handlers, the WS bridge handler, and the system-prompt builder look the
 * instance up with `getMaestroRunService()`, so every surface reaches the same
 * object.
 */

import { MaestroRunService, type MaestroRunServiceDeps } from './maestro-run-service';

export { MaestroRunService } from './maestro-run-service';

let service: MaestroRunService | null = null;

/** Construct the singleton (does not inspect the machine). */
export function initMaestroRunService(deps: MaestroRunServiceDeps): MaestroRunService {
	service = new MaestroRunService(deps);
	return service;
}

/** The singleton, or null before init (headless boots, tests). */
export function getMaestroRunService(): MaestroRunService | null {
	return service;
}

/** Test seam. */
export function setMaestroRunServiceForTests(next: MaestroRunService | null): void {
	service = next;
}
