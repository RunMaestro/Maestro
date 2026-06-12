(function () {
	var progress = 0;
	var progressBar = document.getElementById('splash-progress');
	var progressText = document.getElementById('splash-text');

	// Capture any errors and display them on the splash screen
	window.addEventListener('error', function (event) {
		if (progressText) {
			progressText.style.color = '#ff6b6b';
			progressText.textContent = 'Error: ' + (event.error?.message || event.message);
		}
		console.error(
			'[Splash] Error:',
			event.message,
			event.filename,
			event.lineno,
			event.colno,
			event.error
		);
	});
	window.addEventListener('unhandledrejection', function (event) {
		if (progressText) {
			progressText.style.color = '#ff6b6b';
			progressText.textContent = 'Error: ' + (event.reason?.message || String(event.reason));
		}
		console.error('[Splash] Unhandled rejection:', event.reason);
	});

	// Animate progress bar while waiting for React
	// Caps at 40% — React takes over with explicit stage updates after this
	var interval = setInterval(function () {
		progress += Math.random() * 2 + 0.5;
		if (progress > 40) progress = 40;
		if (progressBar) progressBar.style.width = progress + '%';
	}, 100);

	// Store interval ID so React can clear it
	window.__splashInterval = interval;
	window.__splashProgress = function () {
		return progress;
	};

	// Update splash progress and status text from React during initialization stages
	window.__updateSplash = function (newProgress, text) {
		clearInterval(interval);
		progress = newProgress;
		if (progressBar) progressBar.style.width = progress + '%';
		if (progressText && text) progressText.textContent = text;
	};

	// Function for React to call when ready
	window.__hideSplash = function () {
		clearInterval(interval);

		// Complete the progress bar
		if (progressBar) progressBar.style.width = '100%';
		if (progressText) progressText.textContent = 'Curtain up';

		// Helper to fade out the splash
		function fadeOut() {
			var splash = document.getElementById('initial-splash');
			if (splash) {
				splash.classList.add('hidden');
				// Remove from DOM after animation
				setTimeout(function () {
					if (splash && splash.parentNode) {
						splash.parentNode.removeChild(splash);
					}
				}, 500);
			}
		}

		// Wait for fonts to be loaded to prevent layout shift from font swap
		if (document.fonts && document.fonts.ready) {
			document.fonts.ready.then(function () {
				// Small delay after fonts ready for any final layout settling
				setTimeout(fadeOut, 50);
			});
		} else {
			// Fallback for browsers without Font Loading API
			setTimeout(fadeOut, 200);
		}
	};
})();
