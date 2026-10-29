/**
 * The hub (home screen).
 *
 * - Renders the application tiles of the active user, the round shortcuts, clock, Bluetooth status
 *   and logged-in profiles.
 * - Hosts every page and application in an overlay frame so Bluetooth devices stay connected.
 * - Translates Zwift Click v2 buttons into navigation.
 */
import { getPlatform } from './core/platform.js';
import { BASE_URL } from './core/storage.js';
import {
    icon, esc, avatar, toast, modal, formatNumber, formatSpeed, appArt, appColors,
} from './core/ui.js';
import { createNavigation, sendNavigation, CONTROLLER_ACTIONS } from './core/navigation.js';

const platform = await getPlatform();

const $ = (selector) => document.querySelector(selector);
const tilesElement = $('#tiles');
const titleElement = $('#selected-title');
const overlay = $('#overlay');
let frame = null; // a fresh <iframe> per page/application, see showOverlay()
const homeFab = $('#home-fab');

const SHORTCUTS = [
    { id: 'news', label: 'News', icon: 'news', color: '#e0393e', action: () => toast('News is coming soon.') },
    { id: 'browse', label: 'Browse', icon: 'browse', color: '#f08a24', action: () => openPage('browse/') },
    { id: 'activities', label: 'Activities', icon: 'activities', color: '#3aa655', action: () => openPage('activities/') },
    { id: 'devices', label: 'Devices', icon: 'bike', color: '#00b4d8', action: () => openDevices() },
    { id: 'settings', label: 'Settings', icon: 'settings', color: '#7a7a7a', action: () => openPage('settings/') },
    { id: 'info', label: 'Info', icon: 'info', color: '#2f7de1', action: () => openPage('info/') },
];

/* =====================================================================================
 * Tiles
 * ===================================================================================== */

const STATUS_LABEL = { 'in-development': 'In development', concept: 'Concept' };

function renderTiles(focusId = null) {
    const apps = platform.homeApps().map((id) => platform.app(id));
    tilesElement.innerHTML = apps.map((app) => {
        const badge = STATUS_LABEL[app.status] ? `<span class="tile-badge">${STATUS_LABEL[app.status]}</span>` : '';
        return `<button class="tile" role="listitem" data-id="${esc(app.id)}" aria-label="${esc(app.title)}"
                    style="${appColors(app)}">
                    ${appArt(app)}<span class="tile-name">${esc(app.title)}</span>${badge}
                </button>`;
    }).join('') + `
        <button class="tile all-apps" role="listitem" data-all aria-label="All applications">
            ${icon('apps')}<span>All applications</span>
        </button>`;

    if (!apps.length) titleElement.textContent = 'Your home screen is empty – add applications from Browse.';
    const target = focusId && tilesElement.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
    if (target) target.focus();
}

tilesElement.addEventListener('click', (event) => {
    const tile = event.target.closest('.tile');
    if (!tile) return;
    if (tile.dataset.all !== undefined) openPage('browse/?tab=applications');
    else launch(tile.dataset.id);
});

// The title above the row follows focus and hover, like on a console.
let lastTileId = null; // the tile to return to (after closing a page, or coming back up from the shortcuts)
const showTitle = (tile) => {
    if (!tile) return;
    if (tile.dataset.id) lastTileId = tile.dataset.id;
    titleElement.textContent = tile.dataset.all !== undefined ? 'All applications' : platform.app(tile.dataset.id)?.title ?? '';
};
tilesElement.addEventListener('focusin', (event) => showTitle(event.target.closest('.tile')));
tilesElement.addEventListener('mouseover', (event) => showTitle(event.target.closest('.tile')));
tilesElement.addEventListener('mouseleave', () => showTitle(tilesElement.querySelector('.tile.nav-focus') ?? tilesElement.querySelector(`.tile[data-id="${CSS.escape(lastTileId ?? '')}"]`)));

/* ---------- Right-click (or Y) options menu ---------- */

let contextMenu = null;

