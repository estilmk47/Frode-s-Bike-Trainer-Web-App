/**
 * 80s Highway – free ride and structured workouts in a neon 80s world.
 *
 * Screens (menus) are drawn into #panel; while no menu is open the ride HUD takes the controls.
 *   Zwift Click: Y menu · B back · A select/start · Z lap (on release) · Z+Y lap ↔ total
 *                free ride: ▲▼ slope (or target power) · ◀▶ change mode · shift L/R gear down/up
 *                workout:   shift L/R −/+ 2 % · ◀◀ or ▶▶ (twice) then ▲▼ moves between intervals
 *   Keyboard:   M menu, arrows, Q/E shift, L lap, V lap ↔ total, Space pause, Enter start
 */
import { getPlatform } from '../../core/platform.js';
import { createNavigation, CONTROLLER_ACTIONS } from '../../core/navigation.js';
import { applyTheme } from '../../core/settings.js';
import { local } from '../../core/storage.js';
import { esc, icon, modal, toast, listen } from '../../core/ui.js';
import { BACKGROUNDS, backgroundById } from './backgrounds.js';
import { Timeline, WorkoutStrip, workoutPreview, drawSessionGraph } from './graphs.js';
import { VirtualRoad, VirtualBike, TrainerControl, zoneColor, GEARS, DEFAULT_GEAR, SLOPE_LIMITS, POWER_LIMITS } from './ride.js';
import { parseWorkout, WorkoutError, FORMAT_RULES, libraryWorkouts, summarize, stepTarget, stepIndexAt, clock, minutes, EFFORTS } from './workout.js';

const APP_ID = '80sGarage';
const $ = (selector) => document.querySelector(selector);

const platform = await getPlatform();

/* =====================================================================================
 * Preferences (this browser) and custom workouts (per rider, this browser)
 * ===================================================================================== */

const PREFS_KEY = 'garage80s.prefs';
const prefs = {
    background: 'sunset',
    look: 'retro',          // 'retro' | 'clean'
    window: 180,            // s shown in the timeline
    panAt: 0.8,             // the timeline moves once "now" reaches this part of the width
    autoStart: true,        // start recording when you start pedalling
    autoPause: true,        // pause when you stop pedalling, continue when you start again
    browse: { duration: 'any', effort: 'any', source: 'all' },
    ...local.get(PREFS_KEY, {}),
};
const savePrefs = () => local.set(PREFS_KEY, prefs);

const workoutsKey = () => `garage80s.workouts.${platform.user?.username?.toLowerCase() ?? 'local'}`;
const myWorkouts = () => local.get(workoutsKey(), []);
const saveMyWorkouts = (list) => local.set(workoutsKey(), list);

function allWorkouts() {
    const mine = [];
    for (const w of myWorkouts()) {
        try {
            mine.push({ ...w, source: 'mine', category: 'My workout', workout: parseWorkout(w.code) });
        } catch {
            /* a broken saved workout is skipped (it can't be ridden) */
        }
    }
    return [...mine, ...libraryWorkouts()];
}

const ftp = () => Number(platform.settings.get('ftp', 200)) || 200;
const weight = () => Number(platform.settings.get('weight', 75)) || 75;
const metric = () => platform.settings.get('units') !== 'imperial';

/* =====================================================================================
 * Look and background
 * ===================================================================================== */

const backgroundHost = $('#background');
let background = null;

function setBackground(id) {
    background?.destroy();
    backgroundHost.replaceChildren();
    background = backgroundById(id).create(backgroundHost);
    prefs.background = backgroundById(id).id;
    savePrefs();
}

let graphTheme = {};
function applyLook() {
    document.documentElement.dataset.look = prefs.look;
    applyTheme(document, prefs.look === 'retro' ? 'dark' : platform.settings.get('theme'));
    const style = getComputedStyle(document.documentElement);
    const v = (name) => style.getPropertyValue(name).trim();
    graphTheme = {
        grid: v('--graph-grid'), label: v('--graph-label'), target: v('--graph-target'), heartRate: v('--graph-hr'),
        now: v('--graph-now'), shade: v('--graph-shade'), stepEdge: v('--graph-edge'),
    };
}

window.addEventListener('resize', () => background?.resize());

/* =====================================================================================
 * The ride
 * ===================================================================================== */

const road = new VirtualRoad();
const virtualBike = new VirtualBike(platform, road);
const trainer = new TrainerControl(platform);
const timeline = new Timeline($('#timeline'));
const strip = new WorkoutStrip($('#workout-strip'));
/** @type {import('../../modules/node_modules/cycling-power-ble/src/session_tracker.module.js').SessionTracker | null} */
let tracker = null;

function defaultTargetPower() {
    return Math.round((ftp() * 0.65) / POWER_LIMITS.step) * POWER_LIMITS.step;
}

function newRide(mode, entry = null) {
    return {
        mode,                 // null (in the garage) | 'free' | 'workout'
        entry,                // the workout entry {name, code, workout, ...}
        free: { control: 'slope', power: defaultTargetPower(), slope: 0, gear: DEFAULT_GEAR },
        wclock: 0,            // s into the workout (only runs while recording)
        multiplier: 1,
        pointerMode: false,   // ▲▼ move between intervals
        finished: false,      // workout done
        scope: 'session',     // stats shown: 'session' | 'lap'
        powerView: 'w',       // 'w' | '3s' | 'wkg' – per ride, not a user setting
        energyView: 'kj',     // 'kj' | 'kcal'
        climbed: 0,           // m while recording
        lapClimbed: 0,        // ride.climbed when the current lap started
        autoPaused: false,
        idleSince: null,
        startedAt: performance.now(),
        summary: null,        // { saved, title } after stopping
    };
}

let ride = newRide(null);

async function beginRide(mode, entry = null) {
    try {
        tracker?.destroy();
        tracker = await platform.createTracker({ bike: virtualBike, heartRateMonitor: platform.heartRateMonitor });
    } catch (error) {
        console.error(error);
        toast(platform.modulesError ?? `The ride could not start: ${error.message}`);
        return;
    }
    ride = newRide(mode, entry);
    timeline.clear();
    timeline.window = prefs.window;
    timeline.panAt = prefs.panAt;
    closePanels();
    buildHud();
    if (!connectedBike()) toast('No bike connected yet – open the menu (Y / M) and choose Devices.');
}

function endRideToGarage() {
    tracker?.destroy();
    tracker = null;
    ride = newRide(null);
    $('#hud').hidden = true;
    stack.length = 0;
    show('garage');
}

const connectedBike = () => (platform.bike?.isConnected ? platform.bike : null);

function heartRate() {
    const monitor = platform.heartRateMonitor;
    return (monitor?.isConnected ? monitor.heartRate : null) ?? connectedBike()?.heartRate ?? null;
}

/** Slope the rider is on (0 outside slope mode). */
const rideGrade = () => (ride.mode === 'free' && ride.free.control === 'slope' ? ride.free.slope : 0);
const rideTime = () => (performance.now() - ride.startedAt) / 1000;
const recording = () => !!tracker?.isRunning;

function targetAt(t) {
    const workout = ride.entry?.workout;
    if (!workout) return null;
    const index = stepIndexAt(workout, t);
    if (index >= workout.steps.length) return null;
    const step = workout.steps[index];
    return stepTarget(step, t - step.start, ftp()) * ride.multiplier;
}

function currentTarget() {
    if (ride.mode === 'workout') return ride.finished ? null : targetAt(ride.wclock);
    if (ride.mode === 'free' && ride.free.control === 'power') return ride.free.power;
    return null;
}

function desiredControl() {
    if (!ride.mode || ride.summary) return { mode: 'free' };
    if (ride.mode === 'free') {
        return ride.free.control === 'power'
            ? { mode: 'power', power: ride.free.power }
            : { mode: 'slope', grade: ride.free.slope, gear: ride.free.gear };
    }
    const target = currentTarget();
    return target == null ? { mode: 'free' } : { mode: 'power', power: target };
}

/* ---------- Session control ---------- */

function startSession() {
    if (!tracker || tracker.state !== 'idle') return;
    tracker.start();
    ride.climbed = 0;
    ride.lapClimbed = 0;
    ride.autoPaused = false;
    toast(ride.mode === 'workout' ? `${ride.entry.name} – go!` : 'Ride started');
    renderHud(true);
}

function togglePause() {
    if (!tracker) return;
    if (tracker.state === 'idle') return startSession();
    if (tracker.isRunning) { tracker.pause(); ride.autoPaused = false; }
    else if (tracker.isPaused) { tracker.resume(); ride.autoPaused = false; ride.idleSince = null; }
    renderHud(true);
}

