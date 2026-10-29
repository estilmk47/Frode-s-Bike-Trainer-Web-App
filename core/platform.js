/**
 * The platform: one shared object that owns the Bluetooth devices, the logged-in user, settings,
 * the application catalog and navigation.
 *
 * Web Bluetooth connections are lost when the page navigates, so the hub (index.html) stays loaded
 * and opens every page and application inside an overlay frame. Code in those frames calls
 * `getPlatform()` and receives the hub's instance – with the bike that is already connected.
 * Opened on their own (e.g. from a login link), pages get a fresh instance of their own.
 *
 * Events (`platform.on(type, fn)`): 'userchange', 'devicechange', 'homechange', 'bluetoothchange'.
 */
import { detectBackend, ServerBackend, LocalBackend } from './api.js';
import * as accounts from './accounts.js';
import { Settings, applyTheme } from './settings.js';
import { BASE_URL, local } from './storage.js';
import { importModule, setModuleSource } from './modules.js';

export class Platform extends EventTarget {
    backend = { mode: 'local', configured: false };
    /** @type {ServerBackend | LocalBackend} */
    api = new LocalBackend();
    user = null;
    catalog = [];
    settings = new Settings(this);

    /** Device slots. Read them when you need them (they are replaced when switching to a simulator). */
    bike = null;
    heartRateMonitor = null;
    controller = null; // ZwiftControllerGroup, created on first use

    bluetooth = { available: typeof navigator !== 'undefined' && !!navigator.bluetooth, enabled: null };
    modules = null;          // { devices, session, zwift } once loaded
    modulesError = null;

    /** Set by the hub: { openPage(path), openApp(id), close(), toast(text), openDevices() } */
    shell = null;

    constructor() {
        super();
        this.ready = this.#init();
    }

    on(type, listener) {
        const handler = (event) => listener(event.detail, event);
        this.addEventListener(type, handler);
        return () => this.removeEventListener(type, handler);
    }

