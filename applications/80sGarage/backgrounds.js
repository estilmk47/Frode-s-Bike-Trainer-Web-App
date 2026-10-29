/**
 * Backgrounds behind the ride. Each one is drawn into its own element, so a background can use a
 * 2D canvas (like these) or a three.js/WebGL scene later.
 *
 * A background: { id, name, description, create(container) → { render(frame), resize(), destroy() } }
 * render() is called every animation frame with
 *   { dt (s), time (s), speed (m/s), distance (m), power (W), grade (%), zoneColor }
 */

export const BACKGROUNDS = [
    {
        id: 'sunset',
        name: 'Synthwave Sunset',
        description: 'The classic: a neon grid racing towards a striped sun, mountains and palm trees.',
        create: (container) => new Synthwave(container, { sun: true, palms: true, stars: false, sky: ['#0b0630', '#2a0b4d', '#6b1d6e', '#d6336c'], grid: '#ff3cac' }),
    },
    {
        id: 'night',
        name: 'Night Drive',
        description: 'Midnight on the highway: stars, a cool blue grid and no sun.',
        create: (container) => new Synthwave(container, { sun: false, moon: true, palms: true, stars: true, sky: ['#02010d', '#070726', '#151049', '#2b1660'], grid: '#28d7ff' }),
    },
    {
        id: 'zone',
        name: 'Power Grid',
        description: 'The grid glows in the colour of your current power zone.',
        create: (container) => new Synthwave(container, { sun: true, palms: false, stars: true, sky: ['#050510', '#0c0c24', '#1b1440', '#3a1d5c'], grid: 'zone' }),
    },
    {
        id: 'plain',
        name: 'Plain',
        description: 'No animation. Calm, and kind to slow computers.',
        create: (container) => new Plain(container),
    },
];

export function backgroundById(id) {
    return BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0];
}

class CanvasBackground {
    constructor(container) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.context = this.canvas.getContext('2d');
        container.append(this.canvas);
        this.resize();
    }

    resize() {
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const { clientWidth: w, clientHeight: h } = this.container;
        this.width = w;
        this.height = h;
        this.canvas.width = Math.max(1, Math.round(w * ratio));
        this.canvas.height = Math.max(1, Math.round(h * ratio));
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.layout?.();
    }

    destroy() { this.canvas.remove(); }
}

class Plain extends CanvasBackground {
    render() {
        if (this.drawn === this.width * this.height) return;
        this.drawn = this.width * this.height;
        const g = this.context.createLinearGradient(0, 0, 0, this.height);
        g.addColorStop(0, '#120a2a');
        g.addColorStop(1, '#2a1240');
        this.context.fillStyle = g;
        this.context.fillRect(0, 0, this.width, this.height);
    }
}

/** Seeded random numbers so the scenery is the same every time. */
function random(seed) {
    return () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
    };
}

class Synthwave extends CanvasBackground {
    constructor(container, options) {
        super(container);
        this.options = options;
        this.offset = 0;          // grid scroll, 0..1 of a row
        this.side = 0;            // sideways scroll of the scenery
        this.horizonShift = 0;    // smoothed slope effect
        const r = random(7);
        this.stars = Array.from({ length: 140 }, () => ({ x: r(), y: r() ** 1.6, size: r() * 1.4 + 0.3, phase: r() * 6 }));
        this.mountains = [0, 1].map((layer) => {
            const r2 = random(11 + layer * 5);
            return Array.from({ length: 9 }, (_, i) => ({ x: i / 8, h: 0.35 + r2() * 0.65 }));
        });
        this.palms = Array.from({ length: 6 }, (_, i) => ({ z: i / 6, side: i % 2 ? 1 : -1, lean: (r() - 0.5) * 0.3 }));
    }

    layout() {
        this.cache = null; // static sky is redrawn after a resize
    }

    get horizon() { return this.height * (0.56 + this.horizonShift); }

