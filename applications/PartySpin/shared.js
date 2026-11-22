/** Small helpers shared by the lobby, the rider view and the big screen. */
import { local } from '../../core/storage.js';
import { esc, icon } from '../../core/ui.js';
import { deviceId } from './net.js';
import { cardColor, cardIcon } from './rules.js';
import { rideHtml, bindRide } from './session.js';

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
    document.documentElement.dataset.backdrop = kind;   // party.css: no blur over a video
    backdrop.style.setProperty('--backdrop-color', kind === 'color' ? display.color || '#2b1d33' : '');
    const src = kind === 'video' && display.video ? display.video : '';
    if (video.dataset.src !== src) {
        video.dataset.src = src;
        if (src) video.src = src;
        else video.removeAttribute('src');
        video.load();
    }
    video.hidden = !src;
    renderSound();
}

/* ---------- Sound of the background video ---------- */
// The video always starts muted: browsers only play a video by itself when it is silent. A click on
// the button is allowed to turn the sound on.

/** The mute / unmute button (hidden unless the background is a video). */
export const soundButton = () => `<button class="ghost round" data-act="sound" data-sound hidden></button>`;

export function toggleSound() {
    video.muted = !video.muted;
    if (!video.muted && video.paused && video.dataset.playing) video.play().catch(() => {});
    renderSound();
}

function renderSound() {
    const state = video.hidden ? 'none' : video.muted ? 'off' : 'on';
    for (const button of document.querySelectorAll('[data-sound]')) {
        if (button.dataset.sound === state) continue;
        button.dataset.sound = state;
        button.hidden = state === 'none';
        button.innerHTML = icon(state === 'on' ? 'volume' : 'volume-off');
        button.title = state === 'on' ? 'Mute the video' : 'Sound on';
    }
}

/** play(), and if the browser refuses sound without a click: muted after all. */
function playVideo() {
    video.play().catch(() => {
        if (video.muted) return;
        video.muted = true;
        renderSound();
        video.play().catch(() => {});
    });
}

/* Video sync thresholds (seconds of difference between the video and the game clock):
   below DRIFT_OK nothing is done; up to DRIFT_SEEK the video plays a little faster or slower to
   catch up (no stutter); beyond it the video jumps (seeks). After a jump the video gets
   SEEK_REST to load before it may jump again: a big file takes a moment to load at a new place,
   and jumping again while it loads would keep it from ever playing. */
const DRIFT_OK = 0.3;
const DRIFT_SEEK = 4;
const SEEK_REST = 6000;
let lastSeek = 0;

function seekVideo(seconds) {
    lastSeek = performance.now();
    video.playbackRate = 1;
    video.currentTime = seconds;
}

/**
 * Keep the video at the game clock (seconds since the start). `status` is the room's:
 * lobby / paused: the video waits at the clock; running: it plays along with the clock;
 * ended: it plays on by itself to its end (a cool-down after the race), without following the
 * clock. The video never loops: when it is over, it stays on its last picture.
 */
let lastSync = 0;

