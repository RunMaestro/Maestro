// Keep mode selection above every backend import: Lite must not open local stores or runtimes.
if (process.argv.includes('--lite')) {
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
	void import('./index');
}

export {};
