/** The timeline at the bottom of the ride, the workout strip and small workout previews. */
import { ZONES, zoneColor } from './ride.js';
import { stepTarget } from './workout.js';

/** A canvas that keeps its pixel size in sync with its CSS size. */
class AutoCanvas {
    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
    }

    fit() {
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (this.canvas.width !== Math.round(w * ratio) || this.canvas.height !== Math.round(h * ratio)) {
            this.canvas.width = Math.max(1, Math.round(w * ratio));
            this.canvas.height = Math.max(1, Math.round(h * ratio));
        }
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        return { w, h };
    }
}

/**
 * Power (filled, coloured by zone) and heart rate (red line) over the last minutes.
 * The view moves along once "now" reaches `panAt` of the width, leaving room on the right for the
 * upcoming workout targets.
 */
export class Timeline extends AutoCanvas {
    samples = [];        // { t (s), power, heartRate, target }
    window = 180;        // s
    panAt = 0.8;

    add(sample) {
        this.samples.push(sample);
        // Keep a little more than the longest window.
        const keepFrom = sample.t - 1300;
        while (this.samples.length && this.samples[0].t < keepFrom) this.samples.shift();
    }

    clear() { this.samples = []; }

    /**
     * @param {{now: number, ftp: number, future?: {dt: number, target: number}[], theme: object}} options
     *   future – the upcoming target power as corner points, dt seconds from now (workouts), or null
     */
    draw({ now, ftp, future, theme }) {
        const { w, h } = this.fit();
        const c = this.context;
        c.clearRect(0, 0, w, h);
        const start = Math.max(0, now - this.window * this.panAt);
        const end = start + this.window;
        const x = (t) => ((t - start) / (end - start)) * w;
        const top = 8;
        const visible = this.samples.filter((s) => s.t >= start - 2);

        let maxPower = ftp * 1.5;
        for (const s of visible) maxPower = Math.max(maxPower, (s.power ?? 0) * 1.1, (s.target ?? 0) * 1.1);
        const futureTargets = (future ?? []).map((f) => ({ t: now + f.dt, target: f.target }));
        for (const f of futureTargets) maxPower = Math.max(maxPower, f.target * 1.1);
        const y = (p) => h - ((p ?? 0) / maxPower) * (h - top);

        // FTP line and zone hints on the left edge
        c.save();
        c.setLineDash([4, 6]);
        c.strokeStyle = theme.grid;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(0, y(ftp));
        c.lineTo(w, y(ftp));
        c.stroke();
        c.restore();
        c.fillStyle = theme.label;
        c.font = '600 10px system-ui, sans-serif';
        c.fillText(`FTP ${Math.round(ftp)} W`, 6, y(ftp) - 4);
        let lower = 0;
        for (const zone of ZONES) {
            const upper = Math.min(zone.upTo * ftp, maxPower);
            c.fillStyle = zone.color;
            c.fillRect(0, y(upper), 3, y(lower) - y(upper));
            lower = upper;
            if (upper >= maxPower) break;
        }

        // Power: one filled segment per sample, coloured by zone; the top edge is solid.
        for (let i = 1; i < visible.length; i++) {
            const a = visible[i - 1];
            const b = visible[i];
            if (b.t - a.t > 5) continue; // a gap (e.g. the page was hidden)
            const color = zoneColor(b.power, ftp);
            c.fillStyle = hexAlpha(color, 0.38);
            c.beginPath();
            c.moveTo(x(a.t), h);
            c.lineTo(x(a.t), y(a.power));
            c.lineTo(x(b.t), y(b.power));
            c.lineTo(x(b.t), h);
            c.closePath();
            c.fill();
            c.strokeStyle = color;
            c.lineWidth = 2.5;
            c.beginPath();
            c.moveTo(x(a.t), y(a.power));
            c.lineTo(x(b.t), y(b.power));
            c.stroke();
        }

        // Workout targets: what was asked (behind) and what is coming (ahead).
        c.save();
        c.strokeStyle = theme.target;
        c.lineWidth = 2;
        c.setLineDash([6, 4]);
        c.beginPath();
        let pen = false;
        for (const s of visible) {
            if (s.target == null) { pen = false; continue; }
            if (pen) c.lineTo(x(s.t), y(s.target)); else c.moveTo(x(s.t), y(s.target));
            pen = true;
        }
        c.stroke();
        c.restore();
        if (futureTargets.length) {
            c.fillStyle = hexAlpha(theme.target, 0.13);
            c.strokeStyle = hexAlpha(theme.target, 0.75);
            c.lineWidth = 1.5;
            c.beginPath();
            c.moveTo(x(now), h);
            for (const f of futureTargets) c.lineTo(x(f.t), y(f.target));
            c.lineTo(x(futureTargets.at(-1).t), h);
            c.closePath();
            c.fill();
            c.stroke();
        }

        // Heart rate (own scale: 40–200 bpm)
        const hrY = (bpm) => h - ((bpm - 40) / 160) * (h - top);
        c.strokeStyle = theme.heartRate;
        c.lineWidth = 2;
        c.shadowColor = 'rgba(0,0,0,0.5)';
        c.shadowBlur = 3;
        c.beginPath();
        pen = false;
        for (const s of visible) {
            if (!s.heartRate) { pen = false; continue; }
            if (pen) c.lineTo(x(s.t), hrY(s.heartRate)); else c.moveTo(x(s.t), hrY(s.heartRate));
            pen = true;
        }
        c.stroke();
        c.shadowBlur = 0;

        // Now
        c.strokeStyle = theme.now;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x(now), 0);
        c.lineTo(x(now), h);
        c.stroke();

