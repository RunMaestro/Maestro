// Keep mode selection above every backend import: Lite must not open local stores or runtimes.
if (process.argv.includes('--lite')) {
	void import('./lite').then(({ startLite }) => startLite());
} else {
	void import('./index');
}

export {};