function closeContextMenu() {
    if (!contextMenu) return false;
    const { element, returnFocus } = contextMenu;
    element.remove();
    contextMenu = null;
    returnFocus?.focus();
    return true;
}

function openContextMenu(tile, x, y) {
    closeContextMenu();
    const id = tile.dataset.id;
    if (!id) return;
    const app = platform.app(id);
    const ids = platform.homeApps();
    const index = ids.indexOf(id);

    const element = document.createElement('div');
    element.className = 'context-menu';
    element.setAttribute('role', 'menu');
    element.dataset.navTrap = '';
    element.innerHTML = `
        <button role="menuitem" data-action="open">${icon('bolt')} Start</button>
        <hr>
        <button role="menuitem" data-action="left" ${index <= 0 ? 'disabled' : ''}>Move left</button>
        <button role="menuitem" data-action="right" ${index >= ids.length - 1 ? 'disabled' : ''}>Move right</button>
        <button role="menuitem" data-action="remove">Remove from Home</button>
        <hr>
        <button role="menuitem" data-action="about">${icon('info')} About ${esc(app.title)}</button>`;
    document.body.append(element);

    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.min(x, innerWidth - rect.width - 8)}px`;
    element.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
    contextMenu = { element, returnFocus: tile };
    element.querySelector('button:not(:disabled)').focus();

    element.addEventListener('click', async (event) => {
        const action = event.target.closest('button')?.dataset.action;
        if (!action) return;
        closeContextMenu();
        if (action === 'open') launch(id);
        if (action === 'about') showAbout(app);
        if (action === 'left' || action === 'right') {
            const next = [...ids];
            const to = action === 'left' ? index - 1 : index + 1;
            [next[index], next[to]] = [next[to], next[index]];
            await platform.setHomeApps(next);
            renderTiles(id);
        }
        if (action === 'remove') {
            await platform.removeFromHome(id);
            renderTiles();
            tilesElement.querySelector('.tile')?.focus();
            toast(`${app.title} was removed. You can add it back from Browse.`);
        }
    });
}

tilesElement.addEventListener('contextmenu', (event) => {
    const tile = event.target.closest('.tile[data-id]');
    if (!tile) return;
    event.preventDefault();
    openContextMenu(tile, event.clientX, event.clientY);
});

// Long-press on touch screens opens the same menu.
let pressTimer = null;
tilesElement.addEventListener('touchstart', (event) => {
    const tile = event.target.closest('.tile[data-id]');
    if (!tile) return;
    const touch = event.touches[0];
    pressTimer = setTimeout(() => openContextMenu(tile, touch.clientX, touch.clientY), 550);
}, { passive: true });
for (const type of ['touchend', 'touchmove', 'touchcancel']) {
    tilesElement.addEventListener(type, () => clearTimeout(pressTimer), { passive: true });
}

document.addEventListener('pointerdown', (event) => {
    if (contextMenu && !contextMenu.element.contains(event.target)) closeContextMenu();
});

function openContextMenuForFocus() {
    const tile = document.activeElement?.closest?.('.tile[data-id]');
    if (!tile) return;
    const rect = tile.getBoundingClientRect();
    openContextMenu(tile, rect.left + 20, rect.top + 20);
}

function showAbout(app) {
    const requires = (app.requires ?? []).map((r) => ({ bike: 'a bike or trainer', heartRate: 'a heart-rate monitor', controller: 'a Zwift Click v2 controller' }[r] ?? r));
    modal({
        title: app.title,
        body: `<p>${esc(app.description ?? '')}</p>
               ${requires.length ? `<p class="muted">Uses ${esc(requires.join(', '))}.</p>` : ''}
               ${STATUS_LABEL[app.status] ? `<p class="muted">Status: ${STATUS_LABEL[app.status]}</p>` : ''}`,
        actions: [{ label: 'Close' }, { label: 'Start', primary: true, onClick: () => { launch(app.id); } }],
    });
}

/* =====================================================================================
 * Shortcuts, profiles, clock, Bluetooth
 * ===================================================================================== */

$('#shortcuts').innerHTML = SHORTCUTS.map((s) => `
    <button class="shortcut" data-shortcut="${s.id}" style="--shortcut-color:${s.color}">
        <span class="circle">${icon(s.icon)}</span><span>${s.label}</span>
    </button>`).join('');
$('#shortcuts').addEventListener('click', (event) => {
    const id = event.target.closest('[data-shortcut]')?.dataset.shortcut;
    SHORTCUTS.find((s) => s.id === id)?.action();
});

function renderProfiles() {
    const host = $('#profiles');
    const user = platform.user;
    if (platform.backend.mode === 'local') {
        host.innerHTML = `<button class="profile-button active" data-profile="me" title="Local profile (local mode)">${avatar(user)}</button>`;
        return;
    }
    const others = platform.accounts.filter((a) => a.username !== user?.username);
    host.innerHTML = `
        ${others.map((a) => `<button class="profile-button inactive" data-switch="${esc(a.username)}" title="Switch to ${esc(a.username)}">${avatar(platform.knownProfile(a.username))}</button>`).join('')}
        ${user
            ? `<button class="profile-button active" data-profile="me" title="${esc(user.username)}">${avatar(user)}</button>`
            : `<button class="login-pill" data-login>${icon('user')} Log in</button>`}`;
}

$('#profiles').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.login !== undefined) openPage('logIn/');
    if (button.dataset.switch) {
        await platform.switchUser(button.dataset.switch);
        toast(`Hi ${platform.user?.nickname || platform.user?.username || button.dataset.switch}!`);
    }
    if (button.dataset.profile) openProfileMenu(button);
});

function openProfileMenu(anchor) {
    closeContextMenu();
    const user = platform.user;
    const local = platform.backend.mode === 'local';
    const element = document.createElement('div');
    element.className = 'context-menu';
    element.setAttribute('role', 'menu');
    element.dataset.navTrap = '';
    element.innerHTML = `
        <button role="menuitem" data-action="profile">${icon('user')} ${esc(user?.nickname || user?.username || 'Profile')}</button>
        <button role="menuitem" data-action="settings">${icon('settings')} Settings</button>
        <hr>
        <button role="menuitem" data-action="add">${icon('plus')} ${local ? 'Log in (needs the online server)' : 'Add another rider'}</button>
        ${local ? '' : `<button role="menuitem" data-action="logout">${icon('logout')} Log out on this device</button>`}`;
    document.body.append(element);
    const rect = anchor.getBoundingClientRect();
    const menuRect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, rect.right - menuRect.width)}px`;
    element.style.top = `${rect.bottom + 8}px`;
    contextMenu = { element, returnFocus: anchor };
    element.querySelector('button').focus();
    element.addEventListener('click', async (event) => {
        const action = event.target.closest('button')?.dataset.action;
        if (!action) return;
        closeContextMenu();
        if (action === 'profile') openPage('profile/');
        if (action === 'settings') openPage('settings/');
        if (action === 'add') openPage('logIn/');
        if (action === 'logout') {
            const name = user.nickname || user.username;
            await platform.logout();
            toast(`${name} was logged out on this device.`);
        }
    });
}