function lap() {
    if (!tracker || !(tracker.isRunning || tracker.isPaused)) {
        toast('Start the ride first');
        return;
    }
    const index = tracker.lap();
    ride.lapClimbed = ride.climbed;
    toast(`Lap ${index + 1}`);
    renderHud(true);
}

function toggleScope() {
    ride.scope = ride.scope === 'session' ? 'lap' : 'session';
    renderHud(true);
}

function stopRide() {
    if (!tracker) return;
    if (tracker.state === 'idle') { endRideToGarage(); return; }
    if (tracker.isRunning || tracker.isPaused) tracker.stop();
    const name = ride.mode === 'workout' ? ride.entry.name : 'Free ride';
    ride.summary = { saved: false, title: `80s Highway · ${name}` };
    stack.length = 0;
    show('summary');
}

/* ---------- The ride tick (also runs while the tab is in the background) ---------- */

let lastTick = performance.now();
let lastSample = 0;
const powerWindow = []; // { t, p } of the last 3 s

function tick() {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    const bike = connectedBike();
    const power = bike?.power ?? 0;
    const climbedBefore = road.climbed;
    for (let left = Math.min(dt, 30); left > 0; left -= 0.1) road.step(Math.min(0.1, left), power, rideGrade(), weight());

    if (recording()) {
        ride.climbed += road.climbed - climbedBefore;
        if (ride.mode === 'workout' && !ride.finished) {
            ride.wclock += dt;
            if (ride.wclock >= ride.entry.workout.duration) finishWorkout();
        }
    }

    powerWindow.push({ t: now, p: power });
    while (powerWindow.length && powerWindow[0].t < now - 3000) powerWindow.shift();

    autoStartAndPause(bike, power, now);

    if (ride.mode && !ride.summary && now - lastSample >= 1000) {
        lastSample = now;
        timeline.add({ t: rideTime(), power: bike ? power : null, heartRate: heartRate(), target: currentTarget() });
    }

    trainer.want = desiredControl();
    trainer.update();
}
setInterval(tick, 100);

function autoStartAndPause(bike, power, now) {
    if (!ride.mode || !tracker || ride.summary || !bike) return;
    const pedalling = power > 0 || (bike.cadence ?? 0) > 0;
    if (tracker.state === 'idle') {
        if (prefs.autoStart && pedalling) startSession();
        return;
    }
    if (tracker.isRunning && prefs.autoPause) {
        if (pedalling) ride.idleSince = null;
        else {
            ride.idleSince ??= now;
            if (now - ride.idleSince > 3000) {
                tracker.pause();
                ride.autoPaused = true;
                renderHud(true);
            }
        }
    } else if (tracker.isPaused && ride.autoPaused && pedalling) {
        tracker.resume();
        ride.autoPaused = false;
        ride.idleSince = null;
        renderHud(true);
    }
}

function finishWorkout() {
    ride.finished = true;
    ride.wclock = ride.entry.workout.duration;
    ride.pointerMode = false;
    toast('Workout complete! Keep riding, or open the menu and stop to save it.', { duration: 6000 });
    renderHud(true);
}

/* ---------- Ride controls ---------- */

let lastUpDownTap = 0;

/** `held`: a repeat while the button or key is held down. */
function rideAction(action, held = false) {
    if (!ride.mode || ride.summary) return;
    switch (action) {
        case 'a':
            if (tracker?.state === 'idle') startSession();
            else if (tracker?.isPaused) togglePause();
            break;
        case 'menu': openMenu(); break;
        case 'lap': lap(); break;
        case 'scope': toggleScope(); break;
        case 'pause': togglePause(); break;
        case 'left': sidePress(-1); break;
        case 'right': sidePress(1); break;
        case 'up': upDown(1, held); break;
        case 'down': upDown(-1, held); break;
        case 'shiftL': shift(-1); break;
        case 'shiftR': shift(1); break;
        default: return;
    }
    renderHud(true);
}

function sidePress(direction) {
    if (ride.mode === 'free') setFreeControl(ride.free.control === 'slope' ? 'power' : 'slope');
    else if (ride.mode === 'workout' && ride.pointerMode) moveInterval(direction);
}

function setFreeControl(control) {
    ride.free.control = control;
    toast(control === 'power' ? `Power target: ${ride.free.power} W` : 'Slope & gear');
}

function upDown(direction, held) {
    if (ride.mode === 'free') {
        if (ride.free.control === 'power') changePower(direction * POWER_LIMITS.step);
        else changeSlope(direction * SLOPE_LIMITS.step);
        return;
    }
    // Workout: pressing up or down twice toggles moving between intervals.
    if (ride.mode !== 'workout' || held) return;
    const now = performance.now();
    if (now - lastUpDownTap < 500) {
        ride.pointerMode = !ride.pointerMode;
        lastUpDownTap = 0;
        toast(ride.pointerMode ? 'Interval mode: ▶ next interval, ◀ previous. Press ▲ or ▼ twice to stop.' : 'Interval mode off');
    } else {
        lastUpDownTap = now;
    }
}

function shift(direction) {
    if (ride.mode === 'free') {
        if (ride.free.control === 'power') changePower(direction * POWER_LIMITS.bigStep);
        else ride.free.gear = Math.min(GEARS, Math.max(1, ride.free.gear + direction));
    } else if (ride.mode === 'workout') {
        changeMultiplier(direction * 0.02);
    }
}

function changePower(delta) {
    ride.free.power = Math.min(POWER_LIMITS.max, Math.max(POWER_LIMITS.min, ride.free.power + delta));
}

function changeSlope(delta) {
    ride.free.slope = Math.round(Math.min(SLOPE_LIMITS.max, Math.max(SLOPE_LIMITS.min, ride.free.slope + delta)) * 10) / 10;
}

function changeMultiplier(delta) {
    // Added, not multiplied, so you can always get back to exactly 100 %.
    ride.multiplier = Math.round(Math.min(2, Math.max(0.5, ride.multiplier + delta)) * 100) / 100;
}

function moveInterval(direction) {
    const workout = ride.entry.workout;
    const steps = workout.steps;
    const index = Math.min(stepIndexAt(workout, ride.wclock), steps.length - 1);
    if (direction > 0) {
        if (index + 1 >= steps.length) { finishWorkout(); return; }
        ride.wclock = steps[index + 1].start;
    } else {
        const into = ride.wclock - steps[index].start;
        ride.wclock = into > 3 || index === 0 ? steps[index].start : steps[index - 1].start;
        ride.finished = false;
    }
}

/* =====================================================================================
 * HUD
 * ===================================================================================== */

const hud = $('#hud');
const cache = new Map();
function setHtml(element, key, html) {
    if (!element || cache.get(key) === html) return;
    cache.set(key, html);
    element.innerHTML = html;
}

function buildHud() {
    hud.hidden = false;
    cache.clear();
    $('#stats').className = 'stats-bar glass';
    $('#stats').innerHTML = `
        <div class="stats-state"><span class="chip" data-v="state"></span>
            <button class="chip lap" data-hud="scope" data-v="scope" title="Lap or whole ride (Z+Y / V)"></button></div>
        ${tile('time', 'Time')}
        <button class="stat-tile primary" data-hud="power" data-tile="power" title="Click to change (W, 3 s average, W/kg)">
            <span class="label" data-v="power-label"></span><span class="value" data-v="power"></span><span class="sub" data-v="power-sub"></span></button>
        ${tile('hr', 'Heart rate', 'hr')}
        ${tile('cadence', 'Cadence')}
        ${tile('speed', 'Speed')}
        ${tile('distance', 'Distance')}
        ${tile('elevation', 'Elevation')}
        <button class="stat-tile" data-hud="energy" data-tile="energy" title="Click to change (kJ or kcal)">
            <span class="label">Energy <span class="cycle">⇄</span></span><span class="value" data-v="energy"></span><span class="sub" data-v="energy-sub"></span></button>`;
    $('#side').className = 'side glass';
    $('#workout-area').hidden = ride.mode !== 'workout';
    $('#workout-box').className = 'workout-box glass';
    renderHud(true);
}

function tile(key, label, extra = '') {
    return `<div class="stat-tile ${extra}" data-tile="${key}"><span class="label">${label}</span>
        <span class="value" data-v="${key}"></span><span class="sub" data-v="${key}-sub"></span></div>`;
}

const value = (number, unit) => `${number}<small>${esc(unit)}</small>`;

function speedText(ms) {
    return metric() ? value((ms * 3.6).toFixed(1), 'km/h') : value((ms * 2.236936).toFixed(1), 'mph');
}

function distanceText(m) {
    if (metric()) return m < 1000 ? value(Math.round(m), 'm') : value((m / 1000).toFixed(2), 'km');
    return value((m / 1609.344).toFixed(2), 'mi');
}

function elevationText(m) {
    return metric() ? value(Math.round(m), 'm') : value(Math.round(m * 3.28084), 'ft');
}

