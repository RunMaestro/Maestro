// Moved into maestro-lib (Maestro-lib Part One): remote (SSH) spawn wrapping
// carries no desktop-framework dependency, so it now lives in the shared
// library. Re-exported here so every existing `from '../utils/ssh-spawn-wrapper'`
// import keeps resolving unchanged (this is also the path CLAUDE.md's
// "SSH Remote Execution Awareness" section names - do not delete this shim).
import { setMaestroLibSshTranslationFs } from '../../shared/maestro-lib/host';

setMaestroLibSshTranslationFs(async (remote) => {
	const { createSshTranslationFs } = await import('../provider-translation-fs');
	return createSshTranslationFs(remote);
});

export * from '../../shared/maestro-lib/launch/ssh-spawn-wrapper';
