/**
 * Shared UI helpers for the hub and all pages: icons, toasts, modals, avatars, number
 * formatting, the page header, and arrow-key / controller navigation.
 */
import { getPlatform, inHub } from './platform.js';
import { applyTheme } from './settings.js';
import { BASE_URL, local } from './storage.js';
import { createNavigation } from './navigation.js';

/* ---------------- Icons (24×24 paths) ---------------- */

const ICON_PATHS = {
    bluetooth: 'M17.71 7.71 12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    browse: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5 7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z',
    activities: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-2 .9-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2zm-7 5h5v5h-5z',
    bike: 'M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10 2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6.2l-2.2-2.3zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z',
    news: 'M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zM6 7h5v6H6V7zm7 0h5v2h-5V7zm0 4h5v2h-5v-2zm-7 4h12v2H6v-2z',
    info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
    user: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    gamepad: 'M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    apps: 'M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z',
    bolt: 'M7 2v11h3v9l7-12h-4l4-8z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    globe: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
    logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
    swap: 'M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
};

export function icon(name, className = 'icon') {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[name] ?? ICON_PATHS.info}"/></svg>`;
}

/* ---------------- Text & numbers ---------------- */

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const units = () => local.get('device', {}).units ?? 'metric';

export function formatDistance(meters) {
    if (meters === null || meters === undefined) return '–';
    if (units() === 'imperial') return `${(meters / 1609.344).toFixed(meters < 16093 ? 2 : 1)} mi`;
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
}

export function formatSpeed(kmh) {
    if (kmh === null || kmh === undefined) return '–';
    return units() === 'imperial' ? `${(kmh / 1.609344).toFixed(1)} mph` : `${kmh.toFixed(1)} km/h`;
}

/** Seconds → "1 h 05 min" / "12 min" / "45 s" */
export function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '–';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m) return `${m} min`;
    return `${s} s`;
}

export function formatNumber(value, unit = '', digits = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) return '–';
    return `${Number(value).toFixed(digits)}${unit ? ' ' + unit : ''}`;
}

export function formatDate(iso, options = { dateStyle: 'medium', timeStyle: 'short' }) {
    if (!iso) return '–';
    return new Intl.DateTimeFormat(undefined, options).format(new Date(iso));
}

/* ---------------- Avatars ---------------- */

export const AVATAR_COLORS = {
    teal: '#00a8a8', blue: '#2f7de1', purple: '#8a55d7', pink: '#e0508f',
    red: '#e0393e', orange: '#f08a24', yellow: '#d4ae1c', green: '#3aa655', gray: '#7a7a7a',
};

export const DEFAULT_PROFILE_ICON = 'assets/profile_icons/default.png';

/**
 * Profile picture: the user's uploaded picture (`user.icon_image`) or the default one, on top of
 * the background colour they picked (`user.icon`, a name from AVATAR_COLORS) – transparent PNGs
 * show the colour through. Without a chosen colour, one is derived from the username, so the same
 * user always gets the same colour everywhere.
 */
export function avatarImage(user) {
    const image = user?.icon_image;
    if (!image) return new URL(DEFAULT_PROFILE_ICON, BASE_URL).href;
    return image.startsWith('data:') ? image : new URL(image, BASE_URL).href;
}

export function avatarColor(user) {
    return AVATAR_COLORS[user?.icon] ?? colorFor((user?.username ?? '').toLowerCase());
}

export function avatar(user, className = '') {
    return `<span class="avatar ${className}" style="--avatar-color:${avatarColor(user)}" aria-hidden="true">`
        + `<img src="${esc(avatarImage(user))}" alt="" draggable="false"></span>`;
}

function colorFor(text) {
    const colors = Object.values(AVATAR_COLORS);
    let hash = 0;
    for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return colors[hash % colors.length];
}

/* ---------------- Application art ---------------- */

/**
 * The art of an application: its cover image (by convention applications/<app>/assets/app_icon.png)
 * over a gradient with the glyph, which stays visible when the image is missing.
 */
export function appArt(app) {
    const glyph = `<span class="glyph">${esc(app.glyph ?? app.title.slice(0, 2))}</span>`;
    if (!app.cover) return glyph;
    const src = new URL(app.cover, BASE_URL).href;
    return `${glyph}<img class="app-art" src="${esc(src)}" alt="" draggable="false" onerror="this.remove()">`;
}

export function appColors(app) {
    const [c1 = '#777', c2 = c1, c3 = c2] = app.colors ?? [];
    return `--c1:${esc(c1)};--c2:${esc(c2)};--c3:${esc(c3)}`;
}

/* ---------------- Toasts & modals ---------------- */