function powerText(watts) {
    if (watts == null) return value('–', ride.powerView === 'wkg' ? 'W/kg' : 'W');
    if (ride.powerView === 'wkg') return value((watts / weight()).toFixed(1), 'W/kg');
    return value(Math.round(watts), 'W');
}

const POWER_VIEWS = { w: 'Power', '3s': 'Power 3 s', wkg: 'Power / kg' };

function threeSecondPower() {
    if (!powerWindow.length) return null;
    return powerWindow.reduce((sum, s) => sum + s.p, 0) / powerWindow.length;
}

let lastHud = 0;
function renderHud(force = false) {
    if (!ride.mode || hud.hidden) return;
    const now = performance.now();
    if (!force && now - lastHud < 200) return;
    lastHud = now;
    const bike = connectedBike();
    const stats = tracker ? tracker.getStats(ride.scope === 'lap' ? 'lap' : 'total') : null;
    const lapMode = ride.scope === 'lap';
    const q = (key) => hud.querySelector(`[data-v="${key}"]`);

    const state = !tracker ? 'idle' : tracker.state;
    const chip = q('state');
    chip.className = `chip ${state === 'running' ? 'rec' : state === 'paused' ? 'paused' : ''}`;
    setHtml(chip, 'state', { idle: 'Ready', running: 'Rec', paused: ride.autoPaused ? 'Auto pause' : 'Paused', stopped: 'Finished' }[state] ?? state);
    setHtml(q('scope'), 'scope', lapMode ? `Lap ${(stats?.lap ?? 0) + 1}` : 'Total');

    setHtml(q('time'), 'time', clock((stats?.activeTime ?? 0) / 1000));
    setHtml(q('time-sub'), 'time-sub', lapMode ? 'lap time' : '');

    const live = bike ? (ride.powerView === '3s' ? threeSecondPower() : bike.power) : null;
    setHtml(q('power-label'), 'power-label', `${POWER_VIEWS[ride.powerView]} <span class="cycle">⇄</span>`);
    setHtml(q('power'), 'power', powerText(live));
    const target = currentTarget();
    const avgPower = stats?.power.avg;
    setHtml(q('power-sub'), 'power-sub', [
        target != null ? `target ${Math.round(target)} W` : '',
        lapMode && avgPower != null ? `avg ${Math.round(avgPower)} W` : '',
    ].filter(Boolean).join(' · '));
    const zone = hud.querySelector('[data-tile="power"] .value');
    if (zone) zone.style.color = live != null && live > 0 ? zoneColor(live, ftp()) : '';

    const hr = heartRate();
    setHtml(q('hr'), 'hr', value(hr ?? '–', 'bpm'));
    setHtml(q('hr-sub'), 'hr-sub', lapMode && stats?.heartRate.avg ? `avg ${Math.round(stats.heartRate.avg)}` : '');
    setHtml(q('cadence'), 'cadence', value(bike?.cadence != null ? Math.round(bike.cadence) : '–', 'rpm'));
    setHtml(q('cadence-sub'), 'cadence-sub', lapMode && stats?.cadence.avg ? `avg ${Math.round(stats.cadence.avg)}` : '');
    setHtml(q('speed'), 'speed', speedText(road.speed));
    setHtml(q('speed-sub'), 'speed-sub', lapMode && stats?.speed.avg ? `avg ${speedText(stats.speed.avg / 3.6).replace(/<[^>]+>/g, ' ')}` : '');
    setHtml(q('distance'), 'distance', distanceText(stats?.distance ?? 0));
    const climbed = lapMode ? ride.climbed - ride.lapClimbed : ride.climbed;
    setHtml(q('elevation'), 'elevation', elevationText(climbed));
    setHtml(q('elevation-sub'), 'elevation-sub', rideGrade() ? `${rideGrade() > 0 ? '+' : ''}${rideGrade().toFixed(1)} %` : '');
    setHtml(q('energy'), 'energy', ride.energyView === 'kj'
        ? value(Math.round(stats?.energy ?? 0), 'kJ')
        : value(Math.round(stats?.calories ?? 0), 'kcal'));

    renderSide();
    renderMessage(state, bike);
    renderAlerts(bike);
    renderHints();
}

function renderSide() {
    const side = $('#side');
    let html = '';
    if (ride.mode === 'free') {
        const f = ride.free;
        const tabs = `<div class="tabs">
            <button data-hud="control" data-arg="power" aria-pressed="${f.control === 'power'}">Power target</button>
            <button data-hud="control" data-arg="slope" aria-pressed="${f.control === 'slope'}">Slope &amp; gear</button></div>`;
        if (f.control === 'power') {
            html = `${tabs}<h3>Target power</h3>
                <div class="row"><button data-hud="power-step" data-arg="-1" title="▼">−</button>
                    <div class="big">${f.power}<small> W</small></div>
                    <button data-hud="power-step" data-arg="1" title="▲">+</button></div>
                <p class="muted">${Math.round((f.power / ftp()) * 100)} % of FTP · ${(f.power / weight()).toFixed(1)} W/kg</p>`;
        } else {
            html = `${tabs}<h3>Slope</h3>
                <div class="row"><button data-hud="slope-step" data-arg="-1" title="▼">−</button>
                    <div class="big">${f.slope > 0 ? '+' : ''}${f.slope.toFixed(1)}<small> %</small></div>
                    <button data-hud="slope-step" data-arg="1" title="▲">+</button></div>
                <h3>Gear</h3>
                <div class="row"><button data-hud="gear-step" data-arg="-1" title="Shift left">−</button>
                    <div class="big">${f.gear}<small> / ${GEARS}</small></div>
                    <button data-hud="gear-step" data-arg="1" title="Shift right">+</button></div>
                <div class="gear-dots">${Array.from({ length: GEARS }, (_, i) => `<i class="${i < f.gear ? 'on' : ''}"></i>`).join('')}</div>`;
        }
        html += trainerNote();
    } else if (ride.mode === 'workout') {
        const workout = ride.entry.workout;
        const index = Math.min(stepIndexAt(workout, ride.wclock), workout.steps.length - 1);
        const next = workout.steps[index + 1];
        html = `<h3>Workout</h3><div><strong>${esc(ride.entry.name)}</strong></div>
            <p class="muted">${ride.finished ? 'Complete!' : `Interval ${index + 1} of ${workout.steps.length}`} ·
                ${clock(Math.max(0, workout.duration - ride.wclock))} left</p>
            ${next && !ride.finished ? `<p class="muted">Next: ${clock(next.duration)} @ ${Math.round(stepTarget(next, 0, ftp()) * ride.multiplier)} W${next.kind === 'ramp' ? ' ramp' : next.kind === 'break' ? ' (break)' : ''}</p>` : ''}
            <h3>Intensity</h3>
            <div class="row"><button data-hud="mult" data-arg="-1" title="Shift left">−</button>
                <div class="big">${Math.round(ride.multiplier * 100)}<small> %</small></div>
                <button data-hud="mult" data-arg="1" title="Shift right">+</button></div>
            ${ride.pointerMode
                ? `<div class="pointer-mode">Interval mode<br><span class="muted">◀ previous · ▶ next</span></div>`
                : ''}
            <div class="tabs"><button data-hud="interval" data-arg="-1">◀ Interval</button><button data-hud="interval" data-arg="1">Interval ▶</button></div>
            ${trainerNote()}`;
    }
    setHtml(side, 'side', html);
}

function trainerNote() {
    if (!connectedBike()) return '<p class="note warn">No bike connected.</p>';
    if (trainer.status === 'manual') {
        return ride.mode === 'free' && ride.free.control === 'slope'
            ? '<p class="note warn">This bike can\'t change its resistance – the slope only changes your speed.</p>'
            : '<p class="note warn">This bike can\'t set its power (no ERG) – ride to the target yourself.</p>';
    }
    return '';
}

function renderMessage(state, bike) {
    let html = '';
    if (!bike) {
        html = `<div class="headline">No bike</div><div class="subline">Connect your bike or trainer to ride.</div>
            <button class="primary" data-hud="devices">${icon('bluetooth')} Devices</button>`;
    } else if (state === 'idle') {
        html = prefs.autoStart
            ? '<div class="headline">Ready</div><div class="subline">Start pedalling to begin</div>'
            : `<div class="headline">Ready</div><div class="subline">Press ${keyName('a')} to start</div>`;
    } else if (state === 'paused') {
        html = ride.autoPaused
            ? '<div class="headline">Paused</div><div class="subline">Pedal to continue</div>'
            : `<div class="headline">Paused</div><div class="subline">Press ${keyName('a')} to continue</div>`;
    }
    setHtml($('#message'), 'message', html);
}

