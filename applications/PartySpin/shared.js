/** Small helpers shared by the lobby, the rider view and the big screen. */
import { local } from '../../core/storage.js';
import { esc, icon } from '../../core/ui.js';
import { deviceId } from './net.js';
import { cardColor, cardIcon } from './rules.js';

export const $ = (selector, root = document) => root.querySelector(selector);

/* ---------- Pop-ups ---------- */

const layer = document.getElementById('layer');

/**
 * Show a pop-up above the view. Pop-ups with the same `key` replace each other.
 * @returns {HTMLElement & {close: () => void}}
 */
export function popup(html, { key = null, className = '', dismissible = false } = {}) {
    if (key) closePopup(key);
    const element = document.createElement('section');
    element.className = `popup ${className}`;
    if (key) element.dataset.key = key;
    element.innerHTML = html;
    element.close = () => element.remove();
    if (dismissible) {
        element.addEventListener('click', (event) => {
            if (event.target === element || event.target.closest('[data-close]')) element.close();
        });
    }
    layer.append(element);
    return element;
}

export function closePopup(key) {
    layer.querySelectorAll(`.popup[data-key="${key}"]`).forEach((element) => element.remove());
}

export function closeAllPopups() {
    layer.replaceChildren();
}

/* ---------- Backdrop: brick (default), a colour or a video synced to the game clock ---------- */

const backdrop = document.getElementById('backdrop');
const video = document.getElementById('backdrop-video');

/** @param {{background?: 'brick' | 'color' | 'video', color?: string, video?: string}} display */
export function setBackdrop(display = {}) {
    const kind = display.background ?? 'brick';
    backdrop.dataset.kind = kind;
    backdrop.style.setProperty('--backdrop-color', kind === 'color' ? display.color || '#2b1d33' : '');
    const src = kind === 'video' && display.video ? display.video : '';
    if (video.dataset.src !== src) {
        video.dataset.src = src;
        if (src) video.src = src;
        else video.removeAttribute('src');
        video.load();
    }
    video.hidden = !src;
}

/** Keep the video at the game clock (seconds since the start) while the game runs. */
export function syncVideo(clockMs, running) {
    if (video.hidden || !video.dataset.src || Number.isNaN(video.duration)) return;
    const target = clockMs / 1000;
    if (!running) {
        if (!video.paused) video.pause();
        if (Math.abs(video.currentTime - target) > 0.5 && target < video.duration) video.currentTime = target;
        return;
    }
    if (target >= video.duration) {
        // A short video loops along.
        if (video.paused) video.play().catch(() => {});
        return;
    }
    if (Math.abs(video.currentTime - target) > 1.5) video.currentTime = target;
    if (video.paused) video.play().catch(() => {});
}

/* ---------- Who am I ---------- */

const PROFILE_KEY = 'partyspin.profile';

/** The logged in user's values (nothing here changes the user). */
export function hubProfile(platform) {
    const user = platform.user ?? {};
    return {
        nickname: platform.settings.get('nickname') || user.nickname || user.username || 'Rider',
        ftp: Number(platform.settings.get('ftp', 200)) || 200,
        weight: Number(platform.settings.get('weight', 75)) || 75,
        difficulty: Number(platform.settings.get('difficulty')) || '',
        ghost: false,
    };
}

/** The values used in Party Spin: the user's, with what was changed here on top. */
export const gameProfile = (platform) => ({ ...hubProfile(platform), ...local.get(PROFILE_KEY, {}) });

/**
 * Remember the values that differ from the user's, in this browser and for this app only. `values`
 * may be some of them (the lobby has no ghost mode: that is set in the room).
 */
export function saveGameProfile(platform, values) {
    const hub = hubProfile(platform);
    const merged = { ...local.get(PROFILE_KEY, {}), ...values };
    local.set(PROFILE_KEY, Object.fromEntries(Object.entries(merged).filter(([key, value]) => value !== hub[key])));
}

