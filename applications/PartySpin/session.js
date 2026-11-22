/**
 * Your ride: the recording of your bike and heart rate, controlled by you (nothing records by
 * itself). One per page, made in main.js, so a ride goes on when you leave a room or join another.
 *
 *   Start     starts recording (needs a bike)
 *   Lap       starts a new lap
 *   Stop      stops the clock of the ride – Continue goes on with the same ride. (cycling-power-ble
 *             can't continue a session after its real stop(), so Stop is its pause(); the session
 *             is really stopped when it is saved, downloaded or thrown away.)
 *
 * The numbers are shown three ways: Live, the lap's averages and the whole ride's averages.
 * The controls are in the devices pop-up (shared.js) and in the leave menu of a room (room.js).
 */
import { icon, modal, toast, formatDuration } from '../../core/ui.js';
import { flatSpeed } from './rules.js';

const APP_ID = 'PartySpin';
export const RIDE_VIEWS = { live: 'Live', lap: 'Lap average', total: 'Ride average' };

export class Ride {
    tracker = null;
    view = 'live';
    #busy = false;

    constructor(platform) {
        this.platform = platform;
        // A bike that reconnects (or a switch to another one) keeps recording into the same ride.
        platform.on('devicechange', () => {
            if (!this.tracker) return;
            if (this.tracker.bike !== platform.bike) this.tracker.attachBike(platform.bike);
            if (this.tracker.heartRateMonitor !== platform.heartRateMonitor) this.tracker.attachHeartRateMonitor(platform.heartRateMonitor);
        });
    }

    get bike() { return this.platform.bike?.isConnected ? this.platform.bike : null; }
    /** 'none' (nothing recorded) | 'running' | 'stopped' (Continue, Save …) */
    get state() {
        if (!this.tracker || this.tracker.state === 'idle') return 'none';
        return this.tracker.isRunning ? 'running' : 'stopped';
    }
    /** Something recorded that isn't saved or thrown away yet. */
    get unsaved() { return this.state !== 'none'; }

    async start() {
        if (this.#busy || this.unsaved || !this.bike) return;
        this.#busy = true;
        try {
            this.tracker?.destroy?.();
            this.tracker = await this.platform.createTracker();
            this.tracker.start();
        } catch (error) {
            this.tracker = null;
            toast(this.platform.modulesError ?? `Recording could not start: ${error.message}`);
        } finally {
            this.#busy = false;
        }
    }

    lap() { if (this.state === 'running') this.tracker.lap(); }
    stop() { if (this.state === 'running') this.tracker.pause(); }
    resume() { if (this.state === 'stopped') this.tracker.resume(); }

    /** Really stop the session (before saving or downloading). */
    #finish() {
        if (this.tracker && this.tracker.state !== 'stopped' && this.tracker.state !== 'idle') this.tracker.stop();
    }

    async save(title) {
        this.#finish();
        await this.platform.saveSession(this.tracker, { applicationId: APP_ID, title });
        this.#clear();
    }

    download(title) {
        // A downloaded ride is finished: it can still be saved, not continued.
        this.#finish();
        this.tracker.downloadTCX(`${title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'party-spin'}.tcx`);
    }

    discard() { this.#clear(); }

    #clear() {
        this.tracker?.destroy?.();
        this.tracker = null;
    }

    get finished() { return this.tracker?.state === 'stopped'; }

    /** kcal burned for `kJ` of work on the bike (the same estimate as cycling-power-ble: 24 % gross efficiency). */
    kcal(kJ) {
        const efficiency = this.platform.modules?.session?.Session?.grossEfficiency ?? 0.24;
        return kJ / 4.184 / efficiency;
    }

    /**
     * The numbers for the chosen view. Live: {power, cadence, speed, hr, kcalPerHour, kcal} – kcal from
     * the bike's total energy since it connected. Averages: {power, cadence, speed, hr, time, distance, laps}.
     */
    numbers(view = this.view) {
        if (view === 'live' || !this.unsaved) {
            const bike = this.bike;
            const hrMonitor = this.platform.heartRateMonitor?.isConnected ? this.platform.heartRateMonitor : null;
            const power = bike?.power ?? null;
            const speed = bike ? (bike.speed > 0 ? bike.speed : flatSpeed(power ?? 0, Number(this.platform.settings.get('weight', 75)) || 75)) : null;
            return {
                power, cadence: bike?.cadence ?? null, speed, hr: hrMonitor?.heartRate ?? bike?.heartRate ?? null,
                kcalPerHour: power == null ? null : this.kcal(power * 3.6),      // W → kJ per hour
                kcal: bike?.energy == null ? null : this.kcal(bike.energy),
            };
        }
        const stats = this.tracker.getStats(view === 'lap' ? 'lap' : 'total');
        return {
            power: stats.power.avg, cadence: stats.cadence.avg, speed: stats.speed.avg, hr: stats.heartRate.avg,
            time: stats.activeTime, distance: stats.distance, energy: stats.energy,
            laps: this.tracker.session.laps.length,
        };
    }
}