function renderAlerts(bike) {
    const alerts = [];
    const b = platform.bike;
    if (b && !b.isConnected && b.isConnecting) alerts.push('Reconnecting to the bike…');
    else if (b && !b.isConnected && ride.mode && tracker && tracker.state !== 'idle') alerts.push('The bike is disconnected.');
    if (platform.heartRateMonitor && !platform.heartRateMonitor.isConnected && platform.heartRateMonitor.isConnecting) alerts.push('Reconnecting to the heart-rate monitor…');
    setHtml($('#alerts'), 'alerts', alerts.map((a) => `<div class="alert glass">${icon('bluetooth')} ${esc(a)}</div>`).join(''));
}

/* ---------- Hints along the bottom ---------- */

const controllerConnected = () => !!platform.controller?.devices?.some((d) => d.connected);

const KEY_NAMES = {
    a: ['A', 'Enter'], b: ['B', 'Esc'], y: ['Y', 'M'], z: ['Z', 'L'], zy: ['Z+Y', 'V'],
    ud: ['▲▼', '↑↓'], lr: ['◀▶', '←→'], ud2: ['▲▲', '↑↑'], shiftL: ['Shift L', 'Q'], shiftR: ['Shift R', 'E'],
    move: ['◀▶▲▼', 'arrows'], pause: [null, 'Space'],
};

function keyName(key) {
    const [pad, keyboard] = KEY_NAMES[key];
    return controllerConnected() && pad ? pad : keyboard;
}

function hint(key, text) {
    const [pad, keyboard] = KEY_NAMES[key];
    const label = controllerConnected() ? pad : keyboard;
    if (!label) return '';
    const cls = controllerConnected() && ['a', 'b', 'y', 'z'].includes(key) ? `btn-${key}` : '';
    return `<span class="hint"><kbd class="${cls}">${esc(label)}</kbd>${esc(text)}</span>`;
}

function renderHints() {
    let html = '';
    const top = stack.at(-1);
    if (top) {
        html = hint('move', 'Move') + hint('a', 'Select') + hint('b', top.name === 'garage' ? 'Leave' : 'Back');
        if (ride.mode && !ride.summary) html += hint('y', 'Close menu');
    } else if (ride.mode) {
        if (ride.mode === 'free' && ride.free.control === 'power') {
            html = hint('ud', `±${POWER_LIMITS.step} W`) + hint('shiftL', `−${POWER_LIMITS.bigStep} W`) + hint('shiftR', `+${POWER_LIMITS.bigStep} W`) + hint('lr', 'Slope & gear');
        } else if (ride.mode === 'free') {
            html = hint('ud', 'Slope') + hint('shiftL', 'Gear down') + hint('shiftR', 'Gear up') + hint('lr', 'Power target');
        } else if (ride.pointerMode) {
            html = hint('lr', 'Previous / next interval') + hint('ud2', 'Done') + hint('shiftL', '−2 %') + hint('shiftR', '+2 %');
        } else {
            html = hint('shiftL', '−2 %') + hint('shiftR', '+2 %') + hint('ud2', 'Move between intervals');
        }
        if (tracker?.state === 'idle' || tracker?.isPaused) html += hint('a', tracker.state === 'idle' ? 'Start' : 'Continue');
        html += hint('z', 'Lap') + hint('zy', ride.scope === 'lap' ? 'Show total' : 'Show lap') + hint('pause', 'Pause') + hint('y', 'Menu');
    }
    setHtml($('#hints'), 'hints', html);
}

/* ---------- HUD clicks ---------- */

hud.addEventListener('click', (event) => {
    const button = event.target.closest('[data-hud]');
    if (!button) return;
    button.blur(); // keys go to the ride again
    const arg = Number(button.dataset.arg);
    switch (button.dataset.hud) {
        case 'menu': openMenu(); break;
        case 'scope': toggleScope(); break;
        case 'power': ride.powerView = { w: '3s', '3s': 'wkg', wkg: 'w' }[ride.powerView]; break;
        case 'energy': ride.energyView = ride.energyView === 'kj' ? 'kcal' : 'kj'; break;
        case 'control': setFreeControl(button.dataset.arg); break;
        case 'power-step': changePower(arg * POWER_LIMITS.step); break;
        case 'slope-step': changeSlope(arg * SLOPE_LIMITS.step); break;
        case 'gear-step': shift(arg); break;
        case 'mult': changeMultiplier(arg * 0.02); break;
        case 'interval': moveInterval(arg); break;
        case 'devices': show('devices'); break;
        default: return;
    }
    renderHud(true);
});

/* =====================================================================================
 * Drawing (every animation frame)
 * ===================================================================================== */

let lastFrame = performance.now();
function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    pollController(now);
    const bike = connectedBike();
    background?.render({
        dt, time: now / 1000, speed: road.speed, distance: road.distance, power: bike?.power ?? 0,
        grade: rideGrade(), zoneColor: zoneColor(bike?.power ?? 0, ftp()),
    });
    if (ride.mode && !hud.hidden) {
        renderHud();
        const future = ride.mode === 'workout' && !ride.finished ? futureTargets(now, timeline.window) : null;
        timeline.draw({ now: rideTime(), ftp: ftp(), future, theme: graphTheme });
        if (ride.mode === 'workout') drawWorkout();
    }
    requestAnimationFrame(frame);
}

/**
 * The targets of the next `span` seconds as corner points { dt, target }. The workout clock is
 * moved on between ticks, so the shape slides smoothly instead of stepping.
 */
function futureTargets(now, span) {
    const from = ride.wclock + (recording() ? Math.min(0.25, Math.max(0, (now - lastTick) / 1000)) : 0);
    const points = [];
    for (const step of ride.entry.workout.steps) {
        const a = Math.max(from, step.start);
        const b = Math.min(from + span, step.start + step.duration);
        if (b <= a) continue;
        points.push({ dt: a - from, target: stepTarget(step, a - step.start, ftp()) * ride.multiplier });
        points.push({ dt: b - from, target: stepTarget(step, b - step.start, ftp()) * ride.multiplier });
    }
    return points;
}

function drawWorkout() {
    const workout = ride.entry.workout;
    const x = strip.draw({ workout, ftp: ftp(), multiplier: ride.multiplier, position: ride.wclock, theme: graphTheme });
    const index = Math.min(stepIndexAt(workout, ride.wclock), workout.steps.length - 1);
    const step = workout.steps[index];
    const left = ride.finished ? 0 : step.start + step.duration - ride.wclock;
    const target = currentTarget();
    const box = $('#workout-box');
    setHtml(box, 'workout-box', `
        <div><span class="label">${ride.finished ? 'Done' : 'Interval'}</span><span class="time">${clock(left)}</span></div>
        <div><span class="label">Target</span><span class="target">${target != null ? `${Math.round(target)} W` : '–'}</span></div>
        <div><span class="label">Intensity</span><span class="mult ${ride.multiplier !== 1 ? 'changed' : ''}">×${ride.multiplier.toFixed(2)}</span></div>`);
    const width = box.offsetWidth;
    const area = strip.canvas.clientWidth;
    box.style.left = `${Math.min(area - width / 2, Math.max(width / 2, x))}px`;
}

/* =====================================================================================
 * Input: Zwift controller and keyboard
 * ===================================================================================== */

const REPEAT_DELAY = 450;
const REPEAT_RATE = 120;
const heldSince = new Map();
const combo = { y: false, z: false, used: false };

/** Ride: controller button → ride action. Both shift buttons on a side do the same. */
const RIDE_BUTTONS = {
    up: 'up', down: 'down', left: 'left', right: 'right',
    shiftUpL: 'shiftL', shiftDownL: 'shiftL', shiftUpR: 'shiftR', shiftDownR: 'shiftR',
    a: 'a', powerupR: 'a',
};
const RIDE_REPEATING = new Set(['up', 'down']);
const NAV_REPEATING = new Set(['next', 'prev', 'left', 'right', 'up', 'down']);

function pollController(now) {
    const controller = platform.controller;
    if (!controller) return;
    controller.update(); // this app owns update() while it is open (the hub pauses its own polling)

    if (stack.length) {
        for (const [button, action] of Object.entries(CONTROLLER_ACTIONS)) {
            const presses = controller.pressCount(button);
            for (let i = 0; i < presses; i++) panelAction(action);
            repeat(controller, button, presses, now, NAV_REPEATING.has(action), () => panelAction(action));
        }
        combo.y = combo.z = combo.used = false;
        return;
    }

    for (const [button, action] of Object.entries(RIDE_BUTTONS)) {
        const presses = controller.pressCount(button);
        for (let i = 0; i < presses; i++) rideAction(action);
        repeat(controller, button, presses, now, RIDE_REPEATING.has(action), () => rideAction(action, true));
    }
    // Y opens the menu and Z sets a lap when released; Z and Y together switch lap ↔ total.
    for (const button of ['y', 'z']) {
        if (controller.pressCount(button)) {
            combo[button] = true;
            if (combo.y && combo.z && !combo.used) { combo.used = true; rideAction('scope'); }
        }
    }
    for (const button of ['y', 'z']) {
        if (combo[button] && !controller.isDown(button)) {
            combo[button] = false;
            if (!combo.used) rideAction(button === 'y' ? 'menu' : 'lap');
            if (!combo.y && !combo.z) combo.used = false;
        }
    }
}

