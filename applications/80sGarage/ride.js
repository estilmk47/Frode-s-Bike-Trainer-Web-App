/**
 * The ride itself: virtual road physics, the trainer control loop and the "virtual bike" the
 * session tracker records from.
 *
 * Speed and distance come from our own road model (power, slope and the rider's weight), like in
 * most cycling games – so every trainer and spin bike gives comparable numbers, also those that
 * report no or strange speeds. The recorded session uses the same values that are on screen.
 */

const G = 9.81;
const BIKE_MASS = 9;      // kg added to the rider's weight
const CDA = 0.32;         // m² – drag area, road bike on the hoods
const RHO = 1.225;        // kg/m³ – air density
const CRR = 0.004;        // rolling resistance
const DRIVETRAIN = 0.975; // efficiency

export const GEARS = 24;
export const DEFAULT_GEAR = 12;
const GEAR_GRADE = 0.5;   // % of extra slope the trainer gets for every gear above the middle one

export const SLOPE_LIMITS = { min: -10, max: 20, step: 0.5 };
export const POWER_LIMITS = { min: 50, max: 1000, step: 10, bigStep: 25 };

export class VirtualRoad {
    speed = 0;      // m/s
    distance = 0;   // m since the page opened
    climbed = 0;    // m of elevation gained since the page opened
    altitude = 0;   // m, relative

    /**
     * @param {number} dt s
     * @param {number} power W
     * @param {number} grade % (0 on flat roads, e.g. in ERG mode)
     * @param {number} riderWeight kg
     */
    step(dt, power, grade, riderWeight) {
        if (!(dt > 0)) return;
        dt = Math.min(dt, 0.25);
        const mass = riderWeight + BIKE_MASS;
        const angle = Math.atan(grade / 100);
        const v = this.speed;
        const drive = (Math.max(0, power) * DRIVETRAIN) / Math.max(v, 1.5);
        const resist = mass * G * (Math.sin(angle) + CRR * Math.cos(angle)) + 0.5 * RHO * CDA * v * v;
        let next = v + ((drive - resist) / (mass * 1.05)) * dt; // 5 % for the rotating wheels
        if (power <= 0 && grade >= 0) next = Math.min(next, v); // no rolling uphill without pedalling
        this.speed = Math.max(0, next);
        const travelled = ((v + this.speed) / 2) * dt;
        this.distance += travelled;
        const rise = travelled * Math.sin(angle);
        this.altitude += rise;
        if (rise > 0) this.climbed += rise;
    }
}

/**
 * Looks like a bike to the SessionTracker ({data, addEventListener('data')}) but reports the
 * virtual speed and distance. Follows whatever bike is connected to the platform.
 */
export class VirtualBike extends EventTarget {
    #platform;
    #road;
    #source = null;
    #off = null;
    #timestamp = null;

    constructor(platform, road) {
        super();
        this.#platform = platform;
        this.#road = road;
        this.follow();
    }

    get name() { return this.#source?.name ?? 'No bike'; }

    /** Re-attach after the platform's bike changed. */
    follow() {
        const bike = this.#platform.bike;
        if (bike === this.#source) return;
        this.#off?.();
        this.#source = bike;
        this.#off = bike?.on?.('data', () => this.#emit()) ?? null;
    }

    get data() {
        const bike = this.#source?.isConnected ? this.#source.data : null;
        return Object.freeze({
            timestamp: this.#timestamp,
            power: bike?.power ?? null,
            cadence: bike?.cadence ?? null,
            speed: bike ? this.#road.speed * 3.6 : null,
            distance: this.#road.distance,
            energy: bike?.energy ?? null,
            resistance: bike?.resistance ?? null,
            heartRate: bike?.heartRate ?? null,
        });
    }

    #emit() {
        this.#timestamp = this.#source?.timestamp ?? Date.now();
        this.dispatchEvent(new CustomEvent('data', { detail: this.data }));
    }

    destroy() { this.#off?.(); }
}

/**
 * Keeps the trainer on what the ride wants – ERG power, or slope + gear – sending at most one
 * command at a time and only when something changed.
 *
 *   want = { mode: 'power', power } | { mode: 'slope', grade, gear } | { mode: 'free' }
 */
export class TrainerControl {
    want = { mode: 'free' };
    /** What the trainer can do with the current want: 'ok' | 'manual' (follow it yourself) | 'none' */
    status = 'none';
    #platform;
    #sent = null;
    #busy = false;
    #lastSend = 0;

    constructor(platform) {
        this.#platform = platform;
    }

    /** Call every frame (cheap). */
    update() {
        const bike = this.#platform.bike;
        if (!bike?.isConnected) {
            this.status = 'none';
            this.#sent = null;
            return;
        }
        const command = this.#command(bike.capabilities?.control ?? {});
        this.status = command ? 'ok' : 'manual';
        if (!command || this.#busy) return;
        const key = JSON.stringify(command);
        if (key === this.#sent || performance.now() - this.#lastSend < 400) return;
        this.#busy = true;
        this.#lastSend = performance.now();
        const [method, value] = command;
        Promise.resolve(bike[method](value))
            .then(() => { this.#sent = key; })
            .catch((error) => { console.warn('Trainer command failed', method, value, error); this.#sent = key; })
            .finally(() => { this.#busy = false; });
    }

    /** Force the next update to send again (e.g. after a reconnect). */
    resend() { this.#sent = null; }

    #command(control) {
        const want = this.want;
        if (want.mode === 'power') {
            return control.targetPower ? ['setTargetPower', Math.round(want.power)] : null;
        }
        if (want.mode === 'slope') {
            const grade = Math.round((want.grade + (want.gear - DEFAULT_GEAR) * GEAR_GRADE) * 10) / 10;
            if (control.simulation) return ['setSimulation', { grade }];
            if (control.resistance) {
                return ['setResistancePercent', Math.round(Math.min(100, Math.max(0, 25 + grade * 4)))];
            }
            return null;
        }
        // Free: as light as the trainer goes on a flat road.
        if (control.simulation) return ['setSimulation', { grade: 0 }];
        return null;
    }
}

/** 5 power zones from the FTP. */
export const ZONES = [
    { name: 'Z1', upTo: 0.55, color: '#8f9bd6' },
    { name: 'Z2', upTo: 0.75, color: '#3d9bff' },
    { name: 'Z3', upTo: 0.90, color: '#3ddc84' },
    { name: 'Z4', upTo: 1.05, color: '#ffc93d' },
    { name: 'Z5', upTo: Infinity, color: '#ff6a3d' },
];

export function zoneOf(power, ftp) {
    const ratio = (power ?? 0) / (ftp || 200);
    return ZONES.findIndex((z) => ratio < z.upTo);
}

export function zoneColor(power, ftp) {
    return ZONES[zoneOf(power, ftp)].color;
}