/** Back to the user's values ("Use my profile"); ghost mode stays as it is. */
export function clearGameProfile() {
    const { ghost } = local.get(PROFILE_KEY, {});
    local.set(PROFILE_KEY, ghost ? { ghost } : {});
}
export const hasGameProfile = () => Object.keys(local.get(PROFILE_KEY, {})).some((key) => key !== 'ghost');

/** The rider as sent to the server. */
export function riderInfo(platform) {
    const user = platform.user ?? {};
    const profile = gameProfile(platform);
    const image = user.icon_image && !user.icon_image.startsWith('data:') ? user.icon_image : '';
    return {
        id: deviceId(),
        name: profile.nickname,
        avatar: { icon: user.icon ?? '', image },
        ftp: profile.ftp,
        weight: profile.weight,
        difficulty: profile.difficulty || null,
        ghost: !!profile.ghost,
    };
}

/* ---------- How this browser shows a room (top bar numbers, the drawer …) ---------- */

const VIEW_KEY = 'partyspin.view';
const VIEW_DEFAULTS = {
    power: 'raw',       // POWER_VIEWS in rules.js
    speed: 'kmh',       // SPEED_VIEWS in rules.js
    autoJump: true,     // go to Events when something happens (and close the drawer)
    onlyMine: true,     // riders: Events shows only what affects you
    drawerHeight: 320,  // px
};

export const viewPrefs = () => ({ ...VIEW_DEFAULTS, ...local.get(VIEW_KEY, {}) });
export const setViewPrefs = (changes) => local.set(VIEW_KEY, { ...viewPrefs(), ...changes });

/* ---------- Room keys (they make a spectator a moderator of a room) ---------- */

const ROOM_KEYS = 'partyspin.roomKeys';
/** As name_key on the server: upper case and spaces don't matter. */
const nameKey = (room) => String(room).replace(/\s+/g, '').toLowerCase();

export const roomKeyFor = (room) => local.get(ROOM_KEYS, {})[nameKey(room)] ?? null;

export function rememberRoomKey(room, key) {
    const keys = local.get(ROOM_KEYS, {});
    if (key) keys[nameKey(room)] = key;
    else delete keys[nameKey(room)];
    local.set(ROOM_KEYS, keys);
}

/* ---------- Bits of markup ---------- */

export function cardTile(card, cards, { slot = null, small = false, empty = false } = {}) {
    if (empty) return `<div class="card-tile empty ${small ? 'small' : ''}" aria-hidden="true"></div>`;
    const rules = cards[card] ?? {};
    return `<button class="card-tile ${small ? 'small' : ''}" style="--card:${cardColor(card)}" ${slot != null ? `data-slot="${slot}"` : ''} title="${esc(rules.name ?? '')}">
        <img src="${cardIcon(card)}" alt="" draggable="false"><span>${esc(rules.name ?? '?')}</span></button>`;
}

/* ---------- Entering a room: "server disconnected" and "room not found" ---------- */

/** The "server disconnected" picture. `actions`: extra buttons [{label, act, primary?}], handled by `onAction(act)`. */
export function showServerDown({ text = 'Could not reach the Party Spin server.', actions = [], onAction = () => {} } = {}) {
    const element = popup(`
        <div class="art-popup">
            <img src="assets/UI/server_disconnected.png" alt="Server disconnected">
            <p>${esc(text)}</p>
            <div class="row wrap center-row">${actions.map((a) => `<button class="${a.primary ? 'primary' : ''}" data-popup-act="${a.act}">${esc(a.label)}</button>`).join('')}</div>
        </div>`, { key: 'server-down', className: 'center' });
    element.addEventListener('click', (event) => {
        const act = event.target.closest('[data-popup-act]')?.dataset.popupAct;
        if (act) onAction(act, element);
    });
    return element;
}

export function showRoomNotFound(name = '') {
    popup(`<div class="art-popup"><img src="assets/UI/server_room_not_found.png" alt="Room not found">
        ${name ? `<p>There is no room called “${esc(name)}”.</p>` : ''}
        <button class="primary" data-close>OK</button></div>`, { key: 'not-found', className: 'center', dismissible: true });
}