function renderClock() {
    const twelve = platform.settings.get('clock') === '12h';
    $('#clock').textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: twelve }).format(new Date());
}
setInterval(renderClock, 5000);

function anyDeviceConnected() {
    return !!(platform.bike?.isConnected || platform.heartRateMonitor?.isConnected
        || platform.controller?.devices.some((d) => d.connected));
}

function renderBluetoothStatus() {
    const button = $('#bluetooth-status');
    const { available, enabled } = platform.bluetooth;
    button.classList.toggle('unavailable', !available);
    button.classList.toggle('warn', !available || enabled === false);
    button.classList.toggle('connected', anyDeviceConnected());
    button.title = !available ? 'Bluetooth is not available in this browser'
        : enabled === false ? 'Bluetooth seems to be turned off'
        : anyDeviceConnected() ? 'Devices connected' : 'Bluetooth is available – connect your devices';
}

$('#bluetooth-status').addEventListener('click', () => {
    const { available, enabled } = platform.bluetooth;
    if (!available) {
        const insecure = !window.isSecureContext;
        modal({
            title: 'Bluetooth is not available',
            body: `<p>This browser can't talk to Bluetooth devices, so your bike, heart-rate monitor and controller can't connect.</p>
                ${insecure ? '<div class="notice warning">The page is not loaded over https:// (or http://localhost). Browsers only allow Bluetooth on secure pages.</div>' : ''}
                <p><strong>What works:</strong></p>
                <ul>
                    <li>Chrome, Edge or Opera on Windows, macOS, Linux, ChromeOS and Android.</li>
                    <li>On iPhone and iPad: the <em>Bluefy</em> browser.</li>
                    <li>Linux: you may need to enable <code>chrome://flags/#enable-web-bluetooth</code>.</li>
                </ul>
                <p class="muted">Firefox and Safari do not support Web Bluetooth. You can still explore everything with the simulated bike in Devices.</p>`,
            actions: [{ label: 'Open devices', onClick: () => { openDevices(); } }, { label: 'OK', primary: true }],
        });
    } else if (enabled === false) {
        modal({
            title: 'Bluetooth seems to be off',
            body: '<p>Your browser supports Bluetooth, but no Bluetooth adapter is available right now. Turn Bluetooth on in your system settings and try again.</p>',
            actions: [{ label: 'Open devices', primary: true, onClick: () => { openDevices(); } }],
        });
    } else {
        openDevices();
    }
});