    render({ dt, time, speed, grade, zoneColor }) {
        const { context: c, width: w, height: h, options } = this;
        // Uphill: the horizon rises; downhill: it sinks. Smoothed.
        const shiftGoal = Math.max(-0.08, Math.min(0.08, -(grade ?? 0) * 0.006));
        this.horizonShift += (shiftGoal - this.horizonShift) * Math.min(1, dt * 2);
        const horizon = this.horizon;
        const gridColor = options.grid === 'zone' ? (zoneColor ?? '#ff3cac') : options.grid;

        // Sky
        const sky = c.createLinearGradient(0, 0, 0, horizon);
        options.sky.forEach((color, i) => sky.addColorStop(i / (options.sky.length - 1), color));
        c.fillStyle = sky;
        c.fillRect(0, 0, w, horizon + 1);

        if (options.stars) {
            for (const s of this.stars) {
                const twinkle = 0.55 + 0.45 * Math.sin(time * 1.7 + s.phase);
                c.fillStyle = `rgba(255,255,255,${(0.25 + 0.6 * twinkle).toFixed(2)})`;
                c.fillRect(s.x * w, s.y * horizon * 0.85, s.size, s.size);
            }
        }
        if (options.sun) this.#sun(c, w / 2, horizon - h * 0.02, Math.min(w, h) * 0.22, time);
        if (options.moon) this.#moon(c, w * 0.72, horizon * 0.32, Math.min(w, h) * 0.06);

        this.side = (this.side + speed * dt * 0.0006) % 1;
        this.#mountains(c, horizon, w, h);

        // Ground
        const ground = c.createLinearGradient(0, horizon, 0, h);
        ground.addColorStop(0, '#1a0633');
        ground.addColorStop(1, '#05010d');
        c.fillStyle = ground;
        c.fillRect(0, horizon, w, h - horizon);

        // Grid: rows rush towards the rider with the speed.
        this.offset = (this.offset + speed * dt / 4) % 1; // a row every 4 m
        this.#grid(c, horizon, w, h, gridColor);
        if (options.palms) this.#palms(c, horizon, w, h, speed, dt);

        // Glow on the horizon line
        const glow = c.createLinearGradient(0, horizon - 30, 0, horizon + 30);
        glow.addColorStop(0, 'rgba(255,60,172,0)');
        glow.addColorStop(0.5, hexAlpha(gridColor, 0.55));
        glow.addColorStop(1, 'rgba(255,60,172,0)');
        c.fillStyle = glow;
        c.fillRect(0, horizon - 30, w, 60);
    }

