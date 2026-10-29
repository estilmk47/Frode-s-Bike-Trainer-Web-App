/**
 * Settings: global values (saved on the user's account) and local values (this browser only).
 *
 * Personal information (weight, FTP, ...) exists in both places. A local value is an override:
 * when it is set ("the local flag"), it wins over the global value on this device. That way a
 * shared spin bike can use a different weight or difficulty without touching the account.
 *
 * Device preferences (theme, units, clock) are local only.
 *
 * Applications read everything with `platform.settings.get(key)`. Personal values return null
 * when unknown, so an application can fall back to its own default (e.g. its own default weight).
 */
import { local } from './storage.js';

export const GENDERS = [
    { value: '', label: 'Not specified' },
    { value: 1, label: 'Female' },
    { value: 2, label: 'Male' },
    { value: 3, label: 'Other' },
];

export const DIFFICULTIES = [
    { value: '', label: 'Not specified' },
    { value: 1, label: 'Relaxed' },
    { value: 2, label: 'Easy' },
    { value: 3, label: 'Normal' },
    { value: 4, label: 'Hard' },
    { value: 5, label: 'Extreme' },
];

/** Personal information: global (account) + optional local override. Add new fields here. */
export const PERSONAL_FIELDS = [
    { key: 'nickname', label: 'Nickname', type: 'text', maxLength: 60, help: 'Shown in games. Does not have to be unique.' },
    { key: 'birthday', label: 'Birthday', type: 'date', navStart: '1990-01-01', help: 'Used for age based heart rate zones.' },
    { key: 'gender', label: 'Gender', type: 'select', options: GENDERS, number: true },
    { key: 'weight', label: 'Weight', type: 'number', unit: 'kg', min: 20, max: 300, step: 0.1, navStep: 0.5, navStart: 75, help: 'Used for speed in simulations and watts per kilo.' },
    { key: 'ftp', label: 'FTP', type: 'number', unit: 'W', min: 30, max: 999, step: 1, navStep: 5, navStart: 200, help: 'Functional threshold power: the power you can hold for about an hour.' },
    { key: 'difficulty', label: 'Difficulty', type: 'select', options: DIFFICULTIES, number: true, help: 'Applications scale their challenge with this.' },
];

/** Device preferences: stored locally only. */
export const DEVICE_FIELDS = [
    { key: 'theme', label: 'Theme', type: 'select', default: 'auto', options: [
        { value: 'auto', label: 'Follow the system' },
        { value: 'light', label: 'Basic white' },
        { value: 'dark', label: 'Basic black' },
    ] },
    { key: 'units', label: 'Units', type: 'select', default: 'metric', options: [
        { value: 'metric', label: 'Metric (km, km/h)' },
        { value: 'imperial', label: 'Imperial (mi, mph)' },
    ] },
    { key: 'clock', label: 'Clock', type: 'select', default: '24h', options: [
        { value: '24h', label: '24 hours' },
        { value: '12h', label: '12 hours (AM/PM)' },
    ] },
];

const DEVICE_KEY = 'device';
const overridesKey = (username) => `overrides.${username ?? 'local'}`;

export class Settings extends EventTarget {
    /** @param {import('./platform.js').Platform} platform */
    constructor(platform) {
        super();
        this.platform = platform;
    }

    get #username() { return this.platform.user?.username ?? 'local'; }

    /** Resolved value: local override › global › fallback. */
    get(key, fallback = null) {
        const device = DEVICE_FIELDS.find((f) => f.key === key);
        if (device) return this.device()[key] ?? device.default ?? fallback;
        const override = this.overrides()[key];
        if (override !== undefined && override !== null && override !== '') return override;
        const global = this.global(key);
        return global === undefined || global === null || global === '' ? fallback : global;
    }

    global(key) { return this.platform.user?.[key] ?? null; }

    overrides() { return local.get(overridesKey(this.#username), {}); }

    isOverridden(key) { return key in this.overrides(); }

    device() { return local.get(DEVICE_KEY, {}); }

    /** Save values to the user's account (server, or the local profile in local mode). */
    async saveGlobal(changes) {
        const user = await this.platform.api.setUserInformation(changes);
        this.platform.setUser(user);
        this.#changed();
        return user;
    }

    /**
     * @param {object} overrides full set of personal overrides for this device ({} removes all)
     * @param {object} [device] device preferences to merge in
     */
    saveLocal(overrides, device = null) {
        local.set(overridesKey(this.#username), overrides);
        if (device) local.set(DEVICE_KEY, { ...this.device(), ...device });
        this.#changed();
    }

    #changed() {
        applyTheme(document, this.get('theme'));
        this.dispatchEvent(new CustomEvent('change'));
    }
}

/** Apply the theme preference to a document (hub and every page call this). */
export function applyTheme(doc = document, theme = local.get(DEVICE_KEY, {}).theme ?? 'auto') {
    if (theme === 'light' || theme === 'dark') doc.documentElement.dataset.theme = theme;
    else delete doc.documentElement.dataset.theme;
}