export function toast(text, { duration = 3500, doc = document } = {}) {
    let host = doc.querySelector('.toast-host');
    if (!host) {
        host = doc.createElement('div');
        host.className = 'toast-host';
        host.setAttribute('role', 'status');
        doc.body.append(host);
    }
    const element = doc.createElement('div');
    element.className = 'toast';
    element.textContent = text;
    host.append(element);
    setTimeout(() => element.remove(), duration);
}

/**
 * Open a modal dialog.
 * @param {{title: string, body: string | Node, actions?: {label: string, primary?: boolean, value?: any, onClick?: Function}[]}} options
 * @returns {{dialog: HTMLDialogElement, closed: Promise<any>, close: (value?: any) => void}}
 */
export function modal({ title, body, actions = [{ label: 'OK', primary: true }] }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.innerHTML = `
        <div class="modal-head"><h2>${esc(title)}</h2>
            <button class="ghost small" data-close aria-label="Close">${icon('close')}</button></div>
        <div class="modal-body"></div>
        <div class="modal-actions"></div>`;
    const bodyElement = dialog.querySelector('.modal-body');
    if (typeof body === 'string') bodyElement.innerHTML = body;
    else bodyElement.append(body);

    let resolve;
    const closed = new Promise((r) => { resolve = r; });
    let result;
    const close = (value) => { result = value; dialog.close(); };

    for (const action of actions) {
        const button = document.createElement('button');
        button.textContent = action.label;
        if (action.primary) button.className = 'primary';
        button.addEventListener('click', async () => {
            if (action.onClick && (await action.onClick(dialog)) === false) return;
            close(action.value ?? action.label);
        });
        dialog.querySelector('.modal-actions').append(button);
    }
    dialog.querySelector('[data-close]').addEventListener('click', () => close(null));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result ?? null); });
    document.body.append(dialog);
    dialog.showModal();
    return { dialog, closed, close };
}

/* ---------------- Page chrome ---------------- */

/**
 * Common setup for every page: theme, header with a back button, keyboard navigation.
 * @returns {Promise<import('./platform.js').Platform>}
 */
export async function initPage({ title, iconName = 'info', actions = '' }) {
    applyTheme();
    const header = document.createElement('header');
    header.className = 'page-header';
    header.innerHTML = `
        <button class="small" data-back title="Back to home (Esc / B)">${icon(inHub() ? 'back' : 'home')}<span>${inHub() ? 'Back' : 'Home'}</span></button>
        <h1>${icon(iconName)}${esc(title)}</h1>
        <div class="header-actions">${actions}</div>`;
    const page = document.querySelector('.page') ?? document.body;
    page.prepend(header);

    const platform = await getPlatform();
    const back = () => platform.home();
    header.querySelector('[data-back]').addEventListener('click', back);
    // The cursor starts on the first control of the page itself, not on the Back button.
    const firstInContent = () => [...page.querySelectorAll('button, a[href], input, select, textarea')]
        .find((element) => !header.contains(element) && !element.disabled && element.getClientRects().length
            && !element.matches('input:not([type="checkbox"]):not([type="radio"]), textarea')) ?? null; // no on-screen keyboard popping up
    const navigation = createNavigation(document, { onBack: back, initial: firstInContent });
    setTimeout(() => { if (!navigation.current) navigation.focus(firstInContent() ?? header.querySelector('[data-back]')); }, 400);
    listen(platform.settings, 'change', () => applyTheme(document, platform.settings.get('theme')));
    applyTheme(document, platform.settings.get('theme'));
    if (!inHub()) document.title = `${title} · Frode's Bike Trainer`;
    return platform;
}

/**
 * Subscribe to an event on a shared object (the platform, a device, ...) and unsubscribe
 * automatically when this page closes. Use this from pages and applications: the platform lives
 * in the hub and outlives them.
 */
export function listen(target, type, listener) {
    let off;
    if (typeof target.on === 'function') off = target.on(type, listener);
    else {
        target.addEventListener(type, listener);
        off = () => target.removeEventListener(type, listener);
    }
    window.addEventListener('pagehide', off, { once: true });
    return off;
}

/** Toast that shows on the hub when we are inside it (so it survives closing the page). */
export function notify(platform, text) {
    if (platform.shell) platform.toast(text);
    else toast(text);
}

/** Notice shown on pages that need the online server while running in local mode. */
export function localModeNotice(platform, what = 'This feature') {
    if (platform.backend.mode === 'server') return '';
    const extra = platform.backend.message ? ` ${esc(platform.backend.message)}` : '';
    return `<div class="notice warning">${icon('info')}<div><strong>Local mode.</strong> ${esc(what)} needs the online server.
        Everything you do now is stored in this browser only.${extra}</div></div>`;
}
