/**
 * Party Spin – a spinning party game: ride, score points, play power-up cards on each other and
 * answer Hakoot questions. One computer shows the big screen, everyone else rides.
 *
 * The page has two views, chosen by the address:
 *   (none)          the lobby: join, create, spectate (lobby.js)
 *   #ride/NAME      riding in the room called NAME (room.js, as a rider)
 *   #screen/NAME    spectating the room, e.g. on a big screen (room.js, as a spectator)
 * With the room's key (or as its owner) you are a moderator in both.
 *
 * The lobby talks to the PHP scripts in api/ (rooms are made and stored there). The rooms
 * themselves run on the Party Spin server (server/partyspin_server.py) over a WebSocket: when it
 * can't be reached, or the room doesn't exist, you hear about it when you try to enter a room.
 */
import { getPlatform } from '../../core/platform.js';
import { esc, toast, modal } from '../../core/ui.js';
import { serverUrl, saveServerUrl, resolveDevice } from './net.js';
import { $, setBackdrop, closeAllPopups, toggleFullscreen } from './shared.js';
import { startLobby } from './lobby.js';
import { startRoom } from './room.js';

const platform = await getPlatform();
let view = $('#view');
let stopView = null;
let afterRoute = null;

/** Go to a view. `after` runs once the view is drawn (e.g. a pop-up on the lobby). */
function go(hash, after = null) {
    afterRoute = after;
    if (location.hash === hash || (!hash && !location.hash)) route();
    else location.hash = hash;
}

async function device(action) {
    try {
        await action();
    } catch (error) {
        if (error?.name !== 'NotFoundError') toast(error.message ?? String(error));
    }
}

const deviceActions = {
    bike: () => device(() => platform.connectBike()),
    'bike-sim': () => device(() => platform.connectBike({ simulated: true })),
    'bike-off': () => device(async () => platform.disconnectBike()),
    hr: () => device(() => platform.connectHeartRate()),
    'hr-sim': () => device(() => platform.connectHeartRate({ simulated: true })),
    'hr-off': () => device(async () => platform.disconnectHeartRate()),
};

function route() {
    stopView?.();
    stopView = null;
    closeAllPopups();
    setBackdrop();
    // A fresh element: the old view's click listeners go with it.
    const fresh = view.cloneNode(false);
    view.replaceWith(fresh);
    view = fresh;
    const context = { platform, view, go, deviceActions, editServer };

    const [mode, encoded] = location.hash.slice(1).split('/');
    const room = decodeURIComponent(encoded ?? '');
    if ((mode === 'ride' || mode === 'screen') && room) stopView = startRoom(context, room, mode === 'ride' ? 'player' : 'screen');
    else stopView = startLobby(context);

    const after = afterRoute;
    afterRoute = null;
    after?.();
}

window.addEventListener('hashchange', () => route());

async function editServer() {
    const body = document.createElement('div');
    body.innerHTML = `<label class="field"><span>Party Spin server address</span>
        <input name="url" value="${esc(serverUrl())}" spellcheck="false"></label>
        <p class="muted">At home this is usually <code>ws://&lt;computer's address&gt;:8765</code>. Behind nginx with HTTPS: <code>wss://&lt;site&gt;/partyspin/ws</code>. Leave empty for the default.</p>`;
    const answer = await modal({
        title: 'Server',
        body,
        actions: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: 'save' }],
    }).closed;
    if (answer === 'save') {
        saveServerUrl(body.querySelector('input').value);
        location.reload();
    }
}

// F toggles full screen everywhere (except while typing).
window.addEventListener('keydown', (event) => {
    if (event.target.matches?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
    if (event.key === 'f' || event.key === 'F') toggleFullscreen();
});

// The rider id, before the first view (a room link needs it straight away).
await resolveDevice();
route();
