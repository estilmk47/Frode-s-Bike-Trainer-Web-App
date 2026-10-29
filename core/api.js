/**
 * Backend client.
 *
 * Two interchangeable backends with the same methods:
 *
 * - ServerBackend – talks to the PHP + SQLite scripts in /server (online hosting, or `php -S`).
 * - LocalBackend  – everything stays in this browser (localStorage + IndexedDB). Used automatically
 *                   when the PHP scripts can't run, e.g. when testing with `python -m http.server`.
 *
 * `detectBackend()` asks server/status.php; if no JSON comes back we are in local mode.
 *
 * User objects:  { username, nickname, icon, is_public, birthday, weight, ftp, gender, difficulty,
 *                  home_layout: [appId...], stats: {...}, own, local }
 * Session records: { session_key, username, nickname, icon, application_id, is_public, started_at (ISO),
 *                  duration (s), distance (m), avg_power, max_power, avg_hr, avg_speed, avg_cadence,
 *                  energy (kJ), notes: {title, description}, data?: base64 RIDE }
 */
import { BASE_URL, local, sessionStore, randomKey } from './storage.js';

const SERVER_URL = new URL('server/', BASE_URL);

export class ApiError extends Error {
    constructor(message, { status = 0, code = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

const OFFLINE_MESSAGE = 'This needs the online server. You are running in local mode, where everything is stored in this browser only.';

/**
 * @returns {Promise<{mode: 'server'|'local', configured: boolean, modules: 'local'|'cdn'|'auto', message?: string}>}
 */
export async function detectBackend() {
    const offline = { mode: 'local', configured: false, modules: 'auto' };
    try {
        const response = await fetch(new URL('status.php', SERVER_URL), { cache: 'no-store' });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !type.includes('json')) return offline;
        const status = await response.json();
        if (status.app !== 'fbt') return offline;
        const modules = status.modules ?? 'auto';
        if (!status.configured) {
            return { ...offline, modules, message: 'The PHP server is running but not configured yet (copy server/config.example.php to server/config.php).' };
        }
        return { mode: 'server', configured: true, modules };
    } catch {
        return offline;
    }
}

/* ======================================================================================= */

export class ServerBackend {
    mode = 'server';

    /** `form` (FormData) sends a multipart upload instead of a JSON body. */
    async #request(file, { method = 'GET', query = null, body = null, form = null } = {}) {
        const url = new URL(file, SERVER_URL);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
        }
        let response;
        try {
            response = await fetch(url, {
                method,
                credentials: 'same-origin',
                headers: body ? { 'Content-Type': 'application/json' } : {},
                body: form ?? (body ? JSON.stringify(body) : undefined),
            });
        } catch {
            throw new ApiError('Could not reach the server. Check your connection.');
        }
        let data;
        try {
            data = await response.json();
        } catch {
            throw new ApiError(`The server sent an unreadable answer (${response.status}).`, { status: response.status });
        }
        if (!response.ok || data.ok === false) {
            throw new ApiError(data.error || `Request failed (${response.status}).`, { status: response.status, code: data.code });
        }
        return data;
    }

    /** The logged-in (active) user, or null. */
    async me() {
        const data = await this.#request('get_user_information.php');
        return data.user ?? null;
    }