/* ---------- The controls, as a part of a pop-up ---------- */

const round = (value) => (value == null || Number.isNaN(value) ? '–' : String(Math.round(value)));

export function rideStatsHtml(ride) {
    const view = ride.unsaved ? ride.view : 'live';
    const n = ride.numbers(view);
    const cell = (label, value, unit) => `<div><small>${label}</small><b>${value}${value === '–' ? '' : ` <i>${unit}</i>`}</b></div>`;
    const cells = [
        cell(view === 'live' ? 'Power' : 'Avg power', round(n.power), 'W'),
        cell(view === 'live' ? 'Cadence' : 'Avg cadence', round(n.cadence), 'rpm'),
        cell(view === 'live' ? 'Speed' : 'Avg speed', n.speed == null ? '–' : n.speed.toFixed(1), 'km/h'),
        cell(view === 'live' ? 'Heart rate' : 'Avg heart rate', n.hr ? round(n.hr) : '–', 'bpm'),
    ];
    if (view === 'live') {
        cells.push(cell('Burning', round(n.kcalPerHour), 'kcal/h'), cell('Burned', round(n.kcal), 'kcal'));
    }
    if (n.time != null) cells.push(cell(view === 'lap' ? `Lap ${n.laps}` : 'Time', formatDuration(Math.round(n.time / 1000)), ''));
    if (n.distance != null) cells.push(cell('Distance', (n.distance / 1000).toFixed(2), 'km'));
    return cells.join('');
}

/** The ride part of a pop-up (Devices, the leave menu). */
export function rideHtml(ride, { loggedIn }) {
    const state = ride.state;
    const status = { none: 'Not recording', running: 'Recording', stopped: ride.finished ? 'Finished' : 'Stopped' }[state];
    let buttons = '';
    if (state === 'none') {
        buttons = `<button class="primary" data-ride="start" ${ride.bike ? '' : 'disabled title="Connect a bike first"'}>Start</button>`;
    } else {
        buttons = state === 'running'
            ? '<button data-ride="lap">Lap</button><button class="primary" data-ride="stop">Stop</button>'
            : `${ride.finished ? '' : '<button class="primary" data-ride="resume">Continue</button>'}
               <button data-ride="save" ${loggedIn ? '' : 'disabled title="Log in to save rides"'}>${icon('activities')} Save</button>
               <button data-ride="tcx">${icon('download')} .tcx</button>
               <button class="ghost danger" data-ride="discard">Throw away</button>`;
    }
    const tabs = state === 'none' ? '' : `<nav class="tabs ride-tabs">${Object.entries(RIDE_VIEWS).map(([id, label]) => `<button data-ride-view="${id}" class="${id === ride.view ? 'active' : ''}">${label}</button>`).join('')}</nav>`;
    return `<div class="ride" data-ride-box>
        <div class="ride-head"><h3>Your ride</h3><span class="chip ride-state" data-state="${state}">${status}</span></div>
        ${tabs}
        <div class="facts ride-facts" data-ride-stats>${rideStatsHtml(ride)}</div>
        <div class="row wrap">${buttons}</div>
        ${state === 'none' ? '<p class="muted small-text">Nothing is recorded until you press Start. Your points don\'t depend on it.</p>' : ''}
    </div>`;
}

/**
 * Make the ride part of `element` work: the buttons, and the numbers every half second.
 * `render()` draws the whole pop-up again (after a button). @returns {() => void} stop
 */
export function bindRide(element, ride, { platform, title, render }) {
    const onClick = async (event) => {
        const tab = event.target.closest('[data-ride-view]');
        if (tab) { ride.view = tab.dataset.rideView; render(); return; }
        const button = event.target.closest('[data-ride]');
        if (!button) return;
        const act = button.dataset.ride;
        if (act === 'start') await ride.start();
        else if (act === 'lap') { ride.lap(); toast('New lap'); }
        else if (act === 'stop') ride.stop();
        else if (act === 'resume') ride.resume();
        else if (act === 'tcx') ride.download(title());
        else if (act === 'save') {
            button.disabled = true;
            try {
                await ride.save(title());
                toast('Saved to your activities');
            } catch (error) {
                toast(error.message);
            }
        } else if (act === 'discard') {
            const sure = await modal({ title: 'Throw this ride away?', body: 'It will not be saved anywhere.',
                actions: [{ label: 'Keep it', value: false }, { label: 'Throw away', primary: true, value: true }] }).closed;
            if (sure) ride.discard();
        }
        render();
    };
    element.addEventListener('click', onClick);
    const timer = setInterval(() => {
        if (!element.isConnected) { clearInterval(timer); return; }
        const box = element.querySelector('[data-ride-stats]');
        if (box) {
            const html = rideStatsHtml(ride);
            if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
        }
    }, 500);
    return () => { clearInterval(timer); element.removeEventListener('click', onClick); };
}

export const rideTitle = (roomName) => (roomName ? `Party Spin · ${roomName}` : 'Party Spin');
