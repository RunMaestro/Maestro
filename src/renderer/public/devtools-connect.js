// React DevTools: connects to standalone react-devtools app (npm install -g react-devtools)
// Only attempts connection in dev mode (Vite serves on localhost:17173)
if (window.location.hostname === 'localhost') {
	var script = document.createElement('script');
	script.src = 'http://localhost:8097';
	script.async = false;
	document.head.appendChild(script);
}