    #sun(c, x, y, r, time) {
        c.save();
        c.beginPath();
        c.arc(x, y, r, Math.PI, 0);
        c.closePath();
        c.clip();
        const g = c.createLinearGradient(0, y - r, 0, y);
        g.addColorStop(0, '#ffe66d');
        g.addColorStop(0.5, '#ff9a3c');
        g.addColorStop(1, '#ff2d95');
        c.fillStyle = g;
        c.fillRect(x - r, y - r, r * 2, r);
        // The stripes slowly move down, like the classic sun.
        c.globalCompositeOperation = 'destination-out';
        const stripes = 7;
        for (let i = 0; i < stripes; i++) {
            const f = ((i + (time * 0.15) % 1) / stripes);
            const sy = y - r * 0.55 + f * r * 0.6;
            c.fillRect(x - r, sy, r * 2, 1 + f * r * 0.09);
        }
        c.restore();
        // Halo
        const halo = c.createRadialGradient(x, y - r * 0.4, r * 0.4, x, y - r * 0.4, r * 1.8);
        halo.addColorStop(0, 'rgba(255,90,160,0.25)');
        halo.addColorStop(1, 'rgba(255,90,160,0)');
        c.fillStyle = halo;
        c.fillRect(x - r * 2, y - r * 2.3, r * 4, r * 2.3);
    }

    #moon(c, x, y, r) {
        const halo = c.createRadialGradient(x, y, r * 0.8, x, y, r * 4);
        halo.addColorStop(0, 'rgba(150,200,255,0.25)');
        halo.addColorStop(1, 'rgba(150,200,255,0)');
        c.fillStyle = halo;
        c.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
        c.fillStyle = '#e8ecff';
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
    }

    #mountains(c, horizon, w, h) {
        const layers = [
            { points: this.mountains[0], height: h * 0.2, color: '#2b0f4f', line: '#b84dff', parallax: 0.4 },
            { points: this.mountains[1], height: h * 0.13, color: '#1c0838', line: '#ff3cac', parallax: 1 },
        ];
        for (const layer of layers) {
            for (const side of [-1, 1]) {
                c.beginPath();
                const edge = side < 0 ? 0 : w;
                const inner = w * 0.5 + side * w * 0.14; // keep the middle (the road and the sun) free
                c.moveTo(edge, horizon);
                const count = layer.points.length;
                for (let i = 0; i < count; i++) {
                    const f = i / (count - 1);
                    const x = edge + (inner - edge) * f;
                    const wave = Math.sin((f + this.side * layer.parallax * side) * Math.PI * 4) * 0.08;
                    const y = horizon - layer.height * (layer.points[i].h + wave) * (1 - f * 0.85);
                    c.lineTo(x, y);
                }
                c.lineTo(inner, horizon);
                c.closePath();
                c.fillStyle = layer.color;
                c.fill();
                c.strokeStyle = hexAlpha(layer.line, 0.8);
                c.lineWidth = 1.5;
                c.stroke();
            }
        }
    }

    #grid(c, horizon, w, h, color) {
        const depth = h - horizon;
        c.save();
        c.strokeStyle = color;
        c.shadowColor = color;
        c.shadowBlur = 6;
        // Rows: perspective spacing, moving towards the viewer.
        const rows = 18;
        for (let i = 0; i < rows; i++) {
            const z = (i + this.offset) / rows;         // 0 = horizon, 1 = at the rider
            const y = horizon + depth * z * z;
            c.globalAlpha = Math.min(1, z * 1.6);
            c.lineWidth = 0.6 + z * 1.8;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(w, y);
            c.stroke();
        }
        // Columns: lines from the vanishing point.
        c.globalAlpha = 0.85;
        c.lineWidth = 1.2;
        const columns = 26;
        for (let i = -columns; i <= columns; i++) {
            const bottom = w / 2 + (i / columns) * w * 2.2;
            c.beginPath();
            c.moveTo(w / 2 + (i / columns) * w * 0.08, horizon);
            c.lineTo(bottom, h);
            c.stroke();
        }
        c.restore();
    }

    #palms(c, horizon, w, h, speed, dt) {
        const depth = h - horizon;
        const sorted = [...this.palms];
        for (const palm of sorted) palm.z = (palm.z + speed * dt / 120) % 1;
        sorted.sort((a, b) => a.z - b.z);
        for (const palm of sorted) {
            const z = palm.z;
            if (z < 0.04) continue;
            const y = horizon + depth * z * z;
            const x = w / 2 + palm.side * (w * 0.1 + z * z * w * 0.9);
            const size = h * 0.55 * z * z + 6;
            c.globalAlpha = Math.min(1, z * 3);
            drawPalm(c, x, y, size, palm.lean * palm.side);
        }
        c.globalAlpha = 1;
    }
}

function drawPalm(c, x, y, size, lean) {
    c.save();
    c.translate(x, y);
    c.fillStyle = '#0a0216';
    c.strokeStyle = '#0a0216';
    // Trunk: a gently bending tapered line.
    const topX = size * (0.18 + lean);
    const topY = -size;
    c.lineCap = 'round';
    c.lineWidth = Math.max(1.5, size * 0.05);
    c.beginPath();
    c.moveTo(0, 0);
    c.quadraticCurveTo(size * 0.02, -size * 0.55, topX, topY);
    c.stroke();
    // Fronds
    c.lineWidth = Math.max(1, size * 0.035);
    for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (i - 3) * 0.48;
        const len = size * (0.42 + (i % 2) * 0.08);
        const ex = topX + Math.cos(a) * len;
        const ey = topY + Math.sin(a) * len * 0.55 + len * 0.35;
        c.beginPath();
        c.moveTo(topX, topY);
        c.quadraticCurveTo(topX + Math.cos(a) * len * 0.6, topY + Math.sin(a) * len * 0.5 - len * 0.1, ex, ey);
        c.stroke();
    }
    c.restore();
}

function hexAlpha(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m) return `rgba(255,60,172,${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}
