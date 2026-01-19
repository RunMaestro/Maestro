/**
 * Maestro Web Interface Entry Point
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
