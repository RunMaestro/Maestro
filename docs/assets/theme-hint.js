/* global window, document, localStorage, URLSearchParams */
/**
 * Theme Hint Script for Maestro Docs
 *
 * When the Maestro app opens a docs URL with a ?theme= query parameter,
 * this script sets the Mintlify theme to match.
 *
 * Supported values: ?theme=dark | ?theme=light
 *
 * Mintlify stores the user's theme preference in localStorage under the
 * key "mintlify-color-scheme". Setting this key and dispatching a storage
 * event causes Mintlify to switch themes without a page reload.
 */
(function () {
	var params = new URLSearchParams(window.location.search);
	var theme = params.get('theme');

	if (theme === 'dark' || theme === 'light') {
		// Mintlify reads this localStorage key for theme preference
		try {
			localStorage.setItem('mintlify-color-scheme', theme);
		} catch {
			// localStorage unavailable — ignore
		}

		// Apply the class immediately to prevent flash of wrong theme
		document.documentElement.classList.remove('light', 'dark');
		document.documentElement.classList.add(theme);
		document.documentElement.style.colorScheme = theme;
	}
})();