    #emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    async #init() {
        applyTheme();
        const [backend, catalog] = await Promise.all([detectBackend(), loadCatalog()]);
        this.backend = backend;
        setModuleSource(backend.modules); // 'local' | 'cdn' | 'auto' from server/config.php
        this.api = backend.mode === 'server' ? new ServerBackend() : new LocalBackend();
        this.catalog = catalog;
        await this.refreshUser();
        this.#watchBluetooth();
        this.loadModules().catch(() => { /* reported through modulesError */ });
    }

    /* ---------------- Users ---------------- */

    get accounts() { return this.backend.mode === 'server' ? accounts.getAccounts() : []; }
    get isLoggedIn() { return !!this.user && !this.user.local; }

    async refreshUser() {
        let user = null;
        try {
            user = await this.api.me();
        } catch (error) {
            console.warn('Could not load the user:', error);
        }
        // A stored login the server no longer accepts (wrong key, deleted user) is removed.
        const active = accounts.getActiveUsername();
        if (this.backend.mode === 'server' && active && !user) accounts.removeAccount(active);
        this.setUser(user);
        return user;
    }

    setUser(user) {
        this.user = user;
        if (user && !user.local) {
            local.set(`profiles.${user.username.toLowerCase()}`, {
                username: user.username, nickname: user.nickname, icon: user.icon, icon_image: user.icon_image,
            });
        }
        applyTheme(document, this.settings.get('theme'));
        this.#emit('userchange', { user });
        this.#emit('homechange');
    }

    /** Store a login (from a login link) and make it the active user. */
    async login(username, key) {
        accounts.addAccount(username, key);
        const user = await this.api.me().catch(() => null);
        if (!user || user.username.toLowerCase() !== username.toLowerCase()) {
            accounts.removeAccount(username);
            await this.refreshUser();
            throw new Error('This login link is not valid (any more). Ask for a new one.');
        }
        this.setUser(user);
        return user;
    }

    /**
     * What another rider logged in on this device looks like (picture and colour), from the last
     * time they were active here – so their avatar looks the same before and after switching.
     */
    knownProfile(username) {
        return local.get(`profiles.${username.toLowerCase()}`, null) ?? { username };
    }

    /**
     * Change account settings (is_public, icon, username, email). Use this instead of
     * api.updateUser: a new username is also written to the login cookie.
     */
    async updateAccount(fields) {
        const before = this.user?.username;
        const user = await this.api.updateUser(fields);
        if (before && user.username !== before) {
            accounts.renameAccount(before, user.username);
            local.remove(`profiles.${before.toLowerCase()}`);
        }
        this.setUser(user);
        return user;
    }

    async switchUser(username) {
        accounts.setActiveUsername(username);
        return this.refreshUser();
    }

    async logout(username = this.user?.username) {
        if (username) {
            accounts.removeAccount(username);
            local.remove(`profiles.${username.toLowerCase()}`);
        }
        return this.refreshUser();
    }

    /* ---------------- Applications & home screen ---------------- */

    app(id) { return this.catalog.find((a) => a.id === id) ?? null; }

    /** Application ids on the home screen, in order. */
    homeApps() {
        const known = new Set(this.catalog.map((a) => a.id));
        const stored = this.user?.home_layout ?? local.get('home.guest', null);
        const ids = Array.isArray(stored) ? stored : this.catalog.filter((a) => a.defaultOnHome).map((a) => a.id);
        return ids.filter((id) => known.has(id));
    }

    async setHomeApps(ids) {
        if (this.user) {
            try {
                this.setUser(await this.api.setUserInformation({ home_layout: ids }));
                return;
            } catch (error) {
                console.warn('Could not save the home screen to the account, saving locally:', error);
            }
        }
        local.set('home.guest', ids);
        this.#emit('homechange');
    }

    isOnHome(id) { return this.homeApps().includes(id); }
    addToHome(id) { if (!this.isOnHome(id)) return this.setHomeApps([...this.homeApps(), id]); }
    removeFromHome(id) { return this.setHomeApps(this.homeApps().filter((x) => x !== id)); }

    /* ---------------- Navigation ---------------- */

    /** Open a page such as 'settings/' or 'profile/?user=frode'. */
    openPage(path) {
        if (this.shell) this.shell.openPage(path);
        else location.href = new URL(path, BASE_URL).href;
    }

    openApp(id) {
        if (this.shell) this.shell.openApp(id);
        else {
            const app = this.app(id);
            if (app) location.href = new URL(app.entry, BASE_URL).href;
        }
    }

    /** Back to the home screen. */
    home() {
        if (this.shell) this.shell.close();
        else location.href = BASE_URL.href;
    }

    openDevices() {
        if (this.shell) this.shell.openDevices();
        else location.href = new URL('#devices', BASE_URL).href;
    }

    toast(text) {
        this.shell?.toast(text);
    }

    /* ---------------- Devices ---------------- */

    /** Load the cycling-power-ble modules (from /modules or the CDN, see core/modules.js). */
    loadModules() {
        if (!this.modulesPromise) {
            this.modulesPromise = Promise.all([
                importModule('cycling-power-ble', 'src/ble_devices.module.js'),
                importModule('cycling-power-ble', 'src/session_tracker.module.js'),
                importModule('cycling-power-ble', 'src/zwift_controller.module.js'),
            ]).then(([devices, session, zwift]) => {
                this.modules = { devices, session, zwift };
                this.#emit('devicechange');
                return this.modules;
            }).catch((error) => {
                this.modulesError = 'The Bluetooth modules could not be loaded. Run "npm install" inside the /modules folder, '
                    + "or set 'modules_source' => 'cdn' in server/config.php to load them from the internet.";
                console.error(error);
                this.#emit('devicechange');
                throw error;
            });
        }
        return this.modulesPromise;
    }

    async #watchBluetooth() {
        if (!this.bluetooth.available) return;
        const update = async () => {
            try {
                this.bluetooth.enabled = navigator.bluetooth.getAvailability ? await navigator.bluetooth.getAvailability() : true;
            } catch {
                this.bluetooth.enabled = true;
            }
            this.#emit('bluetoothchange', this.bluetooth);
        };
        navigator.bluetooth.addEventListener?.('availabilitychanged', update);
        await update();
    }

    #setDevice(slot, device) {
        const previous = this[slot];
        if (previous === device) return;
        if (previous?.isConnected || previous?.isConnecting) previous.disconnect();
        this[slot] = device;
        device.on('statechange', () => this.#emit('devicechange'));
        device.on('battery', () => this.#emit('devicechange'));
        this.#emit('devicechange');
    }

    /** Connect a bike/trainer. Must be called from a click (the browser shows its device chooser). */
    async connectBike({ simulated = false } = {}) {
        const { devices } = await this.loadModules();
        if (simulated) {
            this.#setDevice('bike', new devices.SimulatedBike({ riderMass: (this.settings.get('weight') ?? 75) + 10 }));
        } else if (!(this.bike instanceof devices.BluetoothBike)) {
            this.#setDevice('bike', new devices.BluetoothBike({ autoReconnect: true }));
        }
        await this.bike.connect();
        // A simulated heart rate follows the bike it was created with.
        if (this.heartRateMonitor instanceof devices.SimulatedHeartRateMonitor) await this.connectHeartRate({ simulated: true });
        return this.bike;
    }

    async connectHeartRate({ simulated = false } = {}) {
        const { devices } = await this.loadModules();
        if (simulated) {
            this.#setDevice('heartRateMonitor', new devices.SimulatedHeartRateMonitor({
                bike: this.bike,
                ftp: this.settings.get('ftp') ?? 200,
            }));
        } else if (!(this.heartRateMonitor instanceof devices.HeartRateMonitor)) {
            this.#setDevice('heartRateMonitor', new devices.HeartRateMonitor());
        }
        await this.heartRateMonitor.connect();
        return this.heartRateMonitor;
    }

    disconnectBike() { this.bike?.disconnect(); this.#emit('devicechange'); }
    disconnectHeartRate() { this.heartRateMonitor?.disconnect(); this.#emit('devicechange'); }

    /** Add one Zwift Click v2 / Ride unit (call once per unit, from a click). */
    async addController() {
        const { zwift } = await this.loadModules();
        if (!this.controller) {
            this.controller = new zwift.ZwiftControllerGroup();
            for (const type of ['deviceadded', 'connected', 'disconnected', 'battery']) {
                this.controller.on(type, () => this.#emit('devicechange'));
            }
        }
        const device = await this.controller.requestDevice();
        this.#emit('devicechange');
        return device;
    }

    /* ---------------- Sessions ---------------- */

    /** A SessionTracker attached to the current bike and heart-rate monitor. */
    async createTracker(options = {}) {
        const { session } = await this.loadModules();
        return new session.SessionTracker({ bike: this.bike, heartRateMonitor: this.heartRateMonitor, ...options });
    }

    /**
     * Save a finished Session (from cycling-power-ble) to the user's history.
     * @param {object} session  a Session or SessionTracker
     * @param {{applicationId: string, isPublic?: boolean, title?: string, description?: string}} options
     */
    async saveSession(session, { applicationId, isPublic = !!this.user?.is_public, title = '', description = '' }) {
        const stats = session.getStats('total');
        const startTime = session.session?.startTime ?? session.startTime;
        const record = {
            application_id: applicationId,
            is_public: isPublic ? 1 : 0,
            started_at: new Date(startTime ?? Date.now()).toISOString(),
            duration: Math.round((stats.activeTime ?? 0) / 1000),
            distance: stats.distance ?? 0,
            avg_power: stats.power.avg,
            max_power: stats.power.max,
            avg_hr: stats.heartRate.avg,
            avg_speed: stats.speed.avg,
            avg_cadence: stats.cadence.avg,
            energy: stats.energy,
            notes: { title, description },
            data: session.toBase64(),
        };
        const saved = await this.api.saveSession(record);
        await this.refreshUser();
        return saved;
    }

    /** Turn a stored session record (fetched with data) back into a Session object. */
    async toSession(record) {
        const { session } = await this.loadModules();
        return session.Session.fromBase64(record.data);
    }
}

async function loadCatalog() {
    try {
        const response = await fetch(new URL('core/catalog.json', BASE_URL), { cache: 'no-cache' });
        const catalog = await response.json();
        // Convention: every application has assets/app_icon.png in its folder, used as its art.
        return (catalog.applications ?? []).map((app) => ({
            ...app,
            cover: app.cover ?? (app.entry ? app.entry.replace(/[^/]*$/, '') + 'assets/app_icon.png' : null),
        }));
    } catch (error) {
        console.error('Could not load core/catalog.json', error);
        return [];
    }
}

/**
 * The shared platform. Inside the hub's frames this is the hub's own instance.
 * @returns {Promise<Platform>}
 */
export function getPlatform() {
    let host = window;
    try {
        // Walk up through same-origin parents to the hub.
        while (host.parent !== host && host.parent.FBT?.platform) host = host.parent;
    } catch {
        /* a cross-origin parent: stay on our own instance */
    }
    if (!host.FBT) host.FBT = { platform: new Platform() };
    const platform = host.FBT.platform;
    return platform.ready.then(() => platform);
}

/** True when this document runs inside the hub's overlay frame. */
export function inHub() {
    try {
        return window.parent !== window && !!window.parent.FBT?.platform;
    } catch {
        return false;
    }
}