function repeat(controller, button, presses, now, repeating, run) {
    if (presses) heldSince.set(button, now + REPEAT_DELAY);
    if (!controller.isDown(button)) heldSince.delete(button);
    else if (repeating && heldSince.has(button) && now >= heldSince.get(button)) {
        run();
        heldSince.set(button, now + REPEAT_RATE);
    }
}

const RIDE_KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    q: 'shiftL', e: 'shiftR', '[': 'shiftL', ']': 'shiftR', '-': 'shiftL', '+': 'shiftR', '=': 'shiftR',
    l: 'lap', z: 'lap', v: 'scope', ' ': 'pause', Enter: 'a', Escape: 'menu', m: 'menu', y: 'menu',
};

// Capture phase: runs before the menu navigation, which only gets the keys while a menu is open.
window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const typing = event.target.matches?.('input:not([type="checkbox"]):not([type="radio"]), textarea');
    if (typing) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if ((key === 'm' || key === 'y') && stack.length) {
        event.preventDefault();
        event.stopPropagation();
        panelAction('options');
        return;
    }
    if (stack.length || !ride.mode) return;
    const action = RIDE_KEYS[key];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && !['up', 'down', 'shiftL', 'shiftR'].includes(action)) return;
    rideAction(action, event.repeat);
}, true);

/* =====================================================================================
 * Menus (panels)
 * ===================================================================================== */

const panelHost = $('#panel-host');
const panel = $('#panel');
const stack = []; // [{ name, data }]

const navigation = createNavigation(document, {
    onBack: () => panelBack(),
    onOptions: () => panelAction('options'),
    initial: () => firstControl(),
});

function firstControl() {
    return panel.querySelector('[data-autofocus]:not(:disabled)')
        ?? [...panel.querySelectorAll('button:not(:disabled)')].find((b) => !b.closest('.panel-head')) ?? null;
}

function panelAction(action) {
    if (action === 'options') {
        // Y / M: open or close the ride menu.
        if (!ride.mode || ride.summary) return;
        if (stack.length) closePanels(); else openMenu();
        return;
    }
    navigation.perform(action);
}

function show(name, data = {}) {
    // Remember where the cursor was, to put it back there when coming back.
    if (stack.length) stack.at(-1).returnKey = document.activeElement?.dataset?.key ?? null;
    stack.push({ name, data });
    renderPanel({ focus: 'first' });
}

function replaceTop(name, data = {}) {
    stack[stack.length - 1] = { name, data };
    renderPanel({ focus: 'first' });
}

function panelBack() {
    const top = stack.at(-1);
    if (!top) return;
    if (SCREENS[top.name].back) { SCREENS[top.name].back(top.data); return; }
    stack.pop();
    if (!stack.length && !ride.mode) { show('garage'); return; }
    renderPanel({ focus: 'return' });
}

function closePanels() {
    stack.length = 0;
    renderPanel();
}

function openMenu() {
    if (!ride.mode || ride.summary) return;
    stack.length = 0;
    show('menu');
}

/**
 * Draw the top screen. `focus`: 'first' (a new screen), 'keep' (same screen, re-rendered) or
 * 'return' (back on a screen: the control that opened the screen we came from).
 */
function renderPanel({ focus = 'keep' } = {}) {
    const top = stack.at(-1);
    if (!top) {
        panelHost.hidden = true;
        panel.removeAttribute('data-nav-trap');
        panel.innerHTML = '';
        document.activeElement?.blur?.();
        renderHints();
        return;
    }
    const screen = SCREENS[top.name];
    const previous = focus === 'keep' ? document.activeElement?.dataset?.key : focus === 'return' ? top.returnKey : null;
    panelHost.hidden = false;
    panelHost.className = `panel-host ${top.name === 'garage' ? 'garage' : ''}`;
    panel.className = 'panel glass';
    panel.setAttribute('data-nav-trap', '');
    panel.innerHTML = screen.render(top.data);
    for (const element of panel.querySelectorAll('[data-act]')) {
        element.dataset.key ??= `${element.dataset.act}|${element.dataset.arg ?? ''}`;
    }
    screen.after?.(panel, top.data);
    const again = previous ? panel.querySelector(`[data-key="${CSS.escape(previous)}"]`) : null;
    const target = again ?? (focus !== 'keep' || !panel.contains(document.activeElement) ? firstControl() : null);
    if (target) navigation.focus(target);
    if (focus === 'first') panel.scrollTop = 0;
    renderHints();
}

const rerender = () => renderPanel({ focus: 'keep' });

panel.addEventListener('click', (event) => {
    const element = event.target.closest('[data-act]');
    const top = stack.at(-1);
    if (!element || element.disabled || !top) return;
    const handler = SCREENS[top.name].actions?.[element.dataset.act] ?? COMMON_ACTIONS[element.dataset.act];
    handler?.(element.dataset.arg, element, top.data);
});

const head = (title, iconName = null, back = true) => `
    <div class="panel-head">
        ${back ? `<button class="small" data-act="back" title="Back (B / Esc)">${icon('back')}</button>` : ''}
        <h2>${iconName ? icon(iconName) : ''}${esc(title)}</h2>
    </div>`;

const option = (act, arg, label, pressed) => `<button data-act="${act}" data-arg="${esc(arg)}" aria-pressed="${pressed}">${esc(label)}</button>`;

/* ---------- Devices (connect from inside the app too) ---------- */

async function deviceCommand(run) {
    try {
        await run();
    } catch (error) {
        if (error?.name !== 'NotFoundError') toast(error?.message ?? String(error)); // NotFoundError: chooser cancelled
    }
    rerender();
}

const COMMON_ACTIONS = {
    back: () => panelBack(),
    devices: () => show('devices'),
    'bike-connect': () => deviceCommand(() => platform.connectBike()),
    'bike-sim': () => deviceCommand(() => platform.connectBike({ simulated: true })),
    'bike-off': () => deviceCommand(async () => platform.disconnectBike()),
    'hr-connect': () => deviceCommand(() => platform.connectHeartRate()),
    'hr-sim': () => deviceCommand(() => platform.connectHeartRate({ simulated: true })),
    'hr-off': () => deviceCommand(async () => platform.disconnectHeartRate()),
    'controller-add': () => deviceCommand(() => platform.addController()),
    home: () => leaveApp(),
};

function deviceState(device) {
    if (!device) return 'Not connected';
    if (device.isConnected) return `${esc(device.name ?? 'Connected')}${device.batteryLevel != null ? ` · ${device.batteryLevel} %` : ''}`;
    if (device.isConnecting) return 'Connecting…';
    return `${esc(device.name ?? 'Device')} (disconnected)`;
}

function devicesHtml() {
    const bt = platform.bluetooth.available;
    const bike = platform.bike;
    const hrm = platform.heartRateMonitor;
    const units = platform.controller?.devices ?? [];
    const btNote = bt ? '' : '<p class="muted">This browser has no Bluetooth (use Chrome or Edge). The simulators work everywhere.</p>';
    const modules = platform.modulesError ? `<div class="notice-box"><p>${esc(platform.modulesError)}</p></div>` : '';
    return `${modules}${btNote}<div class="device-cards">
        <section class="device-card ${bike?.isConnected ? 'connected' : ''}" data-nav-group>
            <span class="device-title">${icon('bike')} Bike / trainer</span>
            <span class="device-state">${deviceState(bike)}</span>
            <div class="button-row">
                <button class="${bike?.isConnected ? '' : 'primary'}" data-act="bike-connect" ${bt ? '' : 'disabled'}>${icon('bluetooth')} Connect</button>
                <button data-act="bike-sim">Simulator</button>
                ${bike?.isConnected || bike?.isConnecting ? '<button data-act="bike-off">Disconnect</button>' : ''}
            </div>
        </section>
        <section class="device-card ${hrm?.isConnected ? 'connected' : ''}" data-nav-group>
            <span class="device-title">${icon('heart')} Heart rate</span>
            <span class="device-state">${deviceState(hrm)}</span>
            <div class="button-row">
                <button data-act="hr-connect" ${bt ? '' : 'disabled'}>${icon('bluetooth')} Connect</button>
                <button data-act="hr-sim">Simulator</button>
                ${hrm?.isConnected || hrm?.isConnecting ? '<button data-act="hr-off">Disconnect</button>' : ''}
            </div>
        </section>
        <section class="device-card ${units.some((d) => d.connected) ? 'connected' : ''}" data-nav-group>
            <span class="device-title">${icon('gamepad')} Zwift Click v2 / Ride</span>
            <span class="device-state">${units.length ? units.map((d) => `${esc(d.name)}${d.connected ? '' : ' (disconnected)'}${d.battery != null ? ` · ${d.battery} %` : ''}`).join('<br>') : 'Not connected – add each unit (left and right) once.'}</span>
            <div class="button-row"><button data-act="controller-add" ${bt ? '' : 'disabled'}>${icon('plus')} Add unit</button></div>
        </section>
    </div>`;
}

