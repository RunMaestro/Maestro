// React DevTools: connects to standalone react-devtools app (npm install -g react-devtools)
// Only attempts connection in dev mode (Vite serves on localhost:5173)
if (window.location.hostname === 'localhost' && window.localStorage.getItem('MAESTRO_ENABLE_DEVTOOLS_CONNECT') === 'true') {
	var script = document.createElement('script');
	script.src = 'http://localhost:8097';
	script.async = false;
	document.head.appendChild(script);
}
