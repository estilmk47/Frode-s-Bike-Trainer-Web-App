/**
 * Browser storage helpers.
 *
 * - `local`       – JSON values in localStorage (settings, home layout, local profile)
 * - cookies       – only the functional login cookie(s), see accounts.js
 * - `sessionStore` – IndexedDB store for recorded sessions while running in local mode
 *
 * Every access is wrapped in try/catch: private windows and blocked site data must never break the app.
 */

/** Root URL of the project (the folder that contains index.html), works on any sub path. */
export const BASE_URL = new URL('../', import.meta.url);

const PREFIX = 'fbt.';

export const local = {
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(PREFIX + key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(PREFIX + key, JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },
    remove(key) {
        try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
    },
};

/* ---------- Cookies ---------- */

const YEAR_SECONDS = 365 * 24 * 60 * 60;

export function readCookie(name) {
    try {
        const match = document.cookie.split('; ').find((part) => part.startsWith(name + '='));
        return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
    } catch {
        return null;
    }
}

export function writeCookie(name, value, maxAge = YEAR_SECONDS) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAge}; path=${BASE_URL.pathname}; SameSite=Lax${secure}`;
}

export function deleteCookie(name) {
    writeCookie(name, '', 0);
}

/* ---------- IndexedDB (local sessions) ---------- */

const DB_NAME = 'fbt';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('sessions')) {
                    db.createObjectStore('sessions', { keyPath: 'session_key' }).createIndex('started_at', 'started_at');
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return dbPromise;
}

async function tx(mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('sessions', mode);
        const request = run(transaction.objectStore('sessions'));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error);
    });
}

export const sessionStore = {
    all: () => tx('readonly', (store) => store.getAll()).catch(() => []),
    get: (key) => tx('readonly', (store) => store.get(key)).catch(() => null),
    put: (record) => tx('readwrite', (store) => store.put(record)),
    delete: (key) => tx('readwrite', (store) => store.delete(key)),
};

/** Random URL-safe key, e.g. for local session keys. */
export function randomKey(length = 16) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