/* ---------- Live values in the bottom bar ---------- */

function renderLive() {
    const bike = platform.bike;
    const hrm = platform.heartRateMonitor;
    const parts = [];
    if (bike?.isConnected) {
        parts.push(`<span class="metric" title="${esc(bike.name)}">${icon('bolt')}${formatNumber(bike.power, 'W')}</span>`);
        parts.push(`<span class="metric">${formatNumber(bike.cadence, 'rpm')}</span>`);
        parts.push(`<span class="metric">${formatSpeed(bike.speed)}</span>`);
    }
    const heartRate = hrm?.isConnected ? hrm.heartRate : bike?.isConnected ? bike.heartRate : null;
    if (hrm?.isConnected || heartRate) parts.push(`<span class="metric hr">${icon('heart')}${formatNumber(heartRate, 'bpm')}</span>`);
    const controllers = platform.controller?.devices.filter((d) => d.connected).length ?? 0;
    if (controllers) parts.push(`<span class="metric">${icon('gamepad')}${controllers}</span>`);

    $('#live').innerHTML = parts.length
        ? parts.join('')
        : `<button class="small" data-connect>${icon('bluetooth')} Connect your bike</button>`;
}
$('#live').addEventListener('click', (event) => {
    if (event.target.closest('[data-connect]')) openDevices();
});
setInterval(() => { if (overlay.classList.contains('hidden')) renderLive(); }, 1000);

/* =====================================================================================
 * Devices dialog
 * ===================================================================================== */

let devicesDialog = null;

function openDevices() {
    // From the home screen the dialog gets its own history entry (#devices); over a page it just opens.
    if (!overlayMode && location.hash !== '#devices') navigate('#devices');
    else showDevicesDialog();
}

function showDevicesDialog() {
    if (devicesDialog) return;
    const body = document.createElement('div');
    body.className = 'device-list';
    const { dialog, closed } = modal({ title: 'Devices', body, actions: [{ label: 'Done', primary: true }] });
    devicesDialog = { dialog, body };
    renderDevices();
    platform.loadModules().catch(() => {}).finally(renderDevices);
    const timer = setInterval(() => renderDevices(true), 1000);
    closed.then(() => {
        clearInterval(timer);
        devicesDialog = null;
        if (location.hash === '#devices') leave();
    });
}

