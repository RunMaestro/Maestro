/**
 * Maestro Web Interface Entry Point
 *
 * DEPRECATED: This legacy mobile-web interface is no longer served by the
 * embedded web server. The web-desktop bundle (`src/web-desktop/`) is now the
 * default browser interface, served at the token root. This code is kept and
 * still builds (`npm run build:web`) for reference and potential reuse while a
 * native mobile app is developed, but the running app does not route to it.
 */

import { createRoot } from 'react-dom/client';
import { AppRoot } from './App';
import { webLogger } from './utils/logger';
import './index.css';

export { useOfflineStatus, useMaestroMode, useDesktopTheme } from './App';

// Mount the application
const container = document.getElementById('root');
if (container) {
	const root = createRoot(container);
	root.render(<AppRoot />);
} else {
	webLogger.error('Root element not found', 'App');
}
