/**
 * Inside a room: one view for riders (`role` 'player') and spectators ('screen'). A spectator with
 * the room key, or the room's owner, is also a moderator: that only adds the Moderator tab. Riders
 * are never moderators.
 *
 *   Top bar     first line: the room's name, its status, the clock and the end condition, devices and
 *               full screen. In the middle (a second line on small screens): the switches (break,
 *               power-ups), the one number that scores in this room (riders: % FTP, watts or W/kg),
 *               and two lights for what is going on (a planned event, power-ups).
 *   Main panel  one at a time, chosen with the tabs under the top bar:
 *                 Lobby        the riders, before the game starts (the only panel then)
 *                 Leaderboard  the top 10 on a line (the gaps between them), and the scores
 *                 Events       what is happening now: a Hakoot question, cards in their Nope window,
 *                              effects, your flat tyre (riders: only what affects you, unless
 *                              Settings says all)
 *                 History      the cards played, as a stack of playing cards
 *                 Camera       the live animations (later: CAMERA_PANEL)
 *                 Background   nothing but the backdrop (spectators and moderators)
 *   Drawer      at the bottom, dragged up and down (or click a tab), with tabs like folders:
 *               Profile (riders: your bike's numbers, devices, nickname …, ghost mode), Cards
 *               (riders), Settings, Moderator.
 *
 * With "Jump to Events" on (Settings), the Events panel opens by itself when something happens
 * (and the drawer closes), and the panel you were on comes back afterwards.
 *
 * The bike's real numbers are never changed: they are recorded in a session you can save at the
 * end. Cards only change the *points*: the power used for points (`eff`: 0 with a flat tyre,
 * another rider's watts with Copycat) times the multiplier (EPO ×1.2, Pray ×0, a break ×0).
 *
 * Keys: 1–5 open a card · N Nope · Space pumps the tyre · A–D answer a question · F full screen
 */
import { DIFFICULTIES } from '../../core/settings.js';
import { avatar, esc, icon, modal, toast, formatDuration } from '../../core/ui.js';
import { PartyRoom, authKey } from './net.js';
import { Leaderboard, ScoreLine, TireGame } from './canvas.js';
import { editEvent, newEvent } from './event-editor.js';
import {
    MODES, COLORS, POWER_VIEWS, SPEED_VIEWS, pointsPerSecond, activeEffects, incomingCards, describe, formatClock,
    cardArt, cardIcon, cardColor, formatPower, formatPoints, formatSpeedView, flatSpeed, nextView, scoringStat,
} from './rules.js';
import {
    $, popup, closePopup, riderInfo, cardTile, guardRoom, fullscreenButton, devicesButton, toggleFullscreen, showDevices,
    deviceSummary, roomKeyFor, setBackdrop, syncVideo, gameProfile, saveGameProfile, viewPrefs, setViewPrefs,
} from './shared.js';

const APP_ID = 'PartySpin';
const CAMERA_PANEL = false;     // switch on when the camera feed has its graphics
const REPORT_EVERY = 1000;      // ms between the numbers sent to the server
const STOPPED_BELOW = 15;       // W: the bike counts as stopped for the flat tyre
const RESULT_SHOW = 9000;       // game ms the answer of a question stays in Events
const RECENT_CARD = 6000;       // game ms a card stays in Events after it happened
const RETURN_AFTER = 4000;      // ms of nothing happening before an automatic jump goes back
const HOLD_MS = 1200;           // pause and end are held down this long (no accidents)

const PANEL_LABELS = { lobby: 'Lobby', board: 'Leaderboard', events: 'Events', history: 'History', camera: 'Camera', background: 'Background' };
const STATUS_LABELS = { lobby: 'Waiting', running: 'Live', paused: 'Paused', ended: 'Finished', offline: 'Offline' };
const ANSWER_KEYS = ['A', 'B', 'C', 'D'];
// The drawer's tabs, each with its colour (the colours of the original game): the open one and the
// drawer under it share it, so the tab looks pulled to the front like a folder.
const DRAWER_TABS = {
    profile: { label: 'Profile', color: '#3a3a3a' },
    cards: { label: 'Cards', color: '#B6E682' },
    settings: { label: 'Settings', color: '#5CC8D0' },
    admin: { label: 'Moderator', color: '#D05CBC' },
};

