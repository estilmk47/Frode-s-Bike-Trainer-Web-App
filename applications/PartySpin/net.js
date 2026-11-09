/**
 * Talking to the servers.
 *
 * Before a game, the lobby uses the PHP scripts in api/ (`api()`): the device id, checking a room
 * name and key, and the create menu (log in with an authentication key, save and delete rooms).
 *
 * In a game, PartyRoom keeps a WebSocket open to the Party Spin server (server/partyspin_server.py).
 * It keeps the local copy of a room: its settings, the scores (`state`, sent every second),
 * your cards and the event log. Every event the server sends carries the id list of the whole log
 * ("1-57"); when ours differs, we ask for what we are missing (`sync`). After a reconnect we say
 * hello again with the ids we already have and only get the rest.
 *
 * Events (`room.on(type, fn)`): 'status' (connection), 'welcome', 'room', 'state', 'event', 'hand',
 * 'answered', 'error', 'closed', 'kicked'.
 *
 * The connection is opened when you enter a room and closed when you leave it (`leave()`); your
 * rider stays in the room on the server.
 */
import { local } from '../../core/storage.js';

const SERVER_KEY = 'partyspin.server';
const DEVICE_KEY = 'partyspin.deviceId';
const AUTH_KEY = 'partyspin.authKey';

/** The id the server gave this device. It identifies you as a rider, also after a disconnect. */
export const deviceId = () => local.get(DEVICE_KEY, null);
/** The authentication key you are logged in with. It makes you a moderator of your own rooms. */
export const authKey = () => local.get(AUTH_KEY, null);
export const setAuthKey = (key) => local.set(AUTH_KEY, key || null);

/* ---------- The PHP scripts ---------- */

/** An error from api(); `code` is 'server-down' when the scripts could not be reached. */
export class ApiError extends Error {
    constructor(message, code = null) {
        super(message);
        this.code = code;
    }
}

/** POST `body` to api/<script>.php and return the answer, or throw an ApiError. */
export async function api(script, body = {}) {
    let response;
    let data;
    try {
        response = await fetch(`api/${script}.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            cache: 'no-store',
            signal: AbortSignal.timeout(8000),
        });
        data = await response.json();
    } catch {
        throw new ApiError('Could not reach the server.', 'server-down');
    }
    if (!data?.ok) throw new ApiError(data?.error ?? 'The server could not do that.', data?.code ?? (response.status >= 500 ? 'server-down' : null));
    return data;
}

/**
 * Ask the server which id this browser rides with (see api/resolve_device.php). Without an answer
 * the stored id is kept, or a temporary one is made.
 */
export async function resolveDevice() {
    try {
        const { deviceId: id } = await api('resolve_device', { deviceId: deviceId() });
        local.set(DEVICE_KEY, id);
    } catch {
        if (!deviceId()) local.set(DEVICE_KEY, `tmp-${Math.random().toString(36).slice(2, 14)}`);
    }
    return deviceId();
}

/** Where the server is: ?server=…, a saved address, or the default for this page. */
export function serverUrl() {
    const fromQuery = new URLSearchParams(location.search).get('server');
    if (fromQuery) return fromQuery;
    const saved = local.get(SERVER_KEY, '');
    if (saved) return saved;
    // Behind nginx with HTTPS the server is proxied on the same site; at home it runs on port 8765.
    if (location.protocol === 'https:') return `wss://${location.host}/partyspin/ws`;
    return `ws://${location.hostname || 'localhost'}:8765`;
}

export function saveServerUrl(url) {
    local.set(SERVER_KEY, url.trim());
}

/** [1, 2, 3, 5] → '1-3,5' (the same format as the server). */
export function idRanges(ids) {
    const sorted = [...ids].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i];
        while (sorted[i + 1] === sorted[i] + 1) i++;
        parts.push(sorted[i] > start ? `${start}-${sorted[i]}` : String(start));
    }
    return parts.join(',');
}

