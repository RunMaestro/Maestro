/**
 * Entry of the DataviewJS sandbox guest (D4, DEV-7). esbuild bundles it into one IIFE that
 * `scripts/build-preload.mjs` inlines into `guest.html`, giving `dist/main/dataview-guest.html`: the
 * document main serves inside the isolated `<webview>`, with the CSP as a header and a meta tag. Starting
 * the runtime locks down the globals note scripts see before any of them runs.
 */

import { startDataviewGuest } from './guestRuntime';

startDataviewGuest(window);
