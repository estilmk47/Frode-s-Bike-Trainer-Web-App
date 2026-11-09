/**
 * The lobby: three big buttons, Join, Create and Spectate, as in the original game. The one you pick
 * opens below itself and the other two shrink. Room names are found without caring about upper case
 * or spaces ("Friday Spin" = "fridayspin").
 *
 *   Join      a room name and your profile (nickname, FTP, weight and difficulty come from the hub
 *             user and can be changed for this app only) and your devices. Ghost mode is set in the
 *             room (Profile). Riders are never moderators: moderators spectate.
 *   Create    log in with an authentication key from the server, then manage your rooms: create,
 *             edit and delete, each with its planned events
 *   Spectate  a room name, and its room key to become a moderator
 *
 * Everything here goes through the PHP scripts in api/ (the game server is not needed to make rooms).
 * "Server disconnected" and "room not found" are only shown when you try to enter a room.
 */
import { DIFFICULTIES } from '../../core/settings.js';
import { avatar, esc, icon, modal, toast } from '../../core/ui.js';
import { EVENT_TYPES, editEvent, eventTitle, newEvent } from './event-editor.js';
import { api, authKey, deviceId, resolveDevice, setAuthKey } from './net.js';
import { MODES, formatClock } from './rules.js';
import {
    $, gameProfile, hubProfile, saveGameProfile, clearGameProfile, hasGameProfile, rememberRoomKey,
    showServerDown, showRoomNotFound, fullscreenButton, devicesButton, toggleFullscreen, showDevices, deviceSummary,
} from './shared.js';
import { local } from '../../core/storage.js';

const LAST_ROOM_KEY = 'partyspin.lastRoom';
const MENUS = [
    { id: 'join', art: 'join_room', label: 'Join' },
    { id: 'create', art: 'create_room', label: 'Create' },
    { id: 'spectate', art: 'spectate_room', label: 'Spectate' },
];
const STATUS_LABELS = { lobby: 'Waiting', running: 'Live', paused: 'Paused', ended: 'Finished' };

let openMenu = null;        // stays open when you come back to the lobby
let account = null;         // { label, rooms } while logged in with an authentication key

const roomPath = (name) => encodeURIComponent(name);