function deviceState(device) {
    if (!device) return { text: 'Not connected', ok: false };
    if (device.isConnecting) return { text: 'Connecting…', ok: false };
    if (device.isConnected) return { text: `Connected – ${device.name}${device.batteryLevel != null ? ` · battery ${device.batteryLevel}%` : ''}`, ok: true };
    return { text: 'Not connected', ok: false };
}

function renderDevices(liveOnly = false) {
    if (!devicesDialog) return;
    const { body } = devicesDialog;
    const bike = platform.bike;
    const hrm = platform.heartRateMonitor;
    const liveBike = bike?.isConnected
        ? `${formatNumber(bike.power, 'W')} · ${formatNumber(bike.cadence, 'rpm')} · ${formatSpeed(bike.speed)}` : '';
    const liveHr = hrm?.isConnected ? formatNumber(hrm.heartRate, 'bpm') : '';

    if (liveOnly) {
        // Update only the numbers so buttons keep focus.
        const bikeLive = body.querySelector('[data-live="bike"]');
        const hrLive = body.querySelector('[data-live="hr"]');
        if (bikeLive) bikeLive.textContent = liveBike;
        if (hrLive) hrLive.textContent = liveHr;
        return;
    }

    const btReady = platform.bluetooth.available && !platform.modulesError;
    const bikeState = deviceState(bike);
    const hrState = deviceState(hrm);
    const controllers = platform.controller?.devices ?? [];
    const noBluetooth = !platform.bluetooth.available
        ? `<div class="notice warning">${icon('bluetooth')}<div>Bluetooth is not available in this browser – use the simulator, or open the app in Chrome, Edge or Opera.</div></div>` : '';
    const modulesError = platform.modulesError ? `<div class="notice error">${esc(platform.modulesError)}</div>` : '';

    body.innerHTML = `${modulesError}${noBluetooth}
        <section class="device-card ${bikeState.ok ? 'connected' : ''}">
            <span class="device-icon">${icon('bike')}</span>
            <span class="device-title">Bike / trainer</span>
            <span class="device-state ${bikeState.ok ? 'ok' : ''}">${esc(bikeState.text)}</span>
            <span class="device-live" data-live="bike">${liveBike}</span>
            <span></span>
            <div class="device-actions">
                ${bike?.isConnected
                    ? '<button class="small" data-device="bike-off">Disconnect</button>'
                    : `<button class="small primary" data-device="bike" ${btReady ? '' : 'disabled'}>Connect</button>
                       <button class="small" data-device="bike-sim" ${platform.modulesError ? 'disabled' : ''}>Simulator</button>`}
            </div>
        </section>
        <section class="device-card ${hrState.ok ? 'connected' : ''}">
            <span class="device-icon">${icon('heart')}</span>
            <span class="device-title">Heart-rate monitor</span>
            <span class="device-state ${hrState.ok ? 'ok' : ''}">${esc(hrState.text)}</span>
            <span class="device-live" data-live="hr">${liveHr}</span>
            <span></span>
            <div class="device-actions">
                ${hrm?.isConnected
                    ? '<button class="small" data-device="hr-off">Disconnect</button>'
                    : `<button class="small primary" data-device="hr" ${btReady ? '' : 'disabled'}>Connect</button>
                       <button class="small" data-device="hr-sim" ${platform.modulesError ? 'disabled' : ''}>Simulator</button>`}
            </div>
        </section>
        <section class="device-card ${controllers.some((d) => d.connected) ? 'connected' : ''}">
            <span class="device-icon">${icon('gamepad')}</span>
            <span class="device-title">Zwift Click v2 / Ride controller</span>
            <span class="device-state ${controllers.length ? 'ok' : ''}">${controllers.length
                ? controllers.map((d) => `${esc(d.name)}${d.connected ? '' : ' (disconnected)'}${d.battery != null ? ` · ${d.battery}%` : ''}`).join('<br>')
                : 'Not connected – the Click v2 has two units, add each one.'}
                <br><small>Right shifter: next / previous · Left shifter: row down / up · A select · B back · Y options</small></span>
            <span></span>
            <span></span>
            <div class="device-actions">
                <button class="small ${controllers.length ? '' : 'primary'}" data-device="controller" ${btReady ? '' : 'disabled'}>${icon('plus')} Add unit</button>
            </div>
        </section>
        <p class="muted">Tip: connect the devices once here – every game uses them without asking again.</p>`;
}

