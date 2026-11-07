/**
 * The bundled URL of the PCM worklet.
 *
 * `?worker&url` makes Vite emit `pcm-worklet.ts` as its own self-contained chunk
 * and hand back its URL instead of linking it into the renderer bundle - which
 * is exactly what `AudioWorklet.addModule()` needs, and exactly what a plain
 * import would get wrong (`AudioWorkletProcessor` does not exist on the main
 * thread).
 *
 * Deliberately its own one-line module. A `Blob` URL would sidestep the bundler
 * entirely, but worklet module fetches are checked against `script-src`, which
 * `src/renderer/index.html` pins to `'self'` - so an inline blob would be
 * blocked at load, and widening the app's CSP to `blob:` for one worklet is not
 * a trade worth making. Isolating the import also keeps `capture.ts` free of
 * bundler-specific syntax, so it can be unit tested without a Vite pipeline.
 */

import pcmWorkletUrl from './pcm-worklet.ts?worker&url';

export { pcmWorkletUrl };