/** A WebSocket that reconnects by itself and can wait for an answer. */
class Socket extends EventTarget {
    #url;
    #ws = null;
    #retry = 0;
    #closed = false;
    #timer = null;
    status = 'connecting';      // 'connecting' | 'open' | 'offline'

    on(type, listener) {
        const handler = (event) => listener(event.detail);
        this.addEventListener(type, handler);
        return () => this.removeEventListener(type, handler);
    }

    constructor(url) {
        super();
        this.#url = url;
        this.#open();
    }

    #setStatus(status) {
        this.status = status;
        this.dispatchEvent(new CustomEvent('status', { detail: status }));
    }

    #open() {
        clearTimeout(this.#timer);
        this.#setStatus(this.#retry ? 'offline' : 'connecting');
        let ws;
        try {
            ws = new WebSocket(this.#url);
        } catch {
            this.#scheduleRetry();
            return;
        }
        this.#ws = ws;
        ws.addEventListener('open', () => {
            this.#retry = 0;
            this.#setStatus('open');
        });
        ws.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            this.dispatchEvent(new CustomEvent('message', { detail: message }));
        });
        ws.addEventListener('close', () => {
            if (this.#ws !== ws) return;
            this.#ws = null;
            if (!this.#closed) this.#scheduleRetry();
        });
    }

    #scheduleRetry() {
        this.#setStatus('offline');
        const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
        this.#timer = setTimeout(() => this.#open(), delay);
    }

    send(message) {
        if (this.#ws?.readyState !== WebSocket.OPEN) return false;
        this.#ws.send(JSON.stringify(message));
        return true;
    }

    /** Send and wait for the first message of type `reply` (or an error about this request). */
    request(message, reply, timeout = 8000) {
        return new Promise((resolve, reject) => {
            const done = (fn, value) => {
                clearTimeout(timer);
                this.removeEventListener('message', listen);
                fn(value);
            };
            const listen = ({ detail }) => {
                if (detail.type === reply) done(resolve, detail);
                else if (detail.type === 'error' && detail.request === message.type) done(reject, Object.assign(new Error(detail.message), { code: detail.code }));
            };
            const timer = setTimeout(() => done(reject, new Error('The server did not answer.')), timeout);
            this.addEventListener('message', listen);
            if (!this.send(message)) done(reject, new Error('Not connected to the Party Spin server.'));
        });
    }

    close() {
        this.#closed = true;
        clearTimeout(this.#timer);
        this.#ws?.close();
    }
}

export class PartyRoom extends EventTarget {
    /**
     * @param {{room: string, role: 'player' | 'screen', roomKey?: string, authKey?: string, rider?: object}} options
     *   room: the room's name · roomKey or authKey (its owner): moderator rights
     *   rider: { id, name, avatar, ftp, weight, difficulty } (players only)
     */
    constructor(options) {
        super();
        this.options = options;
        this.info = null;           // settings, status, run … (and the schedule for moderators)
        this.cards = {};
        this.you = null;
        this.players = [];
        this.hand = { hand: [], nope: false };
        this.events = new Map();    // id → event (this run)
        this.run = null;
        this.status = null;
        this.#clock = { value: 0, at: performance.now(), running: false };
        this.socket = new Socket(serverUrl());
        this.socket.addEventListener('status', ({ detail }) => {
            this.#emit('status', detail);
            if (detail === 'open') this.#hello();
        });
        this.socket.addEventListener('message', ({ detail }) => this.#receive(detail));
    }

    #clock;
    welcomed = false;           // has the server let us in (at least once)?

    on(type, listener) {
        const handler = (event) => listener(event.detail);
        this.addEventListener(type, handler);
        return () => this.removeEventListener(type, handler);
    }

    #emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    get connected() { return this.socket.status === 'open'; }
    get isAdmin() { return !!this.you?.admin; }
    get myId() { return this.you?.id ?? null; }

    /** Game time in ms (counts on locally between the server's updates). */
    clock() {
        const c = this.#clock;
        return c.running ? c.value + (performance.now() - c.at) : c.value;
    }

    #setClock(value, status) {
        const running = status === 'running';
        // Small differences are network jitter: never let the clock run backwards a little.
        const local = this.clock();
        if (running && this.#clock.running && value < local && local - value < 400) value = local;
        this.#clock = { value, at: performance.now(), running };
        this.status = status;
    }

    eventList() {
        return [...this.events.values()].sort((a, b) => a.id - b.id);
    }

    player(id) {
        return this.players.find((p) => p.id === id) ?? null;
    }

    name(id) {
        if (id && id === this.myId) return 'You';
        return this.player(id)?.name ?? 'Someone';
    }

    #hello() {
        const { room, role, roomKey, authKey: ownerKey, rider } = this.options;
        this.socket.send({
            // The room id finds the room again after a reconnect, also if it was renamed meanwhile.
            type: 'hello', room, roomId: this.info?.id, role, roomKey, authKey: ownerKey, ...(rider ?? {}),
            run: this.run, have: idRanges(this.events.keys()),
        });
    }

    #setRun(run) {
        if (run === this.run) return;
        this.run = run;
        this.events.clear();
    }

    #addEvents(events) {
        const added = [];
        for (const event of events.sort((a, b) => a.id - b.id)) {
            if (this.events.has(event.id)) continue;
            this.events.set(event.id, event);
            added.push(event);
        }
        for (const event of added) this.#emit('event', event);
    }

    #checkIds(ids) {
        if (idRanges(this.events.keys()) !== ids) this.socket.send({ type: 'sync', run: this.run, have: idRanges(this.events.keys()) });
    }

    #receive(message) {
        switch (message.type) {
            case 'welcome':
                this.welcomed = true;
                this.you = message.you;
                this.cards = message.cards;
                this.#setRun(message.room.run);
                this.#setRoom(message.room);
                this.#setState(message.state);
                if (message.hand) this.hand = message.hand;
                this.#emit('welcome', message);
                this.#addEvents(message.events);
                this.#emit('hand', this.hand);
                break;
            case 'room':
                if (message.room.run !== this.run) {
                    this.#setRun(message.room.run);
                    this.#emit('reset', message.room);
                }
                this.#setRoom(message.room);
                this.#checkIds(message.room.ids);
                break;
            case 'state':
                this.#setState(message);
                break;
            case 'event':
                if (message.run !== this.run) {
                    this.socket.send({ type: 'sync', run: null, have: '' });
                    return;
                }
                this.#addEvents([message.event]);
                this.#checkIds(message.ids);
                break;
            case 'events':
                this.#setRun(message.run);
                this.#addEvents(message.events);
                break;
            case 'hand':
                this.hand = { hand: message.hand, nope: message.nope };
                this.#emit('hand', this.hand);
                break;
            case 'answered':
            case 'closed':
            case 'kicked':
                this.#emit(message.type, message);
                break;
            case 'error':
                this.#emit('error', message);
                break;
        }
    }

    #setRoom(info) {
        this.info = info;
        this.#setClock(info.clock, info.status);
        this.#emit('room', info);
    }

    #setState(state) {
        this.players = state.players;
        this.#setClock(state.clock, state.status);
        this.#emit('state', state);
    }

    send(message) {
        return this.socket.send(message);
    }

    admin(action, extra = {}) {
        return this.socket.send({ type: 'admin', action, ...extra });
    }

    /** Change the rider (name, FTP, weight, difficulty, ghost mode) during the game. */
    updateRider(changes) {
        Object.assign(this.options.rider, changes);
        return this.socket.send({ type: 'profile', ...this.options.rider });
    }

    /** Leave the room: tell the server (it shows you as gone straight away) and disconnect. */
    leave() {
        this.socket.send({ type: 'leave' });
        this.socket.close();
    }

    close() {
        this.socket.close();
    }
}