/**
 * The popups for entering a room view: the server can't be reached before we got in (later a lost
 * connection only shows the banner, so nobody loses their ride), or the room doesn't exist.
 */
export function guardRoom(room, { go, roomName, editServer }) {
    const offs = [
        room.on('status', (status) => {
            if (room.welcomed || status !== 'offline' || document.querySelector('.popup[data-key="server-down"]')) return;
            showServerDown({
                text: 'Could not reach the Party Spin server. Trying again …',
                actions: [{ label: 'Back to the lobby', act: 'lobby', primary: true }, { label: 'Server address', act: 'server' }],
                onAction: (act) => (act === 'lobby' ? go('') : editServer()),
            });
        }),
        room.on('welcome', () => closePopup('server-down')),
        room.on('error', (error) => {
            if (error.code === 'no-room') go('', () => showRoomNotFound(roomName));
        }),
    ];
    return () => offs.forEach((off) => off());
}

/* ---------- Full screen ---------- */

/** The devices button (Bluetooth picture from assets/UI). */
export const devicesButton = () => `<button class="art-icon" data-act="devices" title="Devices">
    <img src="assets/UI/bleBt.png" alt="Devices" draggable="false"></button>`;

export const fullscreenButton = () => `<button class="art-icon" data-act="fullscreen" title="Full screen">
    <img src="assets/UI/${document.fullscreenElement ? 'exitFullScreen' : 'fullScreen'}.png" alt="Full screen" data-fullscreen-image draggable="false"></button>`;

export function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
    for (const image of document.querySelectorAll('[data-fullscreen-image]')) {
        image.src = `assets/UI/${document.fullscreenElement ? 'exitFullScreen' : 'fullScreen'}.png`;
    }
});

/* ---------- Devices ---------- */

/** One line about the bike and the heart rate monitor, for the join menu. */
export function deviceSummary(platform) {
    const bike = platform.bike?.isConnected ? platform.bike.name : null;
    const hr = platform.heartRateMonitor?.isConnected ? platform.heartRateMonitor.name : null;
    return `${bike ? esc(bike) : 'No bike'} · ${hr ? esc(hr) : 'no heart rate'}`;
}

/** The devices pop-up: connect the bike and heart rate monitor (or their simulators). */
export function showDevices(platform, deviceActions, onChange = () => {}) {
    const render = () => {
        const bike = platform.bike?.isConnected ? platform.bike : null;
        const hr = platform.heartRateMonitor?.isConnected ? platform.heartRateMonitor : null;
        const bt = platform.bluetooth.available;
        return `<div class="sheet glass"><h2>Devices</h2>
            <div class="devices">
                <div class="device"><span>${icon('bike')} ${bike ? esc(bike.name) : '<span class="muted">No bike</span>'}</span>${bike ? '<button class="small ghost" data-act="bike-off">Disconnect</button>'
                    : `<span class="row"><button class="small primary" data-act="bike" ${bt ? '' : 'disabled'}>Connect</button><button class="small" data-act="bike-sim">Simulator</button></span>`}</div>
                <div class="device"><span>${icon('heart')} ${hr ? esc(hr.name) : '<span class="muted">No heart rate</span>'}</span>${hr ? '<button class="small ghost" data-act="hr-off">Disconnect</button>'
                    : `<span class="row"><button class="small" data-act="hr" ${bt ? '' : 'disabled'}>Connect</button><button class="small" data-act="hr-sim">Simulator</button></span>`}</div>
                ${bt ? '' : '<p class="muted small-text">Bluetooth needs Chrome or Edge on https:// or localhost.</p>'}
            </div>
            <button class="primary" data-close>Done</button></div>`;
    };
    const element = popup(render(), { key: 'devices', className: 'center', dismissible: true });
    element.addEventListener('click', async (event) => {
        const act = event.target.closest('[data-act]')?.dataset.act;
        if (act && deviceActions[act]) {
            await deviceActions[act]();
            element.innerHTML = render();
            onChange();
        }
    });
    return element;
}