document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-device]');
    if (!button || !devicesDialog) return;
    const actions = {
        bike: () => platform.connectBike(),
        'bike-sim': () => platform.connectBike({ simulated: true }),
        'bike-off': () => platform.disconnectBike(),
        hr: () => platform.connectHeartRate(),
        'hr-sim': () => platform.connectHeartRate({ simulated: true }),
        'hr-off': () => platform.disconnectHeartRate(),
        controller: () => platform.addController(),
    };
    try {
        await actions[button.dataset.device]?.();
    } catch (error) {
        // NotFoundError = the user closed the browser's device chooser.
        if (error?.name !== 'NotFoundError') toast(`Could not connect: ${error?.message ?? error}`);
    }
    renderDevices();
});

/* =====================================================================================
 * Overlay: pages and applications
 * ===================================================================================== */

let overlayMode = null; // 'page' | 'app' | null
let pushedHistory = false; // did the hub add the current history entry?

function navigate(hash) {
    pushedHistory = true;
    location.hash = hash;
}

/** Go back to the plain home screen without ever leaving the site (also for deep links). */
function leave() {
    if (pushedHistory) {
        pushedHistory = false;
        history.back();
    } else {
        history.replaceState(null, '', location.pathname + location.search);
        route();
    }
}

function isSafePath(path) {
    try {
        const url = new URL(path, BASE_URL);
        return url.origin === location.origin && url.href.startsWith(BASE_URL.href);
    } catch {
        return false;
    }
}

function showOverlay(url, mode) {
    closeContextMenu();
    overlayMode = mode;
    overlay.classList.remove('hidden');
    homeFab.classList.toggle('hidden', mode !== 'app');
    document.querySelector('.hub-top').inert = true;
    document.querySelector('.hub-main').inert = true;
    document.querySelector('.hub-bottom').inert = true;
    if (frame?.dataset.url !== url) {
        // A new frame each time: changing an iframe's src would add entries to the browser
        // history, and history.back() would then navigate the frame instead of the hub.
        frame?.remove();
        frame = document.createElement('iframe');
        frame.title = mode === 'app' ? 'Application' : 'Page';
        frame.allow = 'bluetooth; fullscreen; gamepad; autoplay';
        frame.dataset.url = url;
        frame.src = url;
        overlay.prepend(frame);
    }
    frame.focus();
}

function hideOverlay() {
    if (!overlayMode) return;
    overlayMode = null;
    overlay.classList.add('hidden');
    frame?.remove();
    frame = null;
    for (const selector of ['.hub-top', '.hub-main', '.hub-bottom']) document.querySelector(selector).inert = false;
    renderAll();
    (tilesElement.querySelector(`.tile[data-id="${CSS.escape(lastTileId ?? '')}"]`) ?? tilesElement.querySelector('.tile'))?.focus();
}

function openPage(path) {
    if (!isSafePath(path)) return;
    navigate(`#/${path}`);
}