/* ---------- Leaving ---------- */

async function leaveApp() {
    if (tracker && tracker.state !== 'idle' && !ride.summary?.saved) {
        const answer = await modal({
            title: 'Leave 80s Highway?',
            body: '<p>Your ride has not been saved. Leave anyway and lose it?</p>',
            actions: [{ label: 'Stay', value: 'stay', primary: true }, { label: 'Leave without saving', value: 'leave' }],
        }).closed;
        if (answer !== 'leave') return;
    }
    platform.home();
}

/* ---------- Workouts helpers ---------- */

function workoutById(id) {
    return allWorkouts().find((w) => w.id === id) ?? null;
}

const DURATIONS = [
    { id: 'any', label: 'Any', test: () => true },
    { id: 'short', label: '< 30 min', test: (s) => s < 30 * 60 },
    { id: 'medium', label: '30–60 min', test: (s) => s >= 30 * 60 && s <= 60 * 60 },
    { id: 'long', label: '60–90 min', test: (s) => s > 60 * 60 && s <= 90 * 60 },
    { id: 'epic', label: '90+ min', test: (s) => s > 90 * 60 },
];

function workoutFacts(summary) {
    return `<div class="facts">
        <div class="fact"><span class="label">Duration</span><span class="value">${minutes(summary.duration)}</span></div>
        <div class="fact"><span class="label">Effort</span><span class="value">${summary.effort}</span></div>
        <div class="fact"><span class="label">Intensity</span><span class="value">${Math.round(summary.intensity * 100)} %</span></div>
        <div class="fact"><span class="label">Avg power</span><span class="value">${Math.round(summary.average * ftp())} W</span></div>
        <div class="fact"><span class="label">TSS</span><span class="value">${Math.round(summary.tss)}</span></div>
    </div>`;
}

/** The text with the faulty part marked. */
function errorSnippet(text, error) {
    const from = Math.max(0, error.index - 30);
    const to = Math.min(text.length, error.index + error.length + 30);
    const bad = text.slice(error.index, error.index + error.length) || ' ';
    return `<pre class="code">${from > 0 ? '…' : ''}${esc(text.slice(from, error.index))}<mark>${esc(bad)}</mark>${esc(text.slice(error.index + error.length, to))}${to < text.length ? '…' : ''}</pre>`;
}

/* ---------- Session stats ---------- */

function normalizedPower(samples) {
    if (samples.length < 2) return null;
    // 1 s buckets → 30 s rolling average → 4th power mean.
    const end = Math.ceil(samples.at(-1).t / 1000);
    const seconds = new Array(end + 1).fill(null);
    for (const s of samples) seconds[Math.floor(s.t / 1000)] = s.power ?? 0;
    let lastValue = 0;
    for (let i = 0; i < seconds.length; i++) { if (seconds[i] == null) seconds[i] = lastValue; else lastValue = seconds[i]; }
    if (seconds.length < 30) return null;
    let sum = 0;
    let total = 0;
    let count = 0;
    for (let i = 0; i < seconds.length; i++) {
        sum += seconds[i];
        if (i >= 30) sum -= seconds[i - 30];
        if (i >= 29) { total += (sum / 30) ** 4; count++; }
    }
    return (total / count) ** 0.25;
}

function fact(label, html) {
    return `<div class="fact"><span class="label">${esc(label)}</span><span class="value">${html}</span></div>`;
}

const plain = (html) => html.replace(/<small>/g, ' ').replace(/<[^>]+>/g, '');

/* =====================================================================================
 * Screens
 * ===================================================================================== */