    async user(username) {
        return (await this.#request('get_user_information.php', { query: { username } })).user;
    }

    async searchUsers(search) {
        return (await this.#request('get_user_information.php', { query: { search } })).users;
    }

    async createUser({ username, email }) {
        return this.#request('create_user.php', { method: 'POST', body: { username, email } });
    }

    async sendLoginLink(email) {
        return this.#request('send_login_link.php', { method: 'POST', body: { email } });
    }

    /** Account fields: is_public, icon, username, email. */
    async updateUser(fields) {
        return (await this.#request('update_user.php', { method: 'POST', body: fields })).user;
    }

    /** Personal information: nickname, birthday, gender, weight, ftp, difficulty, home_layout. */
    async setUserInformation(fields) {
        return (await this.#request('set_user_information.php', { method: 'POST', body: fields })).user;
    }

    async setFriend(username, follow) {
        return this.#request('set_friend.php', { method: 'POST', body: { username, follow } });
    }

    /** Upload a square PNG (Blob) as the profile picture. */
    async uploadProfileIcon(blob) {
        const form = new FormData();
        form.append('icon', blob, 'icon.png');
        return (await this.#request('upload_profile_icon.php', { method: 'POST', form })).user;
    }

    async removeProfileIcon() {
        const form = new FormData();
        form.append('remove', '1');
        return (await this.#request('upload_profile_icon.php', { method: 'POST', form })).user;
    }

    /** File names in assets/profile_icons/ (default.png first). */
    async profileIconLibrary() {
        return (await this.#request('list_profile_icons.php')).icons;
    }

    /** Use a library picture (deletes an uploaded one). */
    async chooseProfileIcon(file) {
        const form = new FormData();
        form.append('library', file);
        return (await this.#request('upload_profile_icon.php', { method: 'POST', form })).user;
    }

    /**
     * @param {{username?: string, friends?: boolean, feed?: boolean, from?: string, to?: string, limit?: number}} query
     */
    async sessions(query = {}) {
        const q = { ...query, friends: query.friends ? 1 : null, feed: query.feed ? 1 : null };
        return (await this.#request('get_user_session.php', { query: q })).sessions;
    }

    async session(sessionKey, { withData = false } = {}) {
        return (await this.#request('get_user_session.php', { query: { session_key: sessionKey, data: withData ? 1 : null } })).session;
    }

    async saveSession(record) {
        return (await this.#request('save_user_session.php', { method: 'POST', body: record })).session;
    }
}

/* ======================================================================================= */

const LOCAL_PROFILE_KEY = 'localProfile';

function defaultLocalProfile() {
    return {
        username: 'local',
        nickname: 'Rider',
        icon: 'teal',
        icon_image: null,
        is_public: 0,
        birthday: null,
        weight: null,
        ftp: null,
        gender: null,
        difficulty: null,
        home_layout: null,
        coins: 0,
        level: 0,
    };
}

export class LocalBackend {
    mode = 'local';

    #profile() {
        return { ...defaultLocalProfile(), ...local.get(LOCAL_PROFILE_KEY, {}) };
    }

    #saveProfile(changes) {
        local.set(LOCAL_PROFILE_KEY, { ...this.#profile(), ...changes });
    }

    async me() {
        const profile = this.#profile();
        const sessions = await sessionStore.all();
        return {
            ...profile,
            own: true,
            local: true,
            stats: { ...computeStats(sessions, profile), coins: profile.coins },
        };
    }

    async user(username) {
        if (username === 'local') return this.me();
        throw new ApiError(OFFLINE_MESSAGE, { code: 'offline' });
    }

    async searchUsers() { throw new ApiError(OFFLINE_MESSAGE, { code: 'offline' }); }
    async createUser() { throw new ApiError(OFFLINE_MESSAGE, { code: 'offline' }); }
    async sendLoginLink() { throw new ApiError(OFFLINE_MESSAGE, { code: 'offline' }); }
    async setFriend() { throw new ApiError(OFFLINE_MESSAGE, { code: 'offline' }); }

    async updateUser(fields) {
        const allowed = pick(fields, ['is_public', 'icon']);
        this.#saveProfile(allowed);
        return this.me();
    }

    async setUserInformation(fields) {
        this.#saveProfile(pick(fields, ['nickname', 'birthday', 'gender', 'weight', 'ftp', 'difficulty', 'home_layout']));
        return this.me();
    }

    /** In local mode the picture is kept in the browser as a data: URL. */
    async uploadProfileIcon(blob) {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
        this.#saveProfile({ icon_image: dataUrl });
        return this.me();
    }

    async removeProfileIcon() {
        this.#saveProfile({ icon_image: null });
        return this.me();
    }

    /**
     * Without PHP the folder can't be listed by a script; python -m http.server shows a directory
     * listing instead, which is read here. Other servers: only the default picture.
     */
    async profileIconLibrary() {
        try {
            const url = new URL('assets/profile_icons/', BASE_URL);
            const html = await (await fetch(url, { cache: 'no-cache' })).text();
            const files = [...html.matchAll(/href="([^"?#/]+\.(?:png|jpe?g|webp|gif))"/gi)].map((m) => decodeURIComponent(m[1]));
            const unique = [...new Set(files)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            return ['default.png', ...unique.filter((f) => f !== 'default.png')];
        } catch {
            return ['default.png'];
        }
    }

    async chooseProfileIcon(file) {
        this.#saveProfile({ icon_image: file === 'default.png' ? null : `assets/profile_icons/${file}` });
        return this.me();
    }

    async sessions({ feed = false, from = null, to = null, limit = 500 } = {}) {
        if (feed) return [];
        const profile = this.#profile();
        return (await sessionStore.all())
            .filter((s) => (!from || s.started_at >= from) && (!to || s.started_at <= to))
            .sort((a, b) => b.started_at.localeCompare(a.started_at))
            .slice(0, limit)
            .map(({ data, ...s }) => ({ ...s, username: 'local', nickname: profile.nickname, icon: profile.icon, icon_image: profile.icon_image }));
    }

    async session(sessionKey, { withData = false } = {}) {
        const record = await sessionStore.get(sessionKey);
        if (!record) throw new ApiError('Session not found.', { status: 404 });
        const profile = this.#profile();
        const result = { ...record, username: 'local', nickname: profile.nickname, icon: profile.icon, icon_image: profile.icon_image };
        if (!withData) delete result.data;
        return result;
    }

    async saveSession(record) {
        const stored = { ...record, session_key: randomKey(16), created_at: new Date().toISOString() };
        await sessionStore.put(stored);
        const profile = this.#profile();
        this.#saveProfile({ coins: (profile.coins ?? 0) + coinsForSession(stored) });
        const { data, ...summary } = stored;
        return summary;
    }
}

/* ---------- Shared rules (keep in sync with server/update_user_stats.php) ---------- */

/** Coins earned for one session: 1 per km plus 1 per 10 minutes. */
export function coinsForSession({ distance = 0, duration = 0 }) {
    return Math.floor((distance || 0) / 1000) + Math.floor((duration || 0) / 600);
}

/**
 * Score of a single session, used for the level. Watts per kilo (75 kg if unknown), scaled by
 * duration so a 2 minute sprint does not beat an hour of solid work.
 */
export function sessionScore({ avg_power, duration }, weight) {
    if (!avg_power || !duration) return 0;
    const wattsPerKilo = avg_power / (weight || 75);
    const durationFactor = Math.min(1, Math.sqrt(duration / 3600));
    return wattsPerKilo * 10 * durationFactor;
}

/** Level = average score of the best 10 sessions of the last 6 months. */
export function computeStats(sessions, profile = {}) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const recent = sessions.filter((s) => new Date(s.started_at) >= sixMonthsAgo);
    const best = recent.map((s) => sessionScore(s, profile.weight)).sort((a, b) => b - a).slice(0, 10);
    return {
        session_count: sessions.length,
        total_distance: sessions.reduce((sum, s) => sum + (s.distance || 0), 0),
        total_time: sessions.reduce((sum, s) => sum + (s.duration || 0), 0),
        longest_ride: sessions.reduce((max, s) => Math.max(max, s.distance || 0), 0),
        level: best.length ? best.reduce((a, b) => a + b, 0) / best.length : 0,
    };
}

function pick(object, keys) {
    return Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]));
}