async function launch(id) {
    const app = platform.app(id);
    if (!app) return;
    if (app.status === 'concept') {
        modal({
            title: app.title,
            body: `<p>${esc(app.description ?? '')}</p><p class="muted">This application is only an idea so far. Want to build it? The project is open source – see Info.</p>`,
        });
        return;
    }
    // Check that the application exists before opening it.
    const exists = await fetch(new URL(app.entry, BASE_URL), { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
    if (!exists) {
        modal({ title: app.title, body: `<p>${esc(app.title)} is still under construction. Check back soon!</p>` });
        return;
    }
    navigate(`#/app/${encodeURIComponent(id)}`);
}

function route() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash !== 'devices' && devicesDialog) devicesDialog.dialog.close();
    if (hash.startsWith('/app/')) {
        const app = platform.app(hash.slice(5));
        if (app) return showOverlay(new URL(app.entry, BASE_URL).href, 'app');
    } else if (hash.startsWith('/') && hash.length > 1 && isSafePath(hash.slice(1))) {
        return showOverlay(new URL(hash.slice(1), BASE_URL).href, 'page');
    }
    hideOverlay();
    if (hash === 'devices') showDevicesDialog();
}

window.addEventListener('hashchange', route);
homeFab.addEventListener('click', () => platform.home());

/** The API pages and applications use through platform.shell. */
platform.shell = {
    openPage,
    openApp: launch,
    openDevices,
    toast: (text) => toast(text),
    close() {
        if (location.hash) leave();
        else hideOverlay();
    },
};

/* =====================================================================================
 * Keyboard and Zwift Click v2 navigation
 * ===================================================================================== */

const navigation = createNavigation(document, {
    onBack: () => {
        if (closeContextMenu()) return;
        if (overlayMode) platform.home();
    },
    onOptions: (element) => {
        if (element.closest('.tile[data-id]')) openContextMenuForFocus();
    },
    initial: () => tilesElement.querySelector(`.tile[data-id="${CSS.escape(lastTileId ?? '')}"]`) ?? tilesElement.querySelector('.tile'),
});

/** Send an action to whatever is on screen: an open page, or the hub itself (incl. its dialogs). */
function dispatchAction(action) {
    const hubDialog = document.querySelector('dialog[open]');
    if (overlayMode === 'page' && frame?.contentWindow && !hubDialog) sendNavigation(frame.contentWindow, action);
    else navigation.perform(action);
}

const REPEATING = new Set(['next', 'prev', 'left', 'right', 'up', 'down']);
const REPEAT_DELAY = 450; // ms before a held button starts repeating
const REPEAT_RATE = 110;  // ms between repeats
const heldSince = new Map();

function controllerLoop(now) {
    const controller = platform.controller;
    // While an application runs it reads the controller itself (update() must have one caller).
    if (controller && overlayMode !== 'app') {
        controller.update();
        for (const [button, action] of Object.entries(CONTROLLER_ACTIONS)) {
            // pressCount keeps fast double taps that happen within one frame.
            const presses = controller.pressCount(button);
            for (let i = 0; i < presses; i++) dispatchAction(action);
            if (presses) heldSince.set(button, now + REPEAT_DELAY);
            if (!controller.isDown(button)) heldSince.delete(button);
            else if (REPEATING.has(action) && heldSince.has(button) && now >= heldSince.get(button)) {
                dispatchAction(action);
                heldSince.set(button, now + REPEAT_RATE);
            }
        }
    }
    requestAnimationFrame(controllerLoop);
}
requestAnimationFrame(controllerLoop);

/* =====================================================================================
 * Start
 * ===================================================================================== */

function renderAll() {
    renderTiles(document.activeElement?.closest?.('.tile')?.dataset.id);
    renderProfiles();
    renderClock();
    renderBluetoothStatus();
    renderLive();
}

platform.on('userchange', () => renderAll());
platform.on('homechange', () => { if (!overlayMode) renderTiles(document.activeElement?.closest?.('.tile')?.dataset.id); });
platform.on('devicechange', () => { renderBluetoothStatus(); renderLive(); renderDevices(); });
platform.on('bluetoothchange', renderBluetoothStatus);
platform.settings.addEventListener('change', renderAll);

renderAll();
const firstTile = tilesElement.querySelector('.tile');
firstTile?.focus({ preventScroll: true });
showTitle(firstTile);
route();

if (platform.backend.message) console.warn(platform.backend.message);