export function startLobby({ platform, view, go, deviceActions, editServer }) {
    let editing = null;     // the room being edited: { room?, schedule } (no room: a new one)
    let accountError = null;
    let stopped = false;
    const stops = [];

    view.className = 'view lobby';
    view.innerHTML = `
        <header class="lobby-head">
            <div class="head-bar">
                <button class="ghost round" data-act="home" title="Back to Frode's Bike Trainer">${icon('home')}</button>
                <div class="head-tools">
                    ${devicesButton()}
                    ${fullscreenButton()}
                    <button class="ghost round" data-act="server" title="Server address">${icon('settings')}</button>
                </div>
            </div>
            <h1 class="title"><span class="t1">Party</span><span class="t2">Spin</span></h1>
        </header>
        <div class="menu">${MENUS.map((menu) => `
            <section class="menu-item" data-menu="${menu.id}">
                <button type="button" class="menu-head" data-toggle="${menu.id}" aria-expanded="false">
                    <img src="assets/UI/${menu.art}.png" data-art="${menu.art}" alt="${menu.label}" draggable="false"></button>
                <div class="menu-body"><div class="menu-clip"><div class="menu-content glass" data-body="${menu.id}"></div></div></div>
            </section>`).join('')}
        </div>`;

    /* ---------- the three menus ---------- */

    function setOpen(id) {
        openMenu = id;
        $('.menu', view).classList.toggle('has-open', !!id);
        for (const item of view.querySelectorAll('.menu-item')) {
            const open = item.dataset.menu === id;
            item.classList.toggle('open', open);
            $('.menu-head', item).setAttribute('aria-expanded', open);
            $('.menu-body', item).inert = !open;
        }
    }

    const connectButton = `<button class="art-button" type="submit" title="Connect">
        <img src="assets/UI/connect.png" data-art="connect" alt="Connect" draggable="false"></button>`;

    /** Trouble when entering a room: the picture for it, or the message in the form. */
    function entryFailed(form, error, name) {
        if (error.code === 'no-room') showRoomNotFound(name);
        else if (error.code === 'server-down') showServerDown({ actions: [{ label: 'OK', act: 'close', primary: true }], onAction: (_, popup) => popup.close() });
        else showError(form, error.message);
    }

    /* ---------- Join ---------- */

    function renderJoin() {
        const profile = gameProfile(platform);
        const user = platform.user;
        const difficulty = DIFFICULTIES.map((d) => `<option value="${d.value}" ${String(d.value) === String(profile.difficulty) ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
        $('[data-body="join"]', view).innerHTML = `
            <form data-form="join" class="stack">
                <label class="field"><span>Room name</span>
                    <input name="room" class="room-input" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(local.get(LAST_ROOM_KEY, ''))}" required></label>
                <div class="profile">
                    <div class="row profile-head">
                        ${avatar({ username: deviceId() ?? '', icon: user?.icon, icon_image: user?.icon_image }, 'large')}
                        <label class="field grow"><span>Nickname</span><input name="nickname" maxlength="40" value="${esc(profile.nickname)}" required></label>
                    </div>
                    <div class="row wrap">
                        <label class="field"><span>FTP (W)</span><input name="ftp" type="number" min="30" max="999" value="${profile.ftp}" required></label>
                        <label class="field"><span>Weight (kg)</span><input name="weight" type="number" min="20" max="300" step="0.1" value="${profile.weight}" required></label>
                        <label class="field"><span>Difficulty</span><select name="difficulty">${difficulty}</select></label>
                    </div>
                    <p class="muted small-text" data-profile-note></p>
                </div>
                <div class="device"><span>${icon('bike')} <span data-devices>${deviceSummary(platform)}</span></span>
                    <button type="button" class="small" data-act="devices">${icon('bluetooth')} Devices</button></div>
                <p class="form-error" data-error hidden></p>
                ${connectButton}
            </form>`;
        renderProfileNote();
    }

    function renderProfileNote() {
        const note = $('[data-profile-note]', view);
        if (!note) return;
        note.innerHTML = hasGameProfile()
            ? `Changed for Party Spin only. <button type="button" class="link" data-act="profile-reset">Use ${platform.isLoggedIn ? 'my profile' : 'the defaults'}</button>`
            : platform.isLoggedIn ? 'From your profile. Changes here only count in Party Spin.' : 'Changes are kept in this browser.';
    }

    function readProfile(form) {
        const f = form.elements;
        return {
            nickname: f.nickname.value.trim() || hubProfile(platform).nickname,
            ftp: Number(f.ftp.value) || hubProfile(platform).ftp,
            weight: Number(f.weight.value) || hubProfile(platform).weight,
            difficulty: Number(f.difficulty.value) || '',
        };
    }

    function renderDevices() {
        const line = $('[data-devices]', view);
        if (line) line.innerHTML = deviceSummary(platform);
    }

    function showError(form, message) {
        const element = $('[data-error]', form);
        element.textContent = message ?? '';
        element.hidden = !message;
    }

    async function submitJoin(form) {
        const room = form.elements.room.value.trim();
        saveGameProfile(platform, readProfile(form));
        renderProfileNote();
        showError(form, null);
        try {
            const { room: found } = await api('check_room', { name: room });
            await resolveDevice();
            local.set(LAST_ROOM_KEY, found.name);
            go(`#ride/${roomPath(found.name)}`);
        } catch (error) {
            entryFailed(form, error, room);
        }
    }

    /* ---------- Spectate ---------- */

    function renderSpectate() {
        const room = local.get(LAST_ROOM_KEY, '');
        $('[data-body="spectate"]', view).innerHTML = `
            <form data-form="spectate" class="stack">
                <label class="field"><span>Room name</span>
                    <input name="room" class="room-input" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(room)}" required></label>
                <label class="field"><span>Room key (optional: makes you a moderator)</span>
                    <input name="key" type="password" autocomplete="off"></label>
                <p class="form-error" data-error hidden></p>
                ${connectButton}
            </form>`;
    }

    async function submitSpectate(form) {
        const room = form.elements.room.value.trim();
        const key = form.elements.key.value;
        showError(form, null);
        try {
            const { room: found } = await api('check_room', { name: room, roomKey: key || undefined });
            local.set(LAST_ROOM_KEY, found.name);
            rememberRoomKey(found.name, key);
            go(`#screen/${roomPath(found.name)}`);
        } catch (error) {
            entryFailed(form, error, room);
        }
    }

    /* ---------- Create: log in, your rooms, the room form ---------- */

    function renderCreate() {
        const host = $('[data-body="create"]', view);
        if (!account && authKey()) {
            // Logged in before: the rooms are on their way (or the server could not be reached).
            host.innerHTML = accountError
                ? `<div class="stack"><p class="form-error">${esc(accountError)}</p>
                    <div class="row"><button type="button" class="primary grow" data-act="account-retry">Try again</button>
                    <button type="button" class="ghost" data-act="logout">${icon('logout')} Log out</button></div></div>`
                : '<p class="muted">Getting your rooms …</p>';
        } else if (!account) {
            host.innerHTML = `
                <form data-form="auth" class="stack">
                    <p class="muted">Creating rooms needs an authentication key from the person who runs the server.</p>
                    <label class="field"><span>Authentication key</span><input name="key" type="password" autocomplete="off" required></label>
                    <p class="form-error" data-error hidden></p>
                    <button class="primary" type="submit">${icon('lock')} Log in</button>
                </form>`;
        } else if (editing) {
            host.innerHTML = roomForm(editing.room);
            renderSchedule();
            updateRoomForm();
        } else {
            const rooms = account.rooms;
            host.innerHTML = `
                <div class="stack">
                    <div class="row"><span class="grow">Logged in as <strong>${esc(account.label)}</strong></span>
                        <button type="button" class="small ghost" data-act="logout">${icon('logout')} Log out</button></div>
                    ${rooms.length ? `<ul class="room-list">${rooms.map((room) => `
                        <li><div class="grow"><strong class="room-title">${esc(room.name)}</strong>
                                <div class="muted small-text">${STATUS_LABELS[room.status] ?? room.status} · ${room.schedule.length} event${room.schedule.length === 1 ? '' : 's'}</div></div>
                            <button type="button" class="small primary" data-act="room-open" data-id="${esc(room.id)}">Open</button>
                            <button type="button" class="small" data-act="room-edit" data-id="${esc(room.id)}">Edit</button>
                            <button type="button" class="small ghost" data-act="room-delete" data-id="${esc(room.id)}" title="Delete">${icon('close')}</button></li>`).join('')}</ul>`
                        : '<p class="muted">You have no rooms yet.</p>'}
                    <button type="button" class="primary" data-act="room-new">${icon('plus')} New room</button>
                </div>`;
        }
    }

    function roomForm(room) {
        const s = room?.settings ?? { mode: 'ftp', end: { type: 'time', value: 30 }, powerups: true, display: { background: 'brick', color: '#2b1d33', video: '' } };
        const option = (value, label, current) => `<option value="${value}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
        return `
            <form data-form="room" class="stack">
                <h3>${room ? `Edit ${esc(room.name)}` : 'New room'}</h3>
                <label class="field"><span>Room name</span><input name="name" maxlength="40" value="${esc(room?.name ?? '')}" placeholder="Friday spin" autocomplete="off" required></label>
                <label class="field"><span>Room key${room ? ' (leave empty to keep it)' : ''}</span>
                    <input name="roomKey" type="password" autocomplete="new-password" ${room ? '' : 'required'}>
                    <small class="muted">Whoever writes this key when spectating becomes a moderator of the room.</small></label>
                <label class="field"><span>Scoring</span>
                    <select name="mode">${Object.entries(MODES).map(([value, mode]) => option(value, mode.label, s.mode)).join('')}</select>
                    <small class="muted" data-mode-text></small></label>
                <div class="row">
                    <label class="field grow"><span>Game ends</span>
                        <select name="endType">${option('time', 'After a time', s.end.type)}${option('points', 'At a score', s.end.type)}${option('manual', 'When a moderator ends it', s.end.type)}</select></label>
                    <label class="field" data-end-value><span data-end-unit>Minutes</span><input name="endValue" type="number" min="1" value="${s.end.value}"></label>
                </div>
                <label class="check"><input type="checkbox" name="powerups" ${s.powerups ? 'checked' : ''}> Power-up cards</label>
                <label class="field"><span>Big screen background</span>
                    <select name="background">${option('brick', 'Brick wall', s.display.background)}${option('color', 'A colour', s.display.background)}${option('video', 'A video (synced to the game)', s.display.background)}</select></label>
                <label class="field" data-show="color" hidden><span>Colour</span><input name="color" type="color" value="${esc(s.display.color)}"></label>
                <label class="field" data-show="video" hidden><span>Video address</span><input name="video" type="url" value="${esc(s.display.video)}" placeholder="https://…/class.mp4"></label>
                <div class="schedule">
                    <h3>Events</h3>
                    <ul class="room-list" data-schedule></ul>
                    <div class="row wrap">${Object.entries(EVENT_TYPES).map(([type, label]) => `
                        <button type="button" class="small" data-act="event-add" data-type="${type}">${icon('plus')} ${label}</button>`).join('')}</div>
                </div>
                <p class="form-error" data-error hidden></p>
                <div class="row">
                    <button class="primary grow" type="submit">${room ? 'Save room' : 'Create room'}</button>
                    <button type="button" class="ghost" data-act="room-cancel">Cancel</button>
                </div>
            </form>`;
    }

    function updateRoomForm() {
        const form = $('[data-form="room"]', view);
        const f = form.elements;
        $('[data-mode-text]', form).textContent = MODES[f.mode.value].text;
        const endType = f.endType.value;
        $('[data-end-value]', form).hidden = endType === 'manual';
        $('[data-end-unit]', form).textContent = endType === 'points' ? 'Points' : 'Minutes';
        if (endType === 'points' && Number(f.endValue.value) < 1000) f.endValue.value = 100000;
        if (endType === 'time' && Number(f.endValue.value) > 600) f.endValue.value = 30;
        form.querySelectorAll('[data-show]').forEach((element) => { element.hidden = element.dataset.show !== f.background.value; });
    }

    function renderSchedule() {
        const events = editing.schedule.sort((a, b) => a.at - b.at);
        $('[data-schedule]', view).innerHTML = events.map((event) => `
            <li><b class="event-time">${formatClock(event.at * 1000)}</b>
                <span class="event-type" data-type="${esc(event.type)}">${esc(EVENT_TYPES[event.type] ?? event.type)}</span>
                <span class="grow event-title">${esc(eventTitle(event))}</span>
                <button type="button" class="small ghost" data-act="event-edit" data-id="${esc(event.id)}">Edit</button>
                <button type="button" class="small ghost" data-act="event-delete" data-id="${esc(event.id)}" title="Delete">${icon('close')}</button></li>`).join('')
            || '<li class="muted">No events yet: the game will just be riding and cards.</li>';
    }

    async function submitRoom(form) {
        const f = form.elements;
        const button = $('button[type="submit"]', form);
        button.disabled = true;
        showError(form, null);
        try {
            const { room: saved } = await api('save_room', {
                authKey: authKey(),
                room: {
                    id: editing.room?.id,
                    name: f.name.value.trim(),
                    roomKey: f.roomKey.value,
                    schedule: editing.schedule,
                    settings: {
                        ...(editing.room?.settings ?? {}),     // keeps what moderators switch in a game (break)
                        mode: f.mode.value,
                        end: { type: f.endType.value, value: Number(f.endValue.value) || 30 },
                        powerups: f.powerups.checked,
                        display: { background: f.background.value, color: f.color.value, video: f.video.value.trim() },
                    },
                },
            });
            account.rooms = [saved, ...account.rooms.filter((room) => room.id !== saved.id)];
            editing = null;
            renderCreate();
        } catch (error) {
            if (error.code === 'wrong-key') logout();
            else showError(form, error.message);
            button.disabled = false;
        }
    }

    /** Log in with `key` (or the stored one): who it belongs to and their rooms. */
    async function login(key = authKey()) {
        const { label, rooms } = await api('my_rooms', { authKey: key });
        setAuthKey(key);
        account = { label, rooms };
        accountError = null;
    }

    function logout() {
        setAuthKey(null);
        account = null;
        accountError = null;
        editing = null;
        renderCreate();
    }

    async function loadAccount() {
        accountError = null;
        renderCreate();
        try {
            await login();
        } catch (error) {
            if (error.code === 'wrong-key') setAuthKey(null);   // the key was removed from the server
            else accountError = error.message;
        }
        if (!stopped && !editing) renderCreate();
    }

    async function submitAuth(form) {
        showError(form, null);
        try {
            await login(form.elements.key.value.trim());
            renderCreate();
        } catch (error) {
            showError(form, error.message);
        }
    }

    async function deleteRoom(room) {
        const sure = await modal({
            title: `Delete ${room.name}?`,
            body: 'Everyone in it is sent back to the lobby and the room is gone for good.',
            actions: [{ label: 'Cancel', value: false }, { label: 'Delete', primary: true, value: true }],
        }).closed;
        if (!sure) return;
        try {
            await api('delete_room', { authKey: authKey(), id: room.id });
            account.rooms = account.rooms.filter((r) => r.id !== room.id);
            rememberRoomKey(room.name, null);
            renderCreate();
        } catch (error) {
            toast(error.message);
        }
    }

    /* ---------- input ---------- */

    const roomById = (id) => account?.rooms.find((room) => String(room.id) === String(id));

    const actions = {
        home: () => platform.home(),
        server: () => editServer(),
        fullscreen: () => toggleFullscreen(),
        devices: () => showDevices(platform, deviceActions, renderDevices),
        'profile-reset': () => { clearGameProfile(); renderJoin(); },
        logout: () => logout(),
        'account-retry': () => loadAccount(),
        'room-new': () => { editing = { room: null, schedule: [] }; renderCreate(); },
        'room-edit': async (button) => {
            // Fetch the rooms again first: a moderator may have changed the planned events in a game.
            try {
                await login();
            } catch (error) {
                toast(error.message);
                return;
            }
            const room = roomById(button.dataset.id);
            if (!room) { renderCreate(); return; }
            editing = { room, schedule: structuredClone(room.schedule) };
            renderCreate();
        },
        'room-cancel': () => { editing = null; renderCreate(); },
        'room-delete': (button) => deleteRoom(roomById(button.dataset.id)),
        'room-open': (button) => go(`#screen/${roomPath(roomById(button.dataset.id).name)}`),
        'event-add': async (button) => {
            const event = await editEvent(newEvent(button.dataset.type, editing.schedule));
            if (event) { editing.schedule.push(event); renderSchedule(); }
        },
        'event-edit': async (button) => {
            const event = await editEvent(editing.schedule.find((e) => String(e.id) === button.dataset.id));
            if (event) {
                editing.schedule = editing.schedule.map((e) => (e.id === event.id ? event : e));
                renderSchedule();
            }
        },
        'event-delete': (button) => {
            editing.schedule = editing.schedule.filter((e) => String(e.id) !== button.dataset.id);
            renderSchedule();
        },
    };

    view.addEventListener('click', async (event) => {
        const toggle = event.target.closest('[data-toggle]');
        if (toggle) {
            setOpen(openMenu === toggle.dataset.toggle ? null : toggle.dataset.toggle);
            return;
        }
        const button = event.target.closest('[data-act]');
        if (!button) return;
        const act = button.dataset.act;
        if (actions[act]) actions[act](button);
        else if (deviceActions[act]) {
            await deviceActions[act]();
            renderDevices();
        }
    });

    view.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.target;
        ({ join: submitJoin, spectate: submitSpectate, auth: submitAuth, room: submitRoom })[form.dataset.form]?.(form);
    });

    view.addEventListener('change', (event) => {
        const form = event.target.form;
        if (form?.dataset.form === 'room') updateRoomForm();
        if (form?.dataset.form === 'join' && event.target.name !== 'room') {
            saveGameProfile(platform, readProfile(form));
            renderProfileNote();
        }
    });

    // The hover pictures from the original.
    const hover = (event, on) => {
        const image = event.target.closest?.('.menu-head, .art-button')?.querySelector('img');
        if (image) image.src = `assets/UI/${image.dataset.art}${on ? '_hover' : ''}.png`;
    };
    view.addEventListener('mouseover', (event) => hover(event, true));
    view.addEventListener('mouseout', (event) => hover(event, false));

    stops.push(platform.on('devicechange', renderDevices));

    renderJoin();
    renderCreate();
    renderSpectate();
    setOpen(openMenu);
    if (authKey()) loadAccount();

    return () => {
        stopped = true;
        stops.forEach((stop) => stop());
    };
}
