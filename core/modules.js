/**
 * Loads third-party modules either from /modules/node_modules (after `npm install`) or from a CDN,
 * for servers where node modules can't be installed.
 *
 * The source is set with 'modules_source' in server/config.php and reported by server/status.php:
 *   'local' – only /modules/node_modules
 *   'cdn'   – only the online copies below
 *   'auto'  – local first, the CDN when the local file is missing (also used without PHP)
 *
 * The CDN versions are pinned to what modules/package-lock.json installs. When you update a
 * module with npm, update its version here too.
 */
import { BASE_URL } from './storage.js';

export const MODULES = {
    'cycling-power-ble': {
        local: 'modules/node_modules/cycling-power-ble/',
        cdn: 'https://cdn.jsdelivr.net/gh/estilmk47/Cycling-Power-BLE-JavaScript-module@dd996cb44cd2f37b9f279649e55238cec3634185/',
    },
    three: {
        local: 'modules/node_modules/three/',
        cdn: 'https://cdn.jsdelivr.net/npm/three@0.186.1/',
    },
};

let source = 'auto';

/** Called by the platform with the value from server/status.php. */
export function setModuleSource(value) {
    if (value === 'local' || value === 'cdn' || value === 'auto') source = value;
}

export function getModuleSource() { return source; }

/** URL of a file inside a module, for the configured source (in 'auto' mode: the local one). */
export function moduleUrl(name, path, from = source === 'cdn' ? 'cdn' : 'local') {
    const module = MODULES[name];
    if (!module) throw new Error(`Unknown module "${name}" – add it to MODULES in core/modules.js`);
    return from === 'cdn' ? module.cdn + path : new URL(module.local + path, BASE_URL).href;
}

/**
 * Import a file from a module, e.g. importModule('three', 'build/three.module.js').
 * Note: three.js addons (examples/jsm/...) import the bare name 'three' and also need an
 * import map in the page that uses them (see README).
 */
export async function importModule(name, path) {
    if (source !== 'auto') return import(moduleUrl(name, path));
    try {
        return await import(moduleUrl(name, path, 'local'));
    } catch (localError) {
        try {
            return await import(moduleUrl(name, path, 'cdn'));
        } catch {
            throw localError;
        }
    }
}
