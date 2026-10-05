/**
 * The idle watchdog moved into the library, where the headless runtime supervises Auto Run turns
 * with it (`src/shared/maestro-lib/control/idle-watchdog.ts`). This file keeps the old import path
 * working.
 */

export {
	createIdleWatchdog,
	type IdleWatchdog,
	type IdleWatchdogOptions,
} from '../../shared/maestro-lib/control/idle-watchdog';