const SCREENS = {
    /* ---------- The garage: the first screen ---------- */
    garage: {
        render() {
            const bike = connectedBike();
            const notice = bike ? '' : `<div class="notice-box">
                <p>${icon('bluetooth')} <strong>No bike connected.</strong> Connect your bike or trainer – or try the simulator.</p>
                <div class="button-row" data-nav-group>
                    <button class="primary" data-act="bike-connect" ${platform.bluetooth.available ? '' : 'disabled'}>Connect bike</button>
                    <button data-act="bike-sim">Use the simulator</button>
                </div></div>`;
            const status = [
                bike ? `${icon('bike')} ${esc(bike.name ?? 'Bike')}` : null,
                heartRate() != null || platform.heartRateMonitor?.isConnected ? `${icon('heart')} Heart rate` : null,
                controllerConnected() ? `${icon('gamepad')} Controller` : null,
            ].filter(Boolean).map((s) => `<span class="chip">${s}</span>`).join('');
            return `
                <div class="garage-title"><span class="t80">80s</span><span class="tg">HIGHWAY</span></div>
                <p class="garage-tagline">Free ride or pick a workout. Neon on, legs ready.</p>
                ${status ? `<div class="device-strip">${status}</div>` : ''}
                ${notice}
                <div class="menu-list" data-nav-group>
                    <button class="primary" data-act="free" data-autofocus>${icon('bike')}<span>Free Ride</span><span class="sub">Ride at your own target power, or on your own slope with gears.</span></button>
                    <button data-act="browse">${icon('list')}<span>Browse Workouts</span><span class="sub">Structured workouts – or write your own.</span></button>
                    <button data-act="backgrounds">${icon('apps')}<span>Backgrounds</span><span class="sub">Choose the scenery and the look.</span></button>
                    <button data-act="devices">${icon('bluetooth')}<span>Devices</span><span class="sub">Bike, heart-rate monitor and Zwift Click.</span></button>
                    <button data-act="home">${icon('home')}<span>Exit to home</span><span class="sub">Back to Frode's Bike Trainer.</span></button>
                </div>`;
        },
        back: () => leaveApp(),
        actions: {
            free: () => beginRide('free'),
            browse: () => show('browse'),
            backgrounds: () => show('backgrounds'),
        },
    },

    /* ---------- Browse workouts ---------- */
    browse: {
        render() {
            const filter = prefs.browse;
            const duration = DURATIONS.find((d) => d.id === filter.duration) ?? DURATIONS[0];
            const list = allWorkouts().map((w) => ({ ...w, summary: summarize(w.workout, ftp()) })).filter((w) =>
                duration.test(w.summary.duration)
                && (filter.effort === 'any' || w.summary.effort === filter.effort)
                && (filter.source === 'all' || w.source === filter.source));
            const cards = list.map((w) => `
                <button data-act="open" data-arg="${esc(w.id)}">
                    <span class="name">${esc(w.name)}</span>
                    <span class="meta">${esc(w.category ?? '')} · ${minutes(w.summary.duration)} · ${w.summary.effort} · TSS ${Math.round(w.summary.tss)}</span>
                    ${workoutPreview(w.workout, ftp())}
                </button>`).join('');
            return `${head('Browse workouts', 'list')}
                <div class="filters">
                    <div class="option-row" data-nav-group><span class="label">Duration</span><div class="options">
                        ${DURATIONS.map((d) => option('filter-duration', d.id, d.label, filter.duration === d.id)).join('')}</div></div>
                    <div class="option-row" data-nav-group><span class="label">Effort</span><div class="options">
                        ${['any', ...EFFORTS].map((e) => option('filter-effort', e, e === 'any' ? 'Any' : e, filter.effort === e)).join('')}</div></div>
                    <div class="option-row" data-nav-group><span class="label">Show</span><div class="options">
                        ${option('filter-source', 'all', 'All', filter.source === 'all')}${option('filter-source', 'library', 'Library', filter.source === 'library')}${option('filter-source', 'mine', 'My workouts', filter.source === 'mine')}</div></div>
                </div>
                <p class="muted">Watts are calculated from your FTP (${ftp()} W – change it in Settings).</p>
                <div class="workout-list" data-nav-group>
                    <button class="create" data-act="create">${icon('plus')}<span class="name">Create your own</span><span class="meta">Write a workout in a few characters</span></button>
                    ${cards || '<p class="muted">No workouts match these filters.</p>'}
                </div>`;
        },
        actions: {
            'filter-duration': (arg) => { prefs.browse.duration = arg; savePrefs(); rerender(); },
            'filter-effort': (arg) => { prefs.browse.effort = arg; savePrefs(); rerender(); },
            'filter-source': (arg) => { prefs.browse.source = arg; savePrefs(); rerender(); },
            open: (id) => show('workout', { id }),
            create: () => show('create', { name: '', code: '' }),
        },
    },

    /* ---------- One workout ---------- */
    workout: {
        render({ id }) {
            const w = workoutById(id);
            if (!w) return `${head('Workout')}<p>This workout does not exist any more.</p>`;
            const summary = summarize(w.workout, ftp());
            return `${head(w.name, 'bolt')}
                <div class="workout-detail">${workoutPreview(w.workout, ftp(), { height: 110 })}</div>
                ${workoutFacts(summary)}
                ${w.description ? `<p>${esc(w.description)}</p>` : ''}
                <pre class="code">${esc(w.code)}</pre>
                <div class="button-row" data-nav-group>
                    <button class="primary" data-act="ride" data-autofocus>${icon('bike')} Ride this workout</button>
                    ${w.source === 'mine'
                        ? '<button data-act="edit">Edit</button><button class="danger" data-act="delete">Delete</button>'
                        : '<button data-act="copy">Edit a copy</button>'}
                </div>`;
        },
        actions: {
            ride: (_, __, { id }) => { const w = workoutById(id); if (w) beginRide('workout', w); },
            edit: (_, __, { id }) => { const w = workoutById(id); show('create', { id, name: w.name, code: w.code, description: w.description }); },
            copy: (_, __, { id }) => { const w = workoutById(id); show('create', { name: `${w.name} (my version)`, code: w.code, description: w.description }); },
            delete: async (_, __, { id }) => {
                const w = workoutById(id);
                const answer = await modal({
                    title: 'Delete workout?',
                    body: `<p>Delete "${esc(w.name)}" from your workouts?</p>`,
                    actions: [{ label: 'Keep it', value: 'keep', primary: true }, { label: 'Delete', value: 'delete' }],
                }).closed;
                if (answer !== 'delete') return;
                saveMyWorkouts(myWorkouts().filter((x) => x.id !== id));
                panelBack();
            },
        },
    },

    /* ---------- Create your own ---------- */
    create: {
        render(data) {
            return `${head(data.id ? 'Edit workout' : 'Create your own', 'plus')}
                <ul class="rules">${FORMAT_RULES.map(([rule, example]) => `<li><span>${esc(rule)}</span><code>${esc(example)}</code></li>`).join('')}</ul>
                <div class="editor">
                    <label>Name<input type="text" maxlength="60" data-field="name" value="${esc(data.name ?? '')}" placeholder="My workout"></label>
                    <label>Workout<textarea data-field="code" spellcheck="false" placeholder="ramp(40%, 70%, 10m), 4x(5m@95%, 3m b), 10m@50%">${esc(data.code ?? '')}</textarea></label>
                    <div class="status" data-status></div>
                    <div data-preview></div>
                </div>
                <div class="button-row" data-nav-group>
                    <button class="primary" data-act="ride-custom">${icon('bike')} Ride it</button>
                    <button data-act="save-custom">${icon('check')} Save to my workouts</button>
                </div>`;
        },
        after(element, data) {
            const name = element.querySelector('[data-field="name"]');
            const code = element.querySelector('[data-field="code"]');
            // Arrow keys move the text cursor here, not the menu cursor.
            code.addEventListener('keydown', (event) => { if (event.key.startsWith('Arrow')) event.stopPropagation(); });
            const update = () => {
                data.name = name.value;
                data.code = code.value;
                validate(element, data);
            };
            name.addEventListener('input', update);
            code.addEventListener('input', update);
            validate(element, data);
        },
        actions: {
            'ride-custom': (_, __, data) => {
                const workout = validate(panel, data);
                if (!workout) { toast('Fix the workout first – the red part shows what is wrong.'); return; }
                beginRide('workout', { id: data.id ?? 'custom', name: data.name.trim() || 'My workout', code: data.code, workout, source: 'mine' });
            },
            'save-custom': (_, __, data) => {
                const workout = validate(panel, data);
                if (!workout) { toast('Fix the workout first – the red part shows what is wrong.'); return; }
                const name = data.name.trim() || 'My workout';
                const list = myWorkouts();
                const id = data.id ?? `my-${Date.now().toString(36)}`;
                const entry = { id, name, code: data.code.trim(), description: data.description ?? '' };
                const index = list.findIndex((w) => w.id === id);
                if (index >= 0) list[index] = entry; else list.unshift(entry);
                saveMyWorkouts(list);
                toast(`"${name}" is saved in My workouts`);
                stack.pop();
                if (stack.at(-1)?.name === 'workout') stack.pop();
                show('workout', { id });
            },
        },
    },

    /* ---------- Backgrounds and look ---------- */
    backgrounds: {
        render() {
            return `${head('Backgrounds', 'apps')}
                <div class="choice-list" data-nav-group>
                    ${BACKGROUNDS.map((b) => `<button data-act="background" data-arg="${b.id}" aria-pressed="${prefs.background === b.id}">
                        <span>${esc(b.name)}</span><span class="sub">${esc(b.description)}</span></button>`).join('')}
                </div>
                <p class="muted">3D backgrounds are coming. The scenery moves with your speed.</p>
                <div class="menu-section">
                    <div class="option-row" data-nav-group><span class="label">Look</span><div class="options">
                        ${option('look', 'retro', 'Retro 80s', prefs.look === 'retro')}${option('look', 'clean', 'Clean', prefs.look === 'clean')}</div></div>
                </div>`;
        },
        actions: {
            background: (id) => { setBackground(id); rerender(); },
            look: (look) => { prefs.look = look; savePrefs(); applyLook(); rerender(); },
        },
    },

    /* ---------- Devices ---------- */
    devices: {
        render: () => `${head('Devices', 'bluetooth')}${devicesHtml()}`,
    },

    /* ---------- The ride menu (Y / M) ---------- */
    menu: {
        render() {
            const state = tracker?.state ?? 'idle';
            const main = state === 'idle'
                ? `<button class="primary" data-act="start" data-autofocus>Start</button>`
                : state === 'paused'
                    ? `<button class="primary" data-act="pause" data-autofocus>Continue</button>`
                    : `<button data-act="pause" data-autofocus>Pause</button>`;
            return `${head('Menu', 'settings')}
                <div class="button-row" data-nav-group>
                    ${main}
                    <button data-act="lap" ${state === 'running' || state === 'paused' ? '' : 'disabled'}>Lap</button>
                    <button class="danger" data-act="stop">${state === 'idle' ? 'Leave ride' : 'Stop &amp; finish'}</button>
                </div>
                <div class="menu-section">
                    <div class="option-row" data-nav-group><span class="label">Start</span><div class="options">
                        ${option('auto-start', 'toggle', 'When I start pedalling', prefs.autoStart)}
                        ${option('auto-pause', 'toggle', 'Pause & continue automatically', prefs.autoPause)}</div></div>
                    <div class="option-row" data-nav-group><span class="label">Power</span><div class="options">
                        ${option('power-view', 'w', 'Watts', ride.powerView === 'w')}${option('power-view', '3s', '3 s average', ride.powerView === '3s')}${option('power-view', 'wkg', 'W/kg', ride.powerView === 'wkg')}</div></div>
                    <div class="option-row" data-nav-group><span class="label">Energy</span><div class="options">
                        ${option('energy-view', 'kj', 'kJ', ride.energyView === 'kj')}${option('energy-view', 'kcal', 'kcal', ride.energyView === 'kcal')}</div></div>
                    <div class="option-row" data-nav-group><span class="label">Stats show</span><div class="options">
                        ${option('scope', 'session', 'Whole ride', ride.scope === 'session')}${option('scope', 'lap', 'Current lap', ride.scope === 'lap')}</div></div>
                    <div class="option-row" data-nav-group><span class="label">Graph window</span><div class="options">
                        ${[60, 180, 300, 600].map((s) => option('graph-window', s, `${s / 60} min`, prefs.window === s)).join('')}</div></div>
                    <div class="option-row" data-nav-group><span class="label">Graph moves at</span><div class="options">
                        ${[0.5, 0.66, 0.8, 0.9].map((p) => option('graph-pan', p, `${Math.round(p * 100)} %`, prefs.panAt === p)).join('')}</div></div>
                </div>
                <div class="menu-section">
                    <div class="button-row" data-nav-group>
                        <button data-act="devices">${icon('bluetooth')} Devices</button>
                        <button data-act="backgrounds">${icon('apps')} Background &amp; look</button>
                        <button data-act="home">${icon('home')} Exit to home</button>
                    </div>
                </div>`;
        },
        actions: {
            start: () => { startSession(); closePanels(); },
            pause: () => { togglePause(); closePanels(); },
            lap: () => { lap(); closePanels(); },
            stop: () => stopRide(),
            'auto-start': () => { prefs.autoStart = !prefs.autoStart; savePrefs(); rerender(); },
            'auto-pause': () => { prefs.autoPause = !prefs.autoPause; savePrefs(); rerender(); },
            'power-view': (view) => { ride.powerView = view; rerender(); },
            'energy-view': (view) => { ride.energyView = view; rerender(); },
            scope: (scope) => { ride.scope = scope; rerender(); },
            'graph-window': (s) => { prefs.window = Number(s); timeline.window = prefs.window; savePrefs(); rerender(); },
            'graph-pan': (p) => { prefs.panAt = Number(p); timeline.panAt = prefs.panAt; savePrefs(); rerender(); },
            backgrounds: () => show('backgrounds'),
        },
    },

    /* ---------- After stopping ---------- */
    summary: {
        render() {
            const stats = tracker.getStats('total');
            const laps = tracker.getLapStats();
            const samples = tracker.session.bikeSamples;
            const np = normalizedPower(samples);
            const s = ride.summary;
            const canSave = !!platform.user;
            const lapRows = laps.length > 1 ? `<table class="laps"><thead><tr><th>Lap</th><th>Time</th><th>Distance</th><th>Avg W</th><th>Max W</th><th>Avg HR</th></tr></thead><tbody>
                ${laps.map((l) => `<tr><td>${l.lap + 1}</td><td>${clock(l.activeTime / 1000)}</td><td>${plain(distanceText(l.distance))}</td>
                    <td>${l.power.avg != null ? Math.round(l.power.avg) : '–'}</td><td>${l.power.max != null ? Math.round(l.power.max) : '–'}</td>
                    <td>${l.heartRate.avg != null ? Math.round(l.heartRate.avg) : '–'}</td></tr>`).join('')}</tbody></table>` : '';
            return `${head('Ride summary', 'check', false)}
                <div class="editor"><label>Title<input type="text" maxlength="80" data-field="title" value="${esc(s.title)}" ${s.saved ? 'disabled' : ''}></label></div>
                <canvas class="summary-graph" data-graph></canvas>
                <div class="summary-grid">
                    ${fact('Time', clock(stats.activeTime / 1000))}
                    ${fact('Distance', distanceText(stats.distance))}
                    ${fact('Elevation', elevationText(ride.climbed))}
                    ${fact('Avg power', value(stats.power.avg != null ? Math.round(stats.power.avg) : '–', 'W'))}
                    ${fact('Max power', value(stats.power.max != null ? Math.round(stats.power.max) : '–', 'W'))}
                    ${fact('Normalized', value(np != null ? Math.round(np) : '–', 'W'))}
                    ${fact('Avg heart rate', value(stats.heartRate.avg != null ? Math.round(stats.heartRate.avg) : '–', 'bpm'))}
                    ${fact('Max heart rate', value(stats.heartRate.max != null ? Math.round(stats.heartRate.max) : '–', 'bpm'))}
                    ${fact('Avg cadence', value(stats.cadence.avg != null ? Math.round(stats.cadence.avg) : '–', 'rpm'))}
                    ${fact('Avg speed', speedText((stats.speed.avg ?? 0) / 3.6))}
                    ${fact('Work', value(Math.round(stats.energy ?? 0), 'kJ'))}
                    ${fact('Calories', value(Math.round(stats.calories ?? 0), 'kcal'))}
                </div>
                ${lapRows}
                ${canSave ? '' : '<div class="notice-box"><p>You are not logged in, so the ride can\'t be saved to an account. Download it, or log in from the home screen first (the ride stays here while this page is open).</p></div>'}
                <div class="button-row" data-nav-group>
                    ${s.saved
                        ? `<button class="primary" data-act="done" data-autofocus>${icon('check')} Done</button>`
                        : `<button class="primary" data-act="save" data-autofocus ${canSave ? '' : 'disabled'}>${icon('check')} Save to my activities</button>`}
                    <button data-act="tcx">${icon('download')} Download .tcx</button>
                    ${s.saved ? '' : `<button class="danger" data-act="discard">${s.armDiscard ? 'Really discard?' : 'Discard'}</button>`}
                </div>`;
        },
        after(element) {
            const title = element.querySelector('[data-field="title"]');
            title?.addEventListener('input', () => { ride.summary.title = title.value; });
            requestAnimationFrame(() => {
                const canvas = element.querySelector('[data-graph]');
                if (canvas) drawSessionGraph(canvas, tracker.session.bikeSamples.map((s) => ({ t: s.t / 1000, power: s.power })),
                    tracker.session.heartRateSamples.map((s) => ({ t: s.t / 1000, heartRate: s.heartRate })), ftp(), graphTheme);
            });
        },
        back: () => toast('Save or discard the ride first.'),
        actions: {
            save: async (_, button) => {
                button.disabled = true;
                const meta = tracker.session.meta;
                meta.title = ride.summary.title;
                meta.application = APP_ID;
                meta.elevationGain = Math.round(ride.climbed);
                meta.mode = ride.mode;
                if (ride.mode === 'workout') meta.workout = { name: ride.entry.name, code: ride.entry.code, multiplier: ride.multiplier };
                try {
                    await platform.saveSession(tracker, { applicationId: APP_ID, title: ride.summary.title });
                    ride.summary.saved = true;
                    toast('Saved to your activities');
                } catch (error) {
                    toast(`Could not save: ${error.message}`);
                }
                rerender();
            },
            tcx: () => {
                const name = (ride.summary.title || '80s Highway').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
                tracker.downloadTCX(`${name}.tcx`);
            },
            discard: async () => {
                if (!ride.summary.armDiscard) {
                    ride.summary.armDiscard = true;
                    rerender();
                    setTimeout(() => { if (ride.summary?.armDiscard) { ride.summary.armDiscard = false; if (stack.at(-1)?.name === 'summary') rerender(); } }, 5000);
                    return;
                }
                const answer = await modal({
                    title: 'Discard the ride?',
                    body: '<p>The ride is deleted for good – it can\'t be brought back.</p>',
                    actions: [{ label: 'Keep it', value: 'keep', primary: true }, { label: 'Discard', value: 'discard' }],
                }).closed;
                if (answer === 'discard') endRideToGarage();
                else { ride.summary.armDiscard = false; rerender(); }
            },
            done: () => endRideToGarage(),
        },
    },
};

