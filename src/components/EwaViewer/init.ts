/**
 * EwaViewer Initialization
 *
 * Load fzstd library before any EWA viewer components mount.
 * fzstd is in public/lib/ which Vite serves at /lib/ (not /src/lib/).
 */

// Load fzstd from the public lib folder
const fzstdScript = document.createElement('script');
fzstdScript.src = '/lib/fzstd.umd.js';
fzstdScript.async = true;
document.head.appendChild(fzstdScript);

// Reserved for future verbose logs (EWA_DEBUG). Currently silent — fzstd loading
// is non-critical; missing script is handled gracefully in the decompressor.
const EWA_DEBUG = false;
const dbg = (...args: unknown[]) => { if (EWA_DEBUG) console.log(...args); };
