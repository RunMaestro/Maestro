import { app } from 'electron';
import {
	assertBoardIsolationBootstrap,
	isBoardIsolationRequested,
	readBoardIsolationRegistries,
	requireBoardIsolation,
} from './board/board-isolation';

// Admission precedes even index's static imports (some backend modules have eager IO).
const isolated = isBoardIsolationRequested()
	? requireBoardIsolation({ productionUserData: app.getPath('userData') })
	: undefined;
if (isolated) {
	const contract = isolated;
	if (process.env.MAESTRO_DEMO_DIR !== contract.userData) {
		throw new Error('Board isolation requires explicit MAESTRO_DEMO_DIR matching userData');
	}
	assertBoardIsolationBootstrap(contract);
	readBoardIsolationRegistries(contract);
	app.setPath('userData', contract.userData);
}

// Keep mode selection above every backend import: Lite must not open local stores or runtimes.
if (process.argv.includes('--lite')) {
	if (isolated) throw new Error('Board isolation refuses the Lite desktop bridge');
	void import('./lite')
		.then(({ startLite }) => startLite())
		.catch(async (error: unknown) => {
			const { app, dialog } = await import('electron');
			console.error('Maestro Lite failed to start', error);
			dialog.showErrorBox(
				'Maestro Lite could not start',
				error instanceof Error ? error.message : String(error)
			);
			app.exit(1);
		});
} else {
	if (isolated) {
		void (async () => {
			const { configureIsolatedBoardSourceHost } = await import('./board/board-source-host');
			configureIsolatedBoardSourceHost(isolated);
			await import('./index');
		})().catch((error: unknown) => {
			console.error('Isolated Maestro backend failed to start', error);
			app.exit(1);
		});
	} else {
		void import('./index');
	}
}

export {};