export function syncVideo(clockMs, status) {
    renderSound();
    // The page was busy (the timer came late): the video played on by itself meanwhile. Don't
    // correct on this look, measure again on the next one.
    const now = performance.now();
    const late = now - lastSync > 1000;
    lastSync = now;
    if (late && video.dataset.src && !video.paused) return;
    const target = clockMs / 1000;
    const done = video.ended || target >= video.duration;   // nothing more to play
    const plays = status === 'running' || status === 'ended';
    if (plays && !video.ended) video.dataset.playing = '1';
    else delete video.dataset.playing;
    if (video.hidden || !video.dataset.src || Number.isNaN(video.duration)) return;
    // Still loading (or jumping): let it be.
    if (video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        if (plays && !done && video.paused) playVideo();
        return;
    }
    const resting = performance.now() - lastSeek < SEEK_REST;
    if (!plays) {
        if (!video.paused) video.pause();
        video.playbackRate = 1;
        if (!resting && Math.abs(video.currentTime - target) > 0.5 && target < video.duration) seekVideo(target);
        return;
    }
    if (status === 'ended') {
        // Plays on from where the game ended. Only a screen that comes in after the end (or was far
        // behind) jumps to the end of the game first.
        video.playbackRate = 1;
        if (video.ended) return;
        if (!resting && video.currentTime < target - DRIFT_SEEK) seekVideo(target);
        if (video.paused) playVideo();
        return;
    }
    if (done) {
        // The game is longer than the video: the video stays on its last picture.
        video.playbackRate = 1;
        return;
    }
    const drift = target - video.currentTime;       // > 0: the video is behind
    if (Math.abs(drift) > DRIFT_SEEK) {
        if (!resting) seekVideo(target + 0.5);       // a little ahead: loading takes a moment
    } else if (Math.abs(drift) > DRIFT_OK) {
        video.playbackRate = drift > 0 ? 1.1 : 0.9;
    } else {
        video.playbackRate = 1;
    }
    if (video.paused) playVideo();
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
        icon: '',       // '' = the profile picture (riders who are logged in), or a file in GUEST_ICONS
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

/* ---------- The rider's picture in Party Spin ---------- */

/** The pictures everyone can pick (guests: only these). Add files to the folder and they show up. */
export const GUEST_ICONS = 'applications/PartySpin/assets/guest_player_icons/';     // from the site's root
const ICON_FILE = /^[A-Za-z0-9_.-]+\.(png|jpe?g|webp|gif)$/i;
let guestIcons = null;

/** The file names in GUEST_ICONS (api/list_guest_icons.php; none without PHP). */
export async function listGuestIcons() {
    if (!guestIcons) {
        guestIcons = fetch('api/list_guest_icons.php', { cache: 'no-cache' })
            .then((response) => response.json())
            .then((data) => (Array.isArray(data.icons) ? data.icons.filter((file) => ICON_FILE.test(file)) : []))
            .catch(() => []);
    }
    return guestIcons;
}

/** The picture a rider shows: {icon (colour), image (a path from the site's root, '' = the default)}. */
export function riderAvatar(platform, choice = gameProfile(platform).icon) {
    const user = platform.isLoggedIn ? platform.user : null;
    if (choice && ICON_FILE.test(choice)) return { icon: user?.icon ?? '', image: GUEST_ICONS + choice };
    const image = user?.icon_image && !user.icon_image.startsWith('data:') ? user.icon_image : '';
    return { icon: user?.icon ?? '', image };
}

/** The rider as sent to the server. */
export function riderInfo(platform) {
    const profile = gameProfile(platform);
    return {
        id: deviceId(),
        name: profile.nickname,
        avatar: riderAvatar(platform, profile.icon),
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
    jumpPlanned: true,  // go to Events for a planned event (Hakoot; later poker, toaster …), and close the drawer
    jumpCards: true,    // go to Events for card events (a card played on you, your flat tyre …)
    jumpBack: true,     // go back to the panel you were on when the event is over
    onlyMine: true,     // riders: Events shows only what affects you
    onlyPlanned: false, // spectators: Events shows only planned events (no cards, no effects)
    drawerHeight: 320,  // px
};

export function viewPrefs() {
    const { autoJump, ...stored } = local.get(VIEW_KEY, {});
    // The old single "Jump to Events" switch counts for both kinds of event.
    const old = autoJump === false ? { jumpPlanned: false, jumpCards: false } : {};
    return { ...VIEW_DEFAULTS, ...old, ...stored };
}
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

/**
 * The devices pop-up: connect the bike and heart rate monitor (or their simulators, unless
 * 'simulators' is off in server/config.php), and – with a bike – the controls of your ride.
 * `ride` (session.js) and `title()` (the name the ride is saved with) are optional.
 */
export function showDevices(platform, deviceActions, onChange = () => {}, { ride = null, title = () => 'Party Spin' } = {}) {
    const render = () => {
        const bike = platform.bike?.isConnected ? platform.bike : null;
        const hr = platform.heartRateMonitor?.isConnected ? platform.heartRateMonitor : null;
        const bt = platform.bluetooth.available;
        const sim = platform.simulatorsAllowed;
        const simButton = (act) => (sim ? `<button class="small" data-act="${act}">Simulator</button>` : '');
        return `<div class="sheet glass devices-sheet"><h2>Devices</h2>
            <div class="devices">
                <div class="device"><span>${icon('bike')} ${bike ? esc(bike.name) : '<span class="muted">No bike</span>'}</span>${bike ? '<button class="small ghost" data-act="bike-off">Disconnect</button>'
                    : `<span class="row"><button class="small primary" data-act="bike" ${bt ? '' : 'disabled'}>Connect</button>${simButton('bike-sim')}</span>`}</div>
                <div class="device"><span>${icon('heart')} ${hr ? esc(hr.name) : '<span class="muted">No heart rate</span>'}</span>${hr ? '<button class="small ghost" data-act="hr-off">Disconnect</button>'
                    : `<span class="row"><button class="small" data-act="hr" ${bt ? '' : 'disabled'}>Connect</button>${simButton('hr-sim')}</span>`}</div>
                ${bt ? '' : '<p class="muted small-text">Bluetooth needs Chrome or Edge on https:// or localhost.</p>'}
            </div>
            ${ride && (bike || ride.unsaved) ? rideHtml(ride, { loggedIn: platform.isLoggedIn }) : ''}
            <button class="primary" data-close>Done</button></div>`;
    };
    const element = popup(render(), { key: 'devices', className: 'center', dismissible: true });
    const redraw = () => { element.innerHTML = render(); onChange(); };
    element.addEventListener('click', async (event) => {
        const act = event.target.closest('[data-act]')?.dataset.act;
        if (act && deviceActions[act]) {
            await deviceActions[act]();
            redraw();
        }
    });
    if (ride) bindRide(element, ride, { platform, title, render: redraw });
    return element;
}