/* ---------- Validation for "create your own" ---------- */

function validate(element, data) {
    const code = element.querySelector('[data-field="code"]');
    const status = element.querySelector('[data-status]');
    const preview = element.querySelector('[data-preview]');
    if (!code) return null;
    const text = data.code ?? '';
    if (!text.trim()) {
        code.classList.remove('invalid', 'valid');
        status.className = 'status';
        status.textContent = 'Write your workout above. It is checked while you type.';
        preview.innerHTML = '';
        return null;
    }
    try {
        const workout = parseWorkout(text);
        code.classList.remove('invalid');
        code.classList.add('valid');
        status.className = 'status ok';
        const summary = summarize(workout, ftp());
        status.textContent = `Looks good: ${workout.steps.length} intervals, ${minutes(workout.duration)}, ${summary.effort.toLowerCase()}.`;
        preview.innerHTML = workoutPreview(workout, ftp(), { height: 70 }) + workoutFacts(summary);
        return workout;
    } catch (error) {
        if (!(error instanceof WorkoutError)) throw error;
        code.classList.remove('valid');
        code.classList.add('invalid');
        status.className = 'status error';
        status.textContent = error.message;
        preview.innerHTML = errorSnippet(text, error);
        return null;
    }
}

/* =====================================================================================
 * Start
 * ===================================================================================== */

listen(platform, 'devicechange', () => {
    virtualBike.follow();
    trainer.resend();
    if (tracker && tracker.heartRateMonitor !== platform.heartRateMonitor) tracker.attachHeartRateMonitor(platform.heartRateMonitor);
    const top = stack.at(-1)?.name;
    if (top === 'devices' || top === 'garage') rerender();
    renderHud(true);
});
listen(platform, 'userchange', () => { if (stack.at(-1)?.name === 'browse') rerender(); });
listen(platform.settings, 'change', () => { applyLook(); renderHud(true); });

// Leave the trainer on a flat road when the app closes (it lives on in the hub).
window.addEventListener('pagehide', () => {
    const bike = connectedBike();
    if (bike?.capabilities?.control?.simulation) bike.setSimulation({ grade: 0 }).catch(() => {});
    tracker?.destroy();
    virtualBike.destroy();
});

applyLook();
setBackground(prefs.background);
platform.controller?.update(); // forget presses from before the app opened
show('garage');
requestAnimationFrame(frame);