export function startRoom({ platform, view, go, deviceActions, editServer }, roomName, role) {
    const isPlayer = role === 'player';
    const rider = isPlayer ? riderInfo(platform) : null;
    // Only spectators send the keys that make a moderator.
    const room = new PartyRoom({ room: roomName, role, rider, roomKey: isPlayer ? null : roomKeyFor(roomName), authKey: isPlayer ? null : authKey() });
    let prefs = viewPrefs();
    const stops = [];

    let panel = 'lobby';
    let jumpedFrom = null;          // the panel before an automatic jump to Events
    let quietSince = 0;             // when Events last had something to show (performance.now)
    const jumpedFor = new Set();    // what we already jumped for
    let drawerOpen = false;
    let drawerTab = isPlayer ? 'cards' : 'settings';
    let adminTab = 'game';
    let holding = null;             // the hold-to-confirm button being held

    // Riders
    let tracker = null;
    let trackerBusy = false;
    let summaryShown = false;
    let lastReport = performance.now();
    let rate = 0;
    let effects = { multiplier: 1, copy: null, flat: null, list: [] };
    let tire = null;                // { game, of, sent }
    const answered = new Map();     // hakoot event id → choice
    const powerSamples = [];        // [ms, W] of the last 3 s
    let speed = 0;                  // km/h shown (the bike's, or from power on a flat road)
    let lastSpeedAt = performance.now();

    view.className = `view room ${isPlayer ? 'as-player' : 'as-screen'}`;
    view.innerHTML = `
        <header class="hud glass">
            <button class="ghost round" data-act="leave" title="Leave the room">${icon('back')}</button>
            <div class="hud-room"><strong data-name>Party Spin</strong><span class="chip" data-status>…</span></div>
            <div class="hud-middle">
                <div class="hud-flags">
                    <span class="flag" data-flag="break" title="A break: nobody scores, cards still work">Break</span>
                    <span class="flag" data-flag="powerups" title="Power-up cards can be played">Power-ups</span>
                </div>
                ${isPlayer ? `<div class="stat score-stat" data-score-stat><img src="assets/UI/Power.png" alt=""><b data-score>–</b><small data-score-unit></small></div>` : ''}
                <div class="hud-signals">
                    <button class="signal" data-signal="planned" data-act="to-events" title="A planned event (Hakoot …) is on">Event</button>
                    <button class="signal" data-signal="cards" data-act="to-events" title="Power-ups are in play">Cards</button>
                </div>
            </div>
            <div class="hud-clock"><b data-clock>0:00</b><small data-end></small></div>
            <div class="hud-tools">${isPlayer ? devicesButton() : ''}${fullscreenButton()}</div>
        </header>
        <nav class="panel-tabs" data-panel-tabs></nav>
        <div class="banner" data-banner hidden></div>
        <main class="panels">
            <section class="panel" data-panel="lobby"><div class="lobby-panel" data-lobby></div></section>
            <section class="panel board-panel" data-panel="board">
                ${isPlayer ? '<div class="me-line glass" data-me></div>' : ''}
                <div class="score-line glass" title="The top 10: the gaps between them"><canvas data-score-line></canvas></div>
                <div class="board glass"><canvas data-board></canvas></div>
            </section>
            <section class="panel events-panel" data-panel="events">
                <div data-ev-hakoot></div>
                <div data-ev-tire></div>
                <div class="ev-cards" data-ev-cards></div>
                <div class="ev-effects" data-ev-effects></div>
                <p class="ev-empty glass" data-ev-empty></p>
            </section>
            <section class="panel" data-panel="history"><div class="history" data-history></div></section>
            <section class="panel" data-panel="camera"><p class="ev-empty glass">The camera is coming soon.</p></section>
            <section class="panel" data-panel="background"></section>
        </main>
        <section class="drawer" data-drawer>
            <div class="drawer-bar" data-drawer-bar>
                <button class="art-icon drawer-arrow" data-act="drawer-toggle" title="Open or close"><img data-drawer-arrow src="assets/UI/up.png" alt="" draggable="false"></button>
                <nav class="drawer-tabs" data-drawer-tabs></nav>
            </div>
            <div class="drawer-body" data-drawer-body></div>
        </section>`;
    const board = new Leaderboard($('[data-board]', view), { big: true });
    const scoreLine = new ScoreLine($('[data-score-line]', view));
    const drawer = $('[data-drawer]', view);
    const drawerBody = $('[data-drawer-body]', view);

    const set = (selector, text, root = view) => {
        const element = $(selector, root);
        if (element && element.textContent !== String(text)) element.textContent = text;
    };
    /** Replace the inside of `element` only when it changed (keeps clicks and focus working). */
    const fill = (element, html) => {
        if (element && element.dataset.html !== html) {
            element.dataset.html = html;
            element.innerHTML = html;
        }
    };
    /** A number in the top bar ('–' when there is none, in the plain font). */
    const setStat = (selector, value) => {
        set(selector, value);
        $(selector, view)?.classList.toggle('none', value === '–');
    };
    const isModerator = () => !isPlayer && room.isAdmin;
    const canSeeBackground = () => !isPlayer || isModerator();
    const playerName = (id) => room.name(id);

    /* ================================================================ the bike (riders) */

    const bike = () => (platform.bike?.isConnected ? platform.bike : null);
    const heartRate = () => (platform.heartRateMonitor?.isConnected ? platform.heartRateMonitor.heartRate : null) ?? bike()?.heartRate ?? null;

    function effectivePower(power) {
        if (effects.flat) return 0;
        if (effects.copy) return room.player(effects.copy.source)?.power ?? 0;
        return power ?? 0;
    }

    /** The speed: the bike's own when it has one, otherwise from the power on a flat road (smoothed). */
    function updateSpeed() {
        const now = performance.now();
        const dt = Math.min(2, (now - lastSpeedAt) / 1000);
        lastSpeedAt = now;
        const reported = bike()?.speed;
        if (reported > 0) { speed = reported; return; }
        const target = bike() ? flatSpeed(bike().power ?? 0, rider.weight) : 0;
        speed += (target - speed) * Math.min(1, dt / 2.5);
        if (speed < 0.2) speed = 0;
    }

    function averagePower() {
        const now = performance.now();
        while (powerSamples.length && now - powerSamples[0][0] > 3000) powerSamples.shift();
        return powerSamples.length ? powerSamples.reduce((sum, [, w]) => sum + w, 0) / powerSamples.length : null;
    }

    function report() {
        const now = performance.now();
        const dt = Math.min(3, (now - lastReport) / 1000);
        lastReport = now;
        effects = activeEffects(room.eventList(), room.myId, room.clock());
        const power = bike()?.power ?? null;
        const eff = effectivePower(power);
        const settings = room.info?.settings;
        rate = settings?.break ? 0 : pointsPerSecond(eff, settings?.mode, rider) * effects.multiplier;
        if (!room.connected || !room.you) return;
        room.send({
            type: 'stats', power, cadence: bike()?.cadence ?? null, hr: heartRate(), speed: bike() ? Number(speed.toFixed(1)) : null,
            eff: Math.round(eff), mult: settings?.break ? 0 : effects.multiplier, points: room.status === 'running' ? rate * dt : 0,
        });
    }

    /* ---------- the session (real bike data) ---------- */

    async function syncTracker() {
        if (!isPlayer || trackerBusy) return;
        const status = room.status;
        if (!tracker && status === 'running' && bike() && !summaryShown) {
            trackerBusy = true;
            try {
                tracker = await platform.createTracker();
                tracker.start();
            } catch (error) {
                toast(platform.modulesError ?? `Recording could not start: ${error.message}`);
            } finally {
                trackerBusy = false;
            }
            return;
        }
        if (!tracker) return;
        if (status === 'paused' && tracker.isRunning) tracker.pause();
        if (status === 'running' && tracker.isPaused) tracker.resume();
        if (status === 'ended' && tracker.state !== 'stopped') tracker.stop();
    }

    function showSummary(then = null) {
        if (!tracker || tracker.state === 'idle') { then?.(); return; }
        if (tracker.state !== 'stopped') tracker.stop();
        summaryShown = true;
        const stats = tracker.getStats('total');
        const me = room.player(room.myId);
        const element = popup(`
            <div class="sheet glass summary">
                <h2>Your ride</h2>
                <div class="facts">
                    <div><small>Points</small><b>${formatPoints(me?.score)}</b></div>
                    <div><small>Time</small><b>${formatDuration(Math.round((stats.activeTime ?? 0) / 1000))}</b></div>
                    <div><small>Avg power</small><b>${Math.round(stats.power.avg ?? 0)} W</b></div>
                    <div><small>Max power</small><b>${Math.round(stats.power.max ?? 0)} W</b></div>
                    <div><small>Avg heart rate</small><b>${stats.heartRate.avg ? Math.round(stats.heartRate.avg) : '–'}</b></div>
                    <div><small>Energy</small><b>${Math.round(stats.energy ?? 0)} kJ</b></div>
                </div>
                <p class="muted">The real numbers from your bike (cards only changed your points).</p>
                <div class="row wrap">
                    <button class="primary" data-act="save" ${platform.isLoggedIn ? '' : 'disabled title="Log in to save rides"'}>${icon('activities')} Save to activities</button>
                    <button data-act="tcx">${icon('download')} Download .tcx</button>
                    <button class="ghost danger" data-act="discard">Discard</button>
                    <button class="ghost" data-act="done">Close</button>
                </div>
            </div>`, { key: 'summary', className: 'center' });
        const finish = () => { element.close(); then?.(); };
        element.addEventListener('click', async (event) => {
            const act = event.target.closest('[data-act]')?.dataset.act;
            if (act === 'save') {
                event.target.disabled = true;
                try {
                    await platform.saveSession(tracker, { applicationId: APP_ID, title: `Party Spin · ${roomName}` });
                    toast('Saved to your activities');
                    tracker = null;
                    finish();
                } catch (error) {
                    toast(error.message);
                    event.target.disabled = false;
                }
            } else if (act === 'tcx') {
                tracker.downloadTCX(`party-spin-${roomName.replace(/[^\w-]+/g, '-')}.tcx`);
            } else if (act === 'discard') {
                const sure = await modal({ title: 'Discard this ride?', body: 'It will not be saved anywhere.',
                    actions: [{ label: 'Keep it', value: false }, { label: 'Discard', primary: true, value: true }] }).closed;
                if (sure) { tracker = null; finish(); }
            } else if (act === 'done') {
                finish();
            }
        });
    }

    /* ================================================================ what is going on */

    /** Everything Events shows, read from the event log at game time `clock`. */
    function happenings(clock) {
        const list = room.eventList();
        const results = new Map();
        const resolves = new Map();
        for (const event of list) {
            if (event.type === 'hakoot-result') results.set(event.of, event);
            if (event.type === 'resolve') resolves.set(event.of, event);
        }
        const question = list.find((e) => e.type === 'hakoot' && !results.has(e.id) && clock >= e.start - 3000) ?? null;
        const result = question ? null : [...results.values()].reverse().find((r) => clock - r.t < RESULT_SHOW) ?? null;
        // Riders see only what affects them, unless Settings says all (questions are for everyone).
        const mineOnly = isPlayer && prefs.onlyMine;
        const cards = list
            .filter((e) => e.type === 'powerup' && (!resolves.has(e.id) || clock - resolves.get(e.id).t < RECENT_CARD))
            .filter((e) => !mineOnly || e.owner === room.myId || e.target === room.myId)
            .map((event) => ({ event, result: resolves.get(event.id) ?? null }));
        const affected = room.players
            .filter((player) => !mineOnly || player.id === room.myId)
            .map((player) => ({ player, fx: activeEffects(list, player.id, clock) }))
            .filter(({ fx }) => fx.list.length);
        return {
            question, result, cards, affected,
            planned: !!(question || result),
            powerups: cards.length > 0 || affected.length > 0,
        };
    }

    /** Jump to Events for something new (when the setting is on), and come back when it is over. */
    function autoJump(h) {
        if (!prefs.autoJump || room.status !== 'running' && room.status !== 'paused') return;
        const reasons = [];
        if (h.question) reasons.push(`q${h.question.id}`);
        const open = h.cards.filter(({ event, result }) => !result && (!isPlayer || (event.target === room.myId && event.owner !== room.myId)));
        reasons.push(...open.map(({ event }) => `c${event.id}`));
        if (isPlayer && effects.flat) reasons.push(`f${effects.flat.of}`);
        const fresh = reasons.filter((reason) => reason && !jumpedFor.has(reason));
        fresh.forEach((reason) => jumpedFor.add(reason));
        if (fresh.length) {
            if (panel !== 'events') {
                jumpedFrom = panel;
                setPanel('events', { auto: true });
            }
            closePopup('card');
            setDrawer(false);
        }
        const busy = h.planned || h.cards.length > 0 || (isPlayer && !!effects.flat);
        if (busy) quietSince = performance.now();
        else if (jumpedFrom && panel === 'events' && performance.now() - quietSince > RETURN_AFTER) {
            const back = jumpedFrom;
            jumpedFrom = null;
            setPanel(back, { auto: true });
        }
    }

    /* ================================================================ the top bar */

    function endCondition(settings, clock) {
        const end = settings?.end;
        if (room.status === 'ended') return 'Final score';
        if (end?.type === 'time') return `${formatClock(end.value * 60_000 - clock)} left`;
        if (end?.type === 'points') return `First to ${formatPoints(end.value)}`;
        return 'Ends when the host ends it';
    }

    function renderHud(h) {
        const info = room.info;
        const settings = info?.settings;
        set('[data-name]', settings?.name ?? roomName);
        const status = room.connected ? room.status : 'offline';
        const chip = $('[data-status]', view);
        set('[data-status]', STATUS_LABELS[status] ?? '…');
        chip.dataset.state = status ?? '';
        $('[data-flag="break"]', view).classList.toggle('on', !!settings?.break);
        $('[data-flag="powerups"]', view).classList.toggle('on', !!settings?.powerups);
        $('[data-signal="planned"]', view).classList.toggle('on', h.planned);
        $('[data-signal="cards"]', view).classList.toggle('on', h.powerups);
        const clock = room.clock();
        set('[data-clock]', formatClock(clock));
        set('[data-end]', info ? endCondition(settings, clock) : '');

        const banner = $('[data-banner]', view);
        const text = !room.connected ? 'Connecting to the Party Spin server …' : status === 'paused' ? 'Paused by the host' : '';
        banner.hidden = !text;
        if (text) banner.textContent = text;

        if (!isPlayer) return;
        const power = bike()?.power ?? null;
        if (power != null) powerSamples.push([performance.now(), power]);
        // The one number in the top bar: what earns points here, from the power that counts.
        const scoring = scoringStat(settings?.mode, bike() ? effectivePower(power) : null, rider);
        setStat('[data-score]', scoring.value);
        set('[data-score-unit]', scoring.unit);
        const scoreBox = $('[data-score-stat]', view);
        if (scoreBox.title !== scoring.label) scoreBox.title = scoring.label;
        renderBikeStats(power);
    }

    /** The bike's own numbers, in Profile (when it is open). */
    function renderBikeStats(power) {
        const average = averagePower();     // (also drops the old samples)
        if (!$('[data-bike-stats]', view)) return;
        const shown = formatPower(prefs.power, prefs.power === 'avg3' ? average : power, rider);
        setStat('[data-power]', bike() ? shown.value : '–');
        set('[data-power-unit]', shown.unit);
        const speedView = formatSpeedView(prefs.speed, bike() ? speed : null);
        setStat('[data-speed]', speedView.value);
        set('[data-speed-unit]', speedView.unit);
        setStat('[data-cadence]', bike()?.cadence != null ? String(Math.round(bike().cadence)) : '–');
        const hr = heartRate();
        set('[data-hr]', hr ? Math.round(hr) : '–');
        $('[data-hr]', view).classList.toggle('none', !hr);
    }

    /* ================================================================ the panels */

    function panels() {
        const list = room.status === 'lobby' || !room.status ? ['lobby'] : ['board', 'events', 'history', ...(CAMERA_PANEL ? ['camera'] : [])];
        if (canSeeBackground()) list.push('background');
        return list;
    }

    function setPanel(id, { auto = false } = {}) {
        if (!auto) jumpedFrom = null;
        panel = id;
        renderPanels();
    }

    function renderPanels() {
        const list = panels();
        if (!list.includes(panel)) panel = list[0];
        fill($('[data-panel-tabs]', view), list.map((id) => `<button data-panel-tab="${id}" class="${id === panel ? 'active' : ''}">${PANEL_LABELS[id]}</button>`).join(''));
        for (const element of view.querySelectorAll('[data-panel]')) element.hidden = element.dataset.panel !== panel;
        view.classList.toggle('backdrop-only', panel === 'background');
    }

    /* ---------- Lobby ---------- */

    function renderLobby() {
        const settings = room.info?.settings;
        const riders = room.players.map((p) => `
            <li class="${p.online ? '' : 'away'}">
                ${avatar({ username: p.id, icon: p.avatar?.icon, icon_image: p.avatar?.image }, 'large')}
                <span class="grow"><strong>${esc(p.id === room.myId ? `${p.name} (you)` : p.name)}</strong>
                    <small class="muted">${p.online ? 'ready' : 'not here'}${p.ghost ? ' · ghost' : ''}</small></span>
            </li>`).join('');
        fill($('[data-lobby]', view), `
            <div class="glass lobby-card">
                <p class="muted">${isPlayer ? 'Waiting for the host to start the game' : 'Open Party Spin and join the room'}</p>
                <div class="big-code">${esc(settings?.name ?? roomName)}</div>
                <p>${esc(MODES[settings?.mode]?.text ?? '')}</p>
                <p class="muted">${esc(settings ? endCondition(settings, 0) : '')}</p>
            </div>
            <ul class="lobby-riders">${riders || '<li class="muted">Nobody has joined yet.</li>'}</ul>`);
    }

    /* ---------- Leaderboard ---------- */

    function badges(player) {
        const fx = activeEffects(room.eventList(), player.id, room.clock());
        return fx.list.map((e) => room.cards[e.card]?.name).filter(Boolean).join(', ');
    }

    function renderMe() {
        if (!isPlayer) return;
        const me = room.player(room.myId);
        const index = room.players.findIndex((p) => p.id === room.myId);
        const multiplier = room.info?.settings?.break ? 0 : effects.multiplier;
        fill($('[data-me]', view), `
            <div><small>Place</small><b>${index >= 0 ? `${index + 1}/${room.players.length}` : '–'}</b></div>
            <div class="main-score"><small>Points</small><b>${formatPoints(me?.score)}</b></div>
            <div><small>Points/s</small><b>${Math.round(rate)}</b></div>
            <div><small>Multiplier</small><b data-level="${multiplier > 1 ? 'up' : multiplier < 1 ? 'down' : ''}">×${Number(multiplier.toFixed(2))}</b></div>`);
    }

    /* ---------- Events ---------- */

    function renderEvents(h, clock) {
        renderHakoot(h, clock);
        if (isPlayer) renderTire();
        const cards = h.cards.slice().reverse().map(({ event, result }) => {
            const rules = room.cards[event.card] ?? {};
            const onMe = !result && event.target === room.myId && event.owner !== room.myId;
            const target = event.target && event.target !== event.owner ? ` on ${esc(playerName(event.target))}` : '';
            const outcome = result ? describe(result, room.eventList(), room.cards, playerName) : 'Nope window open …';
            return `<div class="ev-card glass ${onMe ? 'on-me' : ''}" style="--card:${cardColor(event.card)}">
                <img src="${cardIcon(event.card)}" alt="">
                <div class="grow"><strong>${esc(playerName(event.owner))} plays ${esc(rules.name ?? 'a card')}${target}</strong>
                    <small>${esc(outcome ?? '')}</small>
                    ${result ? '' : `<div class="timer"><i data-timer data-from="${event.t}" data-until="${event.resolveAt}"></i></div>`}</div>
                ${result?.outcome === 'noped' ? '<span class="stamp-small">NOPE!</span>' : ''}
                ${onMe ? `<button class="nope-button" data-act="nope" data-of="${event.id}" ${room.hand.nope ? '' : 'disabled title="You have no Nope card"'}>NOPE!</button>` : ''}
            </div>`;
        }).join('');
        fill($('[data-ev-cards]', view), cards);
        for (const timer of view.querySelectorAll('[data-ev-cards] [data-timer]')) {
            const from = Number(timer.dataset.from);
            const until = Number(timer.dataset.until);
            timer.style.width = `${(100 * Math.max(0, until - clock)) / Math.max(1, until - from)}%`;
        }
        const affected = h.affected.map(({ player, fx }) => `<li><strong>${esc(playerName(player.id))}</strong>${fx.list.map((effect) => {
            const label = effect.kind === 'flat' ? 'flat tyre' : effect.kind === 'copy' ? `copies ${esc(playerName(effect.source))}` : effect.value === 0 ? 'no points' : `×${effect.value}`;
            return `<span class="fx-chip" style="--card:${cardColor(effect.card)}"><img src="${cardIcon(effect.card)}" alt="">${label} <small>${Math.ceil(Math.max(0, effect.until - clock) / 1000)} s</small></span>`;
        }).join('')}</li>`).join('');
        fill($('[data-ev-effects]', view), affected ? `<h3>Active effects</h3><ul>${affected}</ul>` : '');
        const empty = $('[data-ev-empty]', view);
        empty.hidden = !!(h.question || h.result || h.cards.length || h.affected.length || tire);
        set('[data-ev-empty]', isPlayer && prefs.onlyMine ? 'Nothing is going on for you right now.' : 'Nothing is going on right now.');
    }

    /* Hakoot: the question while it is open, then its answer for a few seconds. */
    function renderHakoot(h, clock) {
        const host = $('[data-ev-hakoot]', view);
        if (h.question) {
            const event = h.question;
            const opens = event.start + event.read;
            const closes = opens + event.answer;
            const phase = clock < event.start ? 'soon' : clock < opens ? 'read' : clock < closes ? 'answer' : 'wait';
            const key = `q${event.id}-${phase}-${answered.get(event.id) ?? ''}`;
            if (host.dataset.key !== key) {
                host.dataset.key = key;
                const mine = answered.get(event.id);
                const canAnswer = isPlayer && phase === 'answer' && mine == null;
                const answers = phase === 'answer' || phase === 'wait'
                    ? `<div class="answers">${event.answers.map((text, i) => (isPlayer
                        ? `<button data-choice="${i}" style="--answer:${COLORS[i]}" class="${mine === i ? 'picked' : ''}" ${canAnswer ? '' : 'disabled'}><kbd>${ANSWER_KEYS[i]}</kbd>${esc(text)}</button>`
                        : `<div style="--answer:${COLORS[i]}"><kbd>${ANSWER_KEYS[i]}</kbd>${esc(text)}</div>`)).join('')}</div>`
                    : '';
                const note = mine != null ? 'Answer locked in – wait for the result …'
                    : phase === 'read' ? 'Read the question – the answers come in a moment'
                        : phase === 'answer' ? `The fastest right answer wins 2 cards, the next ${Math.max(0, event.rewards - 1)} win one` : phase === 'wait' ? 'Time is up!' : '';
                host.innerHTML = `<div class="hakoot glass" data-phase="${phase}">
                    <div class="hakoot-head"><span class="hakoot-logo">Hakoot!</span><b data-count></b></div>
                    <h2>${phase === 'soon' ? 'A question is coming up …' : esc(event.question)}</h2>
                    ${phase !== 'soon' && (event.image || !isPlayer) ? `<img class="hakoot-image" src="${esc(event.image || 'assets/hakoot/default.jpg')}" alt="">` : ''}
                    ${answers}<p class="muted">${note}</p></div>`;
            }
            const count = phase === 'soon' ? event.start - clock : phase === 'read' ? opens - clock : phase === 'answer' ? closes - clock : 0;
            set('[data-count]', count > 0 ? Math.ceil(count / 1000) : '', host);
            return;
        }
        if (h.result) {
            const key = `r${h.result.id}`;
            if (host.dataset.key !== key) {
                host.dataset.key = key;
                host.innerHTML = resultHtml(h.result);
            }
            return;
        }
        host.dataset.key = '';
        host.innerHTML = '';
    }

    function resultHtml(result) {
        const question = room.events.get(result.of);
        if (!question) return '';
        const counts = question.answers.map((_, i) => result.results.filter((r) => r.choice === i).length);
        const most = Math.max(1, ...counts);
        const winners = result.results.filter((r) => r.correct).slice(0, 5);
        const mine = isPlayer ? result.results.find((r) => r.player === room.myId) : null;
        return `<div class="hakoot glass result ${mine ? (mine.correct ? 'right' : 'wrong') : ''}">
            <div class="hakoot-head"><span class="hakoot-logo">Hakoot!</span></div>
            ${isPlayer ? `<h2>${mine ? (mine.correct ? 'Correct!' : 'Wrong!') : 'Time is up'}</h2>` : ''}
            <p>${esc(question.question)}</p>
            <div class="answers">${question.answers.map((a, i) => `<div style="--answer:${COLORS[i]}" class="${i === result.correct ? 'right' : 'wrong'}">
                <kbd>${ANSWER_KEYS[i]}</kbd>${esc(a)}<span class="votes" style="--share:${counts[i] / most}">${counts[i]}</span></div>`).join('')}</div>
            ${mine?.cards?.length ? `<p>You won:</p><div class="cards">${mine.cards.map((c) => cardTile(c, room.cards, { small: true })).join('')}</div>` : ''}
            ${winners.length ? `<ol class="winners">${winners.map((w) => `<li>${esc(playerName(w.player))} <small>${(w.ms / 1000).toFixed(1)} s · ${w.cards.length} card${w.cards.length === 1 ? '' : 's'}</small></li>`).join('')}</ol>`
                : '<p class="muted">Nobody got it right!</p>'}
        </div>`;
    }

    function answer(event, choice) {
        if (answered.has(event.id)) return;
        answered.set(event.id, choice);
        room.send({ type: 'answer', of: event.id, choice });
    }

    /* The flat tyre (Thumbtacks): stop, find the hole, pump. It lives in Events. */
    function renderTire() {
        const host = $('[data-ev-tire]', view);
        const flat = effects.flat;
        if (!flat || (tire && tire.of !== flat.of)) {
            if (tire) {
                tire = null;
                host.innerHTML = '';
                if (platform.bike?.pedaling === false) platform.bike.pedaling = true;
            }
            if (!flat) return;
        }
        if (!tire) openTire(host, flat);
        const power = bike()?.power ?? 0;
        // Trainers keep reporting a little power from the flywheel for a moment after you stop.
        if (tire.game.step === 'stop' && (!bike() || power < STOPPED_BELOW)) tire.game.step = 'find';
        const texts = {
            stop: ['Flat tyre!', `Stop pedalling first (${Math.round(power)} W)`],
            find: ['Find the hole', 'Look for the escaping air and click the hole'],
            pump: ['Pump it up!', `Push the pump down (drag, Space or the button): ${tire.game.strokes}/${TireGame.STROKES}`],
            done: ['Fixed!', 'Go go go!'],
        }[tire.game.step];
        set('[data-tire-title]', texts[0], host);
        set('[data-tire-text]', texts[1], host);
        set('[data-tire-left]', `${Math.ceil(Math.max(0, flat.until - room.clock()) / 1000)} s`, host);
        $('[data-act="pump"]', host).hidden = tire.game.step !== 'pump';
        $('[data-act="sim-stop"]', host).hidden = !(tire.game.step === 'stop' && platform.bike?.id === 'simulated-bike');
        if (tire.game.step === 'done' && !tire.sent) {
            tire.sent = true;
            room.send({ type: 'fixed', of: flat.of });
            if (platform.bike?.pedaling === false) platform.bike.pedaling = true;
        }
    }

    function openTire(host, flat) {
        host.innerHTML = `
            <div class="glass tire">
                <div class="row"><h2 class="grow" data-tire-title></h2><b class="chip" data-tire-left></b></div>
                <p data-tire-text></p>
                <canvas data-tire></canvas>
                <div class="row wrap">
                    <button class="primary" data-act="pump" hidden>Pump!</button>
                    <button data-act="sim-stop" hidden>Stop pedalling (simulator)</button>
                </div>
            </div>`;
        const canvas = $('[data-tire]', host);
        const game = new TireGame(canvas);
        tire = { game, of: flat.of, sent: false };
        let dragging = false;
        const point = (event) => {
            const box = canvas.getBoundingClientRect();
            return { x: event.clientX - box.left, y: event.clientY - box.top };
        };
        canvas.addEventListener('pointerdown', (event) => {
            const { x, y } = point(event);
            if (game.step === 'find') game.click(x, y);
            else if (game.step === 'pump') {
                dragging = true;
                canvas.setPointerCapture(event.pointerId);
                game.pump(game.pumpPosition(y));
            }
        });
        canvas.addEventListener('pointermove', (event) => {
            if (dragging) game.pump(game.pumpPosition(point(event).y));
        });
        canvas.addEventListener('pointerup', () => { dragging = false; game.pump(0); });
    }

    /* Cards played on you while you look at something else: a bar on top with the NOPE button. */
    function renderIncoming() {
        const keys = new Set();
        if (isPlayer && panel !== 'events') {
            const clock = room.clock();
            for (const event of incomingCards(room.eventList(), room.myId)) {
                const key = `incoming-${event.id}`;
                keys.add(key);
                let element = document.querySelector(`.popup[data-key="${key}"]`);
                if (!element) {
                    const rules = room.cards[event.card];
                    element = popup(`
                        <div class="incoming glass" style="--card:${cardColor(event.card)}">
                            <img src="${cardIcon(event.card)}" alt="">
                            <div class="grow"><strong>${esc(playerName(event.owner))} plays ${esc(rules?.name ?? 'a card')} on you!</strong>
                                <div class="timer"><i data-left></i></div></div>
                            <button class="nope-button" data-act="nope" data-of="${event.id}">NOPE!</button>
                        </div>`, { key, className: 'top' });
                    element.addEventListener('click', (e) => {
                        if (e.target.closest('[data-act="nope"]')) room.send({ type: 'nope', of: event.id });
                    });
                }
                $('[data-left]', element).style.width = `${(100 * Math.max(0, event.resolveAt - clock)) / Math.max(1, event.resolveAt - event.t)}%`;
                $('[data-act="nope"]', element).disabled = !room.hand.nope;
            }
        }
        document.querySelectorAll('.popup[data-key^="incoming-"]').forEach((element) => {
            if (!keys.has(element.dataset.key)) element.remove();
        });
    }

    /* ---------- History: the cards played, newest on top ---------- */

    function renderHistory() {
        const list = room.eventList();
        const resolves = new Map(list.filter((e) => e.type === 'resolve').map((e) => [e.of, e]));
        const items = [];
        for (const event of list) {
            if (event.type === 'powerup') {
                const rules = room.cards[event.card] ?? {};
                const result = resolves.get(event.id);
                const self = !event.target || event.target === event.owner;
                const art = cardArt(event.card);
                items.push(`<article class="history-card" style="--card:${cardColor(event.card)};--tilt:${((event.id * 7) % 7) - 3}deg">
                    ${art ? `<img class="history-art" src="${art}" alt="">` : `<div class="history-art icon-art"><img src="${cardIcon(event.card)}" alt=""></div>`}
                    <h4>${esc(rules.name ?? 'Card')}</h4>
                    <p>${self ? `<b>${esc(playerName(event.owner))}</b> played it` : `<b>${esc(playerName(event.owner))}</b> → <b>${esc(playerName(event.target))}</b>`}</p>
                    <small>${esc(result ? describe(result, list, room.cards, playerName) ?? '' : 'Nope window open …')}</small>
                    ${result?.outcome === 'noped' ? '<span class="stamp-small">NOPE!</span>' : ''}
                    <time>${formatClock(event.t)}</time>
                </article>`);
            } else if (event.type === 'hakoot-result') {
                const question = room.events.get(event.of);
                const winner = event.results.find((r) => r.correct);
                items.push(`<article class="history-card hakoot-card" style="--tilt:${((event.id * 5) % 7) - 3}deg">
                    <h4>Hakoot!</h4><p>${esc(question?.question ?? '')}</p>
                    <small>${winner ? `${esc(playerName(winner.player))} answered fastest` : 'Nobody got it right'}</small>
                    <time>${formatClock(event.t)}</time>
                </article>`);
            }
        }
        fill($('[data-history]', view), items.reverse().join('') || '<p class="ev-empty glass">No cards played yet.</p>');
    }

    /* ================================================================ the drawer */

    function drawerTabs() {
        const ids = [...(isPlayer ? ['profile', 'cards'] : []), 'settings', ...(isModerator() ? ['admin'] : [])];
        return ids.map((id) => [id, id === 'cards' ? `Cards (${room.hand.hand.length + (room.hand.nope ? 1 : 0)})` : DRAWER_TABS[id].label]);
    }

    function setDrawer(open, tab = drawerTab) {
        drawerOpen = open;
        drawerTab = tab;
        renderDrawer();
    }

    function renderDrawer() {
        const tabs = drawerTabs();
        if (!tabs.some(([id]) => id === drawerTab)) drawerTab = tabs[0][0];
        fill($('[data-drawer-tabs]', view), tabs.map(([id, label]) => `<button data-drawer-tab="${id}" style="--tab:${DRAWER_TABS[id].color}" class="${drawerOpen && id === drawerTab ? 'active' : ''}">${label}</button>`).join(''));
        drawer.classList.toggle('open', drawerOpen);
        drawer.style.setProperty('--tab', DRAWER_TABS[drawerTab].color);
        drawer.style.setProperty('--drawer-height', `${Math.min(prefs.drawerHeight, window.innerHeight * 0.8)}px`);
        $('[data-drawer-arrow]', view).src = `assets/UI/${drawerOpen ? 'down' : 'up'}.png`;
        renderDrawerBody();
    }

    function renderDrawerBody() {
        if (!drawerOpen) return;
        // Don't redraw under someone who is typing.
        if (drawerBody.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')) return;
        if (holding) return;
        const html = { profile: profileHtml, cards: cardsHtml, settings: settingsHtml, admin: adminHtml }[drawerTab]?.() ?? '';
        fill(drawerBody, html);
    }

    /* ---------- Profile (riders) ---------- */

    function profileHtml() {
        const profile = gameProfile(platform);
        const difficulty = DIFFICULTIES.map((d) => `<option value="${d.value}" ${String(d.value) === String(profile.difficulty) ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
        return `
            <form class="stack" data-form="profile">
                <div class="bike-stats" data-bike-stats>
                    <button type="button" class="stat" data-act="power-view" title="Power (click to change)"><img src="assets/UI/Power.png" alt=""><b data-power>–</b><small data-power-unit>W</small></button>
                    <button type="button" class="stat" data-act="speed-view" title="Speed (click to change)"><span class="stat-icon">${icon('bike')}</span><b data-speed>–</b><small data-speed-unit>km/h</small></button>
                    <div class="stat" title="Cadence"><img src="assets/UI/Cadence.png" alt=""><b data-cadence>–</b><small>rpm</small></div>
                    <div class="stat" title="Heart rate"><img src="assets/UI/HeartRate.png" alt=""><b data-hr>–</b><small>bpm</small></div>
                </div>
                <div class="device"><span>${icon('bike')} ${deviceSummary(platform)}</span>
                    <button type="button" class="small" data-act="devices">${icon('bluetooth')} Devices</button></div>
                <div class="row wrap profile-row">
                    <label class="field grow"><span>Nickname</span><input name="nickname" maxlength="40" value="${esc(profile.nickname)}"></label>
                    <label class="field"><span>FTP (W)</span><input name="ftp" type="number" min="30" max="999" value="${profile.ftp}"></label>
                    <label class="field"><span>Weight (kg)</span><input name="weight" type="number" min="20" max="300" step="0.1" value="${profile.weight}"></label>
                    <label class="field"><span>Difficulty</span><select name="difficulty">${difficulty}</select></label>
                </div>
                <div class="row wrap">
                    <button type="button" class="ghost-toggle ${profile.ghost ? 'on' : ''}" data-act="ghost" title="Ghost mode">
                        <img src="assets/UI/${profile.ghost ? 'broadcastDeactivated' : 'broadcast'}.png" alt="">
                        <span><strong>${profile.ghost ? 'Ghost mode is on' : 'Your numbers are shown'}</strong>
                        <small class="muted">${profile.ghost ? 'Others see your place, name and score, not your power, heart rate, cadence or speed.' : 'Others see your power, heart rate, cadence and speed. Click for ghost mode.'}</small></span>
                    </button>
                </div>
                <p class="muted small-text">Changes count straight away, for Party Spin only. Click power or speed to change how they are shown.</p>
            </form>`;
    }

    function saveProfile(changes) {
        const profile = { ...gameProfile(platform), ...changes };
        saveGameProfile(platform, profile);
        const updated = riderInfo(platform);
        Object.assign(rider, updated);
        room.updateRider(updated);
        drawerBody.dataset.html = '';
        renderDrawerBody();
    }

    function readProfileForm(form) {
        const f = form.elements;
        const current = gameProfile(platform);
        return {
            nickname: f.nickname.value.trim() || current.nickname,
            ftp: Number(f.ftp.value) || current.ftp,
            weight: Number(f.weight.value) || current.weight,
            difficulty: Number(f.difficulty.value) || '',
        };
    }

    /* ---------- Cards (riders) ---------- */

    function cardsHtml() {
        const { hand, nope } = room.hand;
        const cards = room.cards;
        const slots = Array.from({ length: 5 }, (_, i) => (hand[i] ? cardTile(hand[i], cards, { slot: i }) : cardTile(null, cards, { empty: true })));
        const settings = room.info?.settings;
        const notes = [
            settings && !settings.powerups ? 'Power-ups are switched off: cards can not be played right now.' : '',
            settings?.break ? 'Break: nobody scores from riding, cards still work.' : '',
        ].filter(Boolean);
        return `<div class="hand">
            <div class="cards">${slots.join('')}
                <div class="nope-slot ${nope ? 'has' : ''}" title="Nope: cancel a card played on you">${nope ? cardTile(1, cards, { small: true }) : '<span>Nope</span>'}</div></div>
            ${notes.map((note) => `<p class="muted small-text">${note}</p>`).join('')}
            <p class="muted small-text">Keys: 1–5 a card · N Nope · A–D answer a question</p>
        </div>`;
    }

    function openCard(slot) {
        const card = room.hand.hand[slot];
        if (!card) return;
        const rules = room.cards[card];
        const others = room.players.filter((p) => p.id !== room.myId);
        const index = room.players.findIndex((p) => p.id === room.myId);
        let target = null;
        let targetHtml = '';
        if (rules.target === 'choose') {
            targetHtml = others.length
                ? `<p>Play it on:</p><div class="targets">${others.map((p) => `<button data-target="${esc(p.id)}">${esc(p.name)} <small>${formatPoints(p.score)}</small></button>`).join('')}</div>`
                : '<p class="muted">There is nobody to play it on yet.</p>';
        } else if (rules.target === 'behind') {
            const victim = room.players[index + 1];
            targetHtml = `<p>${victim ? `Hits <strong>${esc(victim.name)}</strong> (right behind you)` : 'Nobody is behind you.'}</p>`;
        } else if (rules.target === 'ahead') {
            const victim = room.players[index - 1];
            targetHtml = `<p>${victim ? `With <strong>${esc(victim.name)}</strong> (right ahead of you)` : 'You are already in the lead.'}</p>`;
        }
        const art = cardArt(card);
        const element = popup(`
            <div class="sheet glass card-sheet" style="--card:${cardColor(card)}">
                ${art ? `<img class="card-art" src="${art}" alt="">` : `<div class="card-art icon-art"><img src="${cardIcon(card)}" alt=""></div>`}
                <h2>${esc(rules.name)}</h2>
                <p>${esc(rules.text)}</p>
                ${targetHtml}
                <div class="row wrap">
                    <button class="primary" data-act="play" ${rules.target === 'choose' ? 'disabled' : ''}>Play ${esc(rules.name)}</button>
                    <button class="ghost" data-act="discard">Throw away</button>
                    <button class="ghost" data-close>Cancel</button>
                </div>
            </div>`, { key: 'card', className: 'center', dismissible: true });
        element.addEventListener('click', (event) => {
            const pick = event.target.closest('[data-target]');
            if (pick) {
                target = pick.dataset.target;
                element.querySelectorAll('[data-target]').forEach((b) => b.classList.toggle('selected', b === pick));
                $('[data-act="play"]', element).disabled = false;
                return;
            }
            const act = event.target.closest('[data-act]')?.dataset.act;
            if (act === 'play') {
                room.send({ type: 'play', slot, card, target });
                element.close();
            } else if (act === 'discard') {
                room.send({ type: 'discard', slot });
                element.close();
            }
        });
    }

    /* ---------- Settings (everyone) ---------- */

    function settingsHtml() {
        const option = (views, current) => Object.entries(views).map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join('');
        return `<form class="stack" data-form="view">
            <label class="check"><input type="checkbox" name="autoJump" ${prefs.autoJump ? 'checked' : ''}>
                Jump to Events when something happens</label>
            ${isPlayer ? `<label class="check"><input type="checkbox" name="onlyMine" ${prefs.onlyMine ? 'checked' : ''}>
                Only show what affects me in Events (cards played by or on me, my effects; questions are always shown)</label>
            <div class="row wrap">
                <label class="field"><span>Power</span><select name="power">${option(POWER_VIEWS, prefs.power)}</select></label>
                <label class="field"><span>Speed</span><select name="speed">${option(SPEED_VIEWS, prefs.speed)}</select></label>
            </div>
            <p class="muted small-text">Power and speed are in Profile (click them to change). Without a speed from the bike, it is worked out from your power (flat road).</p>` : ''}
        </form>`;
    }

    /* ---------- Moderator ---------- */

    function adminHtml() {
        const info = room.info;
        if (!info) return '';
        const s = info.settings;
        const status = room.status;
        const tabs = [['game', 'Game'], ['quiz', 'Hakoot'], ['room', 'Room'], ['riders', `Riders (${room.players.length})`]];
        let body = '';
        if (adminTab === 'game') {
            body = `
                <div class="admin-game">
                    <div class="stack">
                        ${status === 'lobby' ? '<button class="primary big" data-admin="start">Start the game</button>' : ''}
                        ${status === 'paused' ? '<button class="primary big" data-admin="resume">Continue</button>' : ''}
                        ${status === 'running' ? `<button class="hold" data-hold="pause" style="--hold:0">Hold to pause the clock</button>` : ''}
                        ${status === 'running' || status === 'paused' ? '<button class="hold danger" data-hold="end" style="--hold:0">Hold to end the game</button>' : ''}
                        <button class="ghost" data-admin="restart">Restart (scores and cards to zero)</button>
                    </div>
                    <div class="stack">
                        <label class="switch ${s.break ? 'on' : ''}"><input type="checkbox" data-setting="break" ${s.break ? 'checked' : ''}><span><strong>Break</strong><small>Nobody scores; cards still work, the clock goes on</small></span></label>
                        <label class="switch ${s.powerups ? 'on' : ''}"><input type="checkbox" data-setting="powerups" ${s.powerups ? 'checked' : ''}><span><strong>Power-ups</strong><small>Riders can play their cards</small></span></label>
                        <div class="row"><button data-admin="deal" ${status === 'running' ? '' : 'disabled'}>Deal cards to everyone</button>
                            <select data-deal><option>1</option><option>2</option><option>3</option></select></div>
                        <p class="muted small-text">Scoring: ${esc(MODES[s.mode]?.label ?? s.mode)} · ${esc(endCondition(s, 0))}</p>
                    </div>
                </div>`;
        } else if (adminTab === 'quiz') {
            const asked = new Set(room.eventList().filter((e) => e.type === 'hakoot').map((e) => e.quiz));
            body = `
                <p class="muted small-text">Questions are sent to the riders shortly before their time and shown exactly then. The right answer stays on the server.</p>
                <ul class="quiz-list">${(info.quiz ?? []).filter((q) => q.type !== 'poker').map((q) => `
                    <li class="${asked.has(q.id) ? 'asked' : ''}"><b>${formatClock(q.at * 1000)}</b><span class="grow">${esc(q.question)}</span>
                        <button class="small" data-quiz="launch" data-id="${esc(q.id)}" ${status === 'running' ? '' : 'disabled'} title="Ask it in 8 seconds">Ask now</button>
                        <button class="small ghost" data-quiz="edit" data-id="${esc(q.id)}">Edit</button>
                        <button class="small ghost" data-quiz="delete" data-id="${esc(q.id)}" title="Delete">${icon('close')}</button></li>`).join('') || '<li class="muted">No questions yet.</li>'}</ul>
                <button class="primary" data-quiz="add">${icon('plus')} Add a question</button>`;
        } else if (adminTab === 'room') {
            body = `
                <form class="stack" data-form="room-settings">
                    <div class="row wrap">
                        <label class="field"><span>Scoring</span><select name="mode">${Object.entries(MODES).map(([v, m]) => `<option value="${v}" ${v === s.mode ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
                        <label class="field"><span>Game ends</span><select name="endType">
                            ${[['time', 'After a time (minutes)'], ['points', 'At a score'], ['manual', 'When I end it']].map(([v, l]) => `<option value="${v}" ${v === s.end.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                        <label class="field"><span>Value</span><input name="endValue" type="number" min="1" value="${s.end.value}"></label>
                    </div>
                    <div class="row wrap">
                        <label class="field"><span>Background</span><select name="background">
                            ${[['brick', 'Brick wall'], ['color', 'A colour'], ['video', 'A video (synced)']].map(([v, l]) => `<option value="${v}" ${v === s.display.background ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                        <label class="field"><span>Colour</span><input name="color" type="color" value="${esc(s.display.color)}"></label>
                        <label class="field grow"><span>Video address</span><input name="video" type="url" value="${esc(s.display.video)}" placeholder="https://…/class.mp4"></label>
                    </div>
                    <button class="primary" type="submit">Save</button>
                </form>`;
        } else {
            body = `<ul class="rider-list">${room.players.map((p) => `
                <li><i class="dot ${p.online ? 'on' : ''}"></i><span class="grow">${esc(p.name)}${p.ghost ? ' <small class="muted">ghost</small>' : ''}</span><small>${formatPoints(p.score)} · ${p.cards} cards</small>
                    <button class="small ghost" data-kick="${esc(p.id)}" title="Remove from the room">${icon('close')}</button></li>`).join('') || '<li class="muted">Nobody has joined yet.</li>'}</ul>
                <div class="row wrap">
                    <button class="ghost" data-admin="kick-offline" ${room.players.some((p) => !p.online) ? '' : 'disabled'}>Remove disconnected riders</button>
                    <button class="ghost" data-admin="kick-all" ${room.players.length ? '' : 'disabled'}>Remove all riders</button>
                </div>`;
        }
        return `<nav class="tabs">${tabs.map(([id, label]) => `<button data-admin-tab="${id}" class="${id === adminTab ? 'active' : ''}">${label}</button>`).join('')}</nav>${body}`;
    }

    async function adminAction(action) {
        if (action === 'restart') {
            const sure = await modal({ title: 'Restart the game?', body: 'Scores, cards and events start over (the game played so far is kept in the database). Riders who are not connected are taken out of the room; the others stay.',
                actions: [{ label: 'Cancel', value: false }, { label: 'Restart', primary: true, value: true }] }).closed;
            if (!sure) return;
        }
        if (action === 'kick-all' || action === 'kick-offline') {
            const all = action === 'kick-all';
            const count = room.players.filter((p) => all || !p.online).length;
            const sure = await modal({ title: all ? 'Remove all riders?' : 'Remove the disconnected riders?',
                body: (() => {
                    const is = count === 1 ? 'is' : 'are';
                    const who = `${count} rider${count === 1 ? '' : 's'}`;
                    return `${all ? `${who} ${is} sent back to the lobby` : `${who} who ${is} not connected ${is} taken out of the room`}. Their scores and cards are gone.`;
                })(),
                actions: [{ label: 'Cancel', value: false }, { label: 'Remove', primary: true, value: true }] }).closed;
            if (!sure) return;
        }
        if (action === 'deal') room.admin('deal', { count: Number($('[data-deal]', drawerBody).value) });
        else room.admin(action);
    }

    async function quizAction(action, id) {
        // Saved events have number ids (from the database), data-id is text.
        const quiz = [...(room.info.quiz ?? [])];
        const item = quiz.find((q) => String(q.id) === id);
        if (action === 'launch') { room.admin('launch', { id: item?.id }); return; }
        if (action === 'delete') { room.admin('quiz', { quiz: quiz.filter((q) => q !== item) }); return; }
        const edited = await editEvent(item ?? newEvent('hakoot', quiz));
        if (!edited) return;
        room.admin('quiz', { quiz: [...quiz.filter((q) => q.id !== edited.id), edited] });
    }

    /* Hold-to-confirm buttons (pause, end): the button fills up while it is held. */
    function startHold(button, pointerId) {
        const started = performance.now();
        holding = { button, frame: 0 };
        button.setPointerCapture?.(pointerId);
        const step = () => {
            if (holding?.button !== button) return;
            const share = Math.min(1, (performance.now() - started) / HOLD_MS);
            button.style.setProperty('--hold', share.toFixed(3));
            if (share >= 1) {
                const action = button.dataset.hold;
                stopHold();
                room.admin(action);
                return;
            }
            holding.frame = requestAnimationFrame(step);
        };
        holding.frame = requestAnimationFrame(step);
    }

    function stopHold() {
        if (!holding) return;
        cancelAnimationFrame(holding.frame);
        holding.button.style.setProperty('--hold', '0');
        holding = null;
        drawerBody.dataset.html = '';
        renderDrawerBody();
    }

    /* Dragging the drawer up and down by its bar. */
    function dragDrawer(event) {
        if (event.target.closest('button') && !event.target.closest('[data-act="drawer-toggle"]')) return;
        const startY = event.clientY;
        const startHeight = drawerOpen ? Math.min(prefs.drawerHeight, window.innerHeight * 0.8) : 0;
        let moved = false;
        let height = startHeight;
        const bar = event.currentTarget;
        const move = (e) => {
            if (!moved && Math.abs(e.clientY - startY) < 6) return;
            if (!moved) bar.setPointerCapture(e.pointerId);
            moved = true;
            drawer.classList.add('dragging', 'open');
            height = Math.max(0, Math.min(window.innerHeight * 0.8, startHeight + startY - e.clientY));
            drawer.style.setProperty('--drawer-height', `${height}px`);
            if (!drawerOpen) { drawerOpen = true; renderDrawerBody(); }
        };
        const up = () => {
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', up);
            bar.removeEventListener('pointercancel', up);
            drawer.classList.remove('dragging');
            if (!moved) return;
            draggedAt = performance.now();
            if (height < 90) setDrawer(false);
            else {
                prefs = { ...prefs, drawerHeight: Math.round(height) };
                setViewPrefs({ drawerHeight: prefs.drawerHeight });
                setDrawer(true);
            }
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
    }
    let draggedAt = 0;
    $('[data-drawer-bar]', view).addEventListener('pointerdown', dragDrawer);

    /* ================================================================ input */

    const actions = {
        leave: () => leave(),
        devices: () => showDevices(platform, deviceActions, () => { drawerBody.dataset.html = ''; renderDrawerBody(); }),
        fullscreen: () => toggleFullscreen(),
        'to-events': () => setPanel('events'),
        'power-view': () => { prefs.power = nextView(POWER_VIEWS, prefs.power); setViewPrefs({ power: prefs.power }); drawerBody.dataset.html = ''; renderDrawerBody(); },
        'speed-view': () => { prefs.speed = nextView(SPEED_VIEWS, prefs.speed); setViewPrefs({ speed: prefs.speed }); drawerBody.dataset.html = ''; renderDrawerBody(); },
        'drawer-toggle': () => { if (performance.now() - draggedAt > 300) setDrawer(!drawerOpen); },
        ghost: () => saveProfile({ ghost: !gameProfile(platform).ghost }),
        nope: (button) => room.send({ type: 'nope', of: Number(button.dataset.of) }),
        pump: () => tire?.game.stroke(),
        'sim-stop': () => { if (platform.bike) platform.bike.pedaling = false; },
    };

    view.addEventListener('click', async (event) => {
        const panelTab = event.target.closest('[data-panel-tab]');
        if (panelTab) { setPanel(panelTab.dataset.panelTab); return; }
        const drawerTabButton = event.target.closest('[data-drawer-tab]');
        if (drawerTabButton) {
            const tab = drawerTabButton.dataset.drawerTab;
            setDrawer(!(drawerOpen && drawerTab === tab), tab);
            return;
        }
        const slot = event.target.closest('[data-slot]');
        if (slot && drawer.contains(slot)) { openCard(Number(slot.dataset.slot)); return; }
        const choice = event.target.closest('[data-choice]');
        if (choice) {
            const question = happenings(room.clock()).question;
            if (question) answer(question, Number(choice.dataset.choice));
            return;
        }
        const adminTabButton = event.target.closest('[data-admin-tab]');
        if (adminTabButton) { adminTab = adminTabButton.dataset.adminTab; drawerBody.dataset.html = ''; renderDrawerBody(); return; }
        const adminButton = event.target.closest('[data-admin]');
        if (adminButton) { adminAction(adminButton.dataset.admin); return; }
        const quiz = event.target.closest('[data-quiz]');
        if (quiz) { quizAction(quiz.dataset.quiz, quiz.dataset.id); return; }
        const kick = event.target.closest('[data-kick]');
        if (kick) {
            const sure = await modal({ title: 'Remove this rider?', body: `${esc(playerName(kick.dataset.kick))} is sent back to the lobby and their score is gone.`,
                actions: [{ label: 'Cancel', value: false }, { label: 'Remove', primary: true, value: true }] }).closed;
            if (sure) room.admin('kick', { player: kick.dataset.kick });
            return;
        }
        const button = event.target.closest('[data-act]');
        if (button && actions[button.dataset.act]) actions[button.dataset.act](button);
    });

    view.addEventListener('pointerdown', (event) => {
        const button = event.target.closest('[data-hold]');
        if (button && event.button === 0) startHold(button, event.pointerId);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) view.addEventListener(type, () => { if (holding) stopHold(); });

    view.addEventListener('change', (event) => {
        const form = event.target.form;
        if (event.target.dataset.setting) {
            room.admin('settings', { settings: { [event.target.dataset.setting]: event.target.checked } });
            return;
        }
        if (form?.dataset.form === 'profile') saveProfile(readProfileForm(form));
        if (form?.dataset.form === 'view') {
            const f = form.elements;
            prefs = { ...prefs, autoJump: f.autoJump.checked, ...(f.power ? { power: f.power.value, speed: f.speed.value, onlyMine: f.onlyMine.checked } : {}) };
            setViewPrefs(prefs);
        }
    });

    view.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.target;
        if (form.dataset.form === 'profile') { document.activeElement?.blur(); return; }
        if (form.dataset.form !== 'room-settings') return;
        const f = form.elements;
        room.admin('settings', { settings: {
            mode: f.mode.value, end: { type: f.endType.value, value: Number(f.endValue.value) },
            display: { background: f.background.value, color: f.color.value, video: f.video.value.trim() },
        } });
        document.activeElement?.blur();
        toast('Saved');
    });

    const onKey = (event) => {
        if (event.target.matches?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
        if (!isPlayer) return;
        const key = event.key.toLowerCase();
        if (tire?.game.step === 'pump' && key === ' ') {
            event.preventDefault();
            tire.game.stroke();
            return;
        }
        if (/^[1-5]$/.test(key)) openCard(Number(key) - 1);
        if (key === 'n') {
            const incoming = incomingCards(room.eventList(), room.myId)[0];
            if (incoming && room.hand.nope) room.send({ type: 'nope', of: incoming.id });
        }
        const choice = ANSWER_KEYS.indexOf(event.key.toUpperCase());
        if (choice >= 0) {
            const question = happenings(room.clock()).question;
            const clock = room.clock();
            if (question && clock >= question.start + question.read && clock < question.start + question.read + question.answer && choice < question.answers.length) answer(question, choice);
        }
    };
    window.addEventListener('keydown', onKey);
    const onResize = () => renderDrawer();
    window.addEventListener('resize', onResize);

    /* ================================================================ the room */

    let leaving = false;
    function leave() {
        if (leaving) return;
        leaving = true;
        const exit = () => go('');
        if (tracker && tracker.state !== 'idle' && !summaryShown) showSummary(exit);
        else exit();
    }

    function showEnded() {
        const top = room.players.slice(0, 3);
        const place = isPlayer ? room.players.findIndex((p) => p.id === room.myId) + 1 : 0;
        const element = popup(`
            <div class="sheet glass podium">
                <img class="flag" src="assets/UI/finishFlag.png" alt="">
                <h2>Game over!</h2>
                <ol>${top.map((p, i) => `<li class="p${i + 1}"><b>${i + 1}</b> ${esc(p.name)} <span>${formatPoints(p.score)}</span></li>`).join('')}</ol>
                ${place ? `<p>You finished <strong>#${place}</strong> of ${room.players.length}.</p>` : ''}
                <div class="row wrap">
                    ${tracker ? `<button class="primary" data-act="summary">${icon('activities')} Your ride</button>` : ''}
                    <button data-close>Keep watching</button>
                    <button class="ghost" data-act="lobby">Back to the lobby</button>
                </div>
            </div>`, { key: 'ended', className: 'center', dismissible: true });
        element.addEventListener('click', (event) => {
            const act = event.target.closest('[data-act]')?.dataset.act;
            if (act === 'summary') { element.close(); showSummary(); }
            if (act === 'lobby') leave();
        });
    }

    function onEvent(event) {
        if (event.type === 'resolve' && isPlayer) {
            const touchesMe = (event.effects ?? []).some((e) => e.player === room.myId || e.to === room.myId || e.from === room.myId);
            const line = describe(event, room.eventList(), room.cards, playerName);
            if (touchesMe && line) toast(line);
        }
        if (event.type === 'nope' && isPlayer && room.events.get(event.of)?.owner === room.myId) toast(`${playerName(event.by)} said NOPE to your card!`);
        if (event.type === 'hakoot' && panel !== 'events' && !prefs.autoJump) toast('Hakoot! A question is coming up (Events)');
        renderHistory();
    }

    let welcomedOnce = false;
    let endedShown = false;
    stops.push(
        room.on('welcome', () => {
            if (!welcomedOnce) {
                welcomedOnce = true;
                if (room.status !== 'lobby') panel = 'board';
                // What happened before we came in is not news: don't jump for it.
                const answeredBefore = new Set(room.eventList().filter((e) => e.type === 'hakoot-result').map((e) => e.of));
                for (const event of room.eventList()) {
                    if (event.type === 'powerup') jumpedFor.add(`c${event.id}`);
                    if (event.type === 'hakoot' && answeredBefore.has(event.id)) jumpedFor.add(`q${event.id}`);
                }
                endedShown = room.status === 'ended';
            }
            renderAll();
        }),
        room.on('event', (event) => {
            if (!room.you) return;
            onEvent(event);
        }),
        room.on('hand', () => { renderDrawer(); }),
        room.on('room', (info) => {
            if (canSeeBackground()) setBackdrop(info.settings.display);
            renderPanels();
            renderLobby();
            renderDrawer();
            syncTracker();
        }),
        room.on('reset', () => {
            answered.clear();
            jumpedFor.clear();
            endedShown = false;
            closePopup('ended');
            renderHistory();
            toast('The host restarted the game');
        }),
        room.on('state', () => {
            syncTracker();
            renderPanels();
            renderLobby();
            if (drawerTab === 'admin') renderDrawerBody();
            if (room.status === 'ended' && !endedShown && !summaryShown) {
                endedShown = true;
                showEnded();
            }
        }),
        guardRoom(room, { go, roomName, editServer }),
        room.on('error', (error) => {
            if (error.code !== 'no-room') toast(error.message);
        }),
        room.on('closed', () => { toast('The room was deleted'); leave(); }),
        room.on('kicked', () => { toast('The host removed you from the room'); leave(); }),
    );

    function renderAll() {
        renderPanels();
        renderLobby();
        renderHistory();
        renderDrawer();
    }

    /* ---------- loops ---------- */

    const reportTimer = isPlayer ? setInterval(report, REPORT_EVERY) : null;
    const uiTimer = setInterval(() => {
        const clock = room.clock();
        if (isPlayer) {
            effects = activeEffects(room.eventList(), room.myId, clock);
            updateSpeed();
        }
        const h = happenings(clock);
        autoJump(h);
        renderHud(h);
        renderMe();
        renderEvents(h, clock);
        renderIncoming();
        if (canSeeBackground()) syncVideo(clock, room.status === 'running');
    }, 200);
    let frame = requestAnimationFrame(function draw() {
        if (panel === 'board') {
            scoreLine.draw(room.players, { me: room.myId });
            board.draw(room.players, { me: room.myId, badges });
        }
        if (tire) tire.game.draw(bike()?.power ?? 0);
        frame = requestAnimationFrame(draw);
    });
    stops.push(platform.on('devicechange', () => {
        syncTracker();
        if (drawerTab === 'profile') { drawerBody.dataset.html = ''; renderDrawerBody(); }
    }));

    renderAll();

    return () => {
        clearInterval(reportTimer);
        clearInterval(uiTimer);
        cancelAnimationFrame(frame);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
        stops.forEach((stop) => stop());
        if (platform.bike?.pedaling === false) platform.bike.pedaling = true;
        tracker?.destroy?.();
        room.leave();
    };
}