        // Time labels
        c.fillStyle = theme.label;
        c.font = '10px system-ui, sans-serif';
        const step = this.window <= 120 ? 30 : this.window <= 300 ? 60 : 120;
        for (let t = Math.ceil(start / step) * step; t < end; t += step) {
            c.fillText(`${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`, x(t) + 3, h - 4);
        }
    }
}

/** The whole workout, left to right, with the progress. */
export class WorkoutStrip extends AutoCanvas {
    draw({ workout, ftp, multiplier, position, theme }) {
        const { w, h } = this.fit();
        const c = this.context;
        c.clearRect(0, 0, w, h);
        const total = workout.duration;
        let max = ftp * 1.2;
        for (const step of workout.steps) max = Math.max(max, stepTarget(step, 0, ftp) * multiplier, stepTarget(step, step.duration, ftp) * multiplier);
        const x = (t) => (t / total) * w;
        const y = (p) => h - (p / (max * 1.05)) * (h - 4);

        for (const step of workout.steps) {
            const a = stepTarget(step, 0, ftp) * multiplier;
            const b = stepTarget(step, step.duration, ftp) * multiplier;
            const done = position >= step.start + step.duration;
            const color = zoneColor((a + b) / 2, ftp);
            c.fillStyle = hexAlpha(color, done ? 0.35 : 0.85);
            c.beginPath();
            c.moveTo(x(step.start), h);
            c.lineTo(x(step.start), y(a));
            c.lineTo(x(step.start + step.duration), y(b));
            c.lineTo(x(step.start + step.duration), h);
            c.closePath();
            c.fill();
            c.strokeStyle = theme.stepEdge;
            c.lineWidth = 1;
            c.stroke();
        }
        // Done part shaded, position marker
        c.fillStyle = theme.shade;
        c.fillRect(0, 0, x(position), h);
        c.strokeStyle = theme.now;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(x(position), 0);
        c.lineTo(x(position), h);
        c.stroke();
        return x(position);
    }
}

/** A small inline SVG of a workout's shape for lists. */
export function workoutPreview(workout, ftp, { height = 44 } = {}) {
    const total = workout.duration || 1;
    let max = ftp * 1.2;
    for (const step of workout.steps) max = Math.max(max, stepTarget(step, 0, ftp), stepTarget(step, step.duration, ftp));
    const W = 300;
    const y = (p) => (height - (p / (max * 1.05)) * height).toFixed(1);
    const shapes = workout.steps.map((step) => {
        const a = stepTarget(step, 0, ftp);
        const b = stepTarget(step, step.duration, ftp);
        const x0 = ((step.start / total) * W).toFixed(2);
        const x1 = (((step.start + step.duration) / total) * W).toFixed(2);
        return `<polygon points="${x0},${height} ${x0},${y(a)} ${x1},${y(b)} ${x1},${height}" fill="${zoneColor((a + b) / 2, ftp)}"/>`;
    });
    return `<svg class="workout-preview" viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" aria-hidden="true">${shapes.join('')}</svg>`;
}

/** The power of a finished session (summary screen). */
export function drawSessionGraph(canvas, samples, heartRates, ftp, theme) {
    const graph = new AutoCanvas(canvas);
    const { w, h } = graph.fit();
    const c = graph.context;
    c.clearRect(0, 0, w, h);
    if (samples.length < 2) return;
    const end = Math.max(samples.at(-1).t, heartRates.at(-1)?.t ?? 0) || 1;
    let max = ftp * 1.5;
    for (const s of samples) max = Math.max(max, (s.power ?? 0) * 1.05);
    const x = (t) => (t / end) * w;
    const y = (p) => h - ((p ?? 0) / max) * h;
    // Average into ~w buckets so long rides stay readable.
    const buckets = Math.max(10, Math.round(w / 2));
    const sums = new Array(buckets).fill(0);
    const counts = new Array(buckets).fill(0);
    for (const s of samples) {
        const i = Math.min(buckets - 1, Math.floor((s.t / end) * buckets));
        sums[i] += s.power ?? 0;
        counts[i]++;
    }
    let p = 0;
    for (let i = 0; i < buckets; i++) {
        if (counts[i]) p = sums[i] / counts[i]; // empty buckets (short rides) keep the previous value
        c.fillStyle = zoneColor(p, ftp);
        c.fillRect((i / buckets) * w, y(p), w / buckets + 0.5, h - y(p));
    }
    c.strokeStyle = theme.heartRate;
    c.lineWidth = 1.5;
    c.beginPath();
    heartRates.forEach((s, i) => {
        const yy = h - ((s.heartRate - 40) / 160) * h;
        if (i) c.lineTo(x(s.t), yy); else c.moveTo(x(s.t), yy);
    });
    c.stroke();
}

function hexAlpha(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}
