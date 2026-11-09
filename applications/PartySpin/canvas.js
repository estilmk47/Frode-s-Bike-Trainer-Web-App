/** Canvas drawing: the leaderboard, the score line over it and the flat tyre mini-game. */
import { AVATAR_COLORS, avatarImage } from '../../core/ui.js';
import { formatPoints } from './rules.js';

const FONT_FUN = '"Super Funky", "Segoe UI", system-ui, sans-serif';
const FONT_UI = 'ui-rounded, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const PINK = '#D05CBC';
const LIME = '#B6E682';
const YELLOW = '#F7E928';

/** Keep the canvas' pixels in step with its CSS size. Returns the CSS size. */
function fit(canvas) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        canvas.width = Math.max(1, Math.round(w * ratio));
        canvas.height = Math.max(1, Math.round(h * ratio));
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { w, h, c: context };
}

const images = new Map();
function image(url) {
    if (!url) return null;
    let entry = images.get(url);
    if (!entry) {
        entry = new Image();
        entry.src = url;
        images.set(url, entry);
    }
    return entry.complete && entry.naturalWidth ? entry : null;
}

function avatarFor(player) {
    const user = { username: player.id, icon: player.avatar?.icon, icon_image: player.avatar?.image };
    return { color: AVATAR_COLORS[user.icon] ?? hashColor(player.id), picture: image(avatarImage(user)) };
}

function hashColor(text) {
    const colors = Object.values(AVATAR_COLORS);
    let hash = 0;
    for (const char of String(text)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return colors[hash % colors.length];
}

function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.roundRect(x, y, Math.max(0, w), h, Math.min(r, h / 2, Math.max(0, w) / 2));
}

/**
 * The scores as bars. Rows slide to their new place when the order changes.
 * big: the big-screen layout (larger rows, all riders).
 */
export class Leaderboard {
    #rows = new Map();      // id → { y (rows, animated), score (animated) }
    #last = performance.now();

    constructor(canvas, { big = false } = {}) {
        this.canvas = canvas;
        this.big = big;
    }

    /**
     * @param {object[]} players  sorted by score (from the server)
     * @param {{me?: string, badges?: (player) => string}} options  badges: short text after the name (effects)
     */
    draw(players, { me = null, badges = null } = {}) {
        const { w, h, c } = fit(this.canvas);
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.#last) / 1000);
        this.#last = now;
        c.clearRect(0, 0, w, h);
        if (!players.length) {
            c.fillStyle = 'rgba(255,255,255,0.7)';
            c.font = `600 ${this.big ? 22 : 14}px ${FONT_UI}`;
            c.textAlign = 'center';
            c.fillText('Waiting for riders …', w / 2, h / 2);
            c.textAlign = 'start';
            return;
        }

        const rowHeight = this.big ? Math.max(46, Math.min(78, h / Math.max(players.length, 5))) : 42;
        const visible = Math.max(1, Math.floor(h / rowHeight));
        // Small boards show the rows around you.
        const myIndex = players.findIndex((p) => p.id === me);
        let first = 0;
        if (players.length > visible && myIndex >= 0) first = Math.max(0, Math.min(myIndex - Math.floor(visible / 2), players.length - visible));
        const seen = new Set();
        players.forEach((player, index) => {
            seen.add(player.id);
            let row = this.#rows.get(player.id);
            if (!row) {
                row = { y: index - first, score: player.score };
                this.#rows.set(player.id, row);
            }
            const ease = Math.min(1, dt * 7);
            row.y += (index - first - row.y) * ease;
            row.score += (player.score - row.score) * Math.min(1, dt * 4);
            if (Math.abs(player.score - row.score) < 1) row.score = player.score;
        });
        for (const id of this.#rows.keys()) if (!seen.has(id)) this.#rows.delete(id);
        // Bars are measured against the leader's *shown* score, which counts up with everyone else's:
        // measured against the real one, every bar would jump back each second and crawl up again.
        const leader = Math.max(1, this.#rows.get(players[0].id).score);

        // Draw back to front so a row that moves up slides over the others.
        const order = players.map((p, i) => ({ p, i })).sort((a, b) => this.#rows.get(b.p.id).y - this.#rows.get(a.p.id).y);
        for (const { p: player, i: index } of order) {
            const row = this.#rows.get(player.id);
            const y = row.y * rowHeight;
            if (y < -rowHeight || y > h) continue;
            this.#row(c, player, index, row, y, w, rowHeight, leader, player.id === me, badges?.(player));
        }
    }

    #row(c, player, index, row, y, w, height, leader, isMe, badge) {
        const pad = this.big ? 8 : 4;
        const top = y + pad / 2;
        const inner = height - pad;
        const radius = inner / 2;
        c.globalAlpha = player.online === false ? 0.55 : 1;

        // Background bar: the score compared with the leader.
        roundRect(c, 0, top, w, inner, radius);
        c.fillStyle = isMe ? 'rgba(247, 233, 40, 0.16)' : 'rgba(0, 0, 0, 0.45)';
        c.fill();
        const barStart = inner * 2.2;
        // The leader's bar is always full (once there are points), so it never moves.
        const share = index === 0 ? (player.score > 0 ? 1 : 0) : Math.min(1, Math.max(0, row.score) / leader);
        const bar = (w - barStart) * share;
        const gradient = c.createLinearGradient(barStart, 0, w, 0);
        gradient.addColorStop(0, PINK);
        gradient.addColorStop(1, LIME);
        roundRect(c, 0, top, barStart + bar, inner, radius);
        c.fillStyle = gradient;
        c.globalAlpha *= 0.35;
        c.fill();
        c.globalAlpha = player.online === false ? 0.55 : 1;
        if (isMe) {
            roundRect(c, 1, top + 1, w - 2, inner - 2, radius);
            c.strokeStyle = YELLOW;
            c.lineWidth = 2;
            c.stroke();
        }

        // Place
        const centerY = top + inner / 2;
        c.textBaseline = 'middle';
        c.textAlign = 'center';
        c.fillStyle = index === 0 ? YELLOW : '#ffffff';
        c.font = `${Math.round(inner * 0.55)}px ${FONT_FUN}`;
        c.fillText(String(index + 1), radius, centerY + 1);

        // Avatar
        const avatar = avatarFor(player);
        const ax = inner * 1.55;
        const ar = inner * 0.38;
        c.save();
        c.beginPath();
        c.arc(ax, centerY, ar, 0, Math.PI * 2);
        c.fillStyle = avatar.color;
        c.fill();
        c.clip();
        if (avatar.picture) c.drawImage(avatar.picture, ax - ar, centerY - ar, ar * 2, ar * 2);
        c.restore();

        // Name, live numbers and effects
        c.textAlign = 'start';
        const textX = barStart + 6;
        const nameSize = Math.round(inner * (this.big ? 0.36 : 0.38));
        c.font = `700 ${nameSize}px ${FONT_UI}`;
        c.fillStyle = '#ffffff';
        const scoreText = formatPoints(row.score);
        c.font = `${Math.round(inner * 0.5)}px ${FONT_FUN}`;
        const scoreWidth = c.measureText(scoreText).width;
        c.font = `700 ${nameSize}px ${FONT_UI}`;
        const room = w - textX - scoreWidth - 20;
        c.fillText(clip(c, player.name, room), textX, centerY - inner * 0.14);
        // A rider in ghost mode only shows place, name and score.
        const watts = player.online === false ? 'offline' : player.ghost ? '' : player.eff != null ? `${Math.round(player.eff)} W` : '–';
        c.font = `600 ${Math.round(inner * 0.27)}px ${FONT_UI}`;
        c.fillStyle = 'rgba(255,255,255,0.75)';
        c.fillText(clip(c, [watts, badge].filter(Boolean).join('  ·  '), room), textX, centerY + inner * 0.24);

        // Score
        c.textAlign = 'end';
        c.font = `${Math.round(inner * 0.5)}px ${FONT_FUN}`;
        c.fillStyle = index === 0 ? YELLOW : '#ffffff';
        c.fillText(scoreText, w - radius * 0.7, centerY + 1);
        c.textAlign = 'start';
        c.textBaseline = 'alphabetic';
        c.globalAlpha = 1;
    }
}

/**
 * The top 10 on one line: the leader at the right end, the 10th (or last) at the left, everyone in
 * between where their score puts them, so you see the gaps. Avatar on the line, nickname above or
 * below it (taking turns, so close riders don't cover each other's names).
 */
export class ScoreLine {
    static SHOWN = 10;
    #x = new Map();         // id → position on the line (0 … 1, animated)
    #last = performance.now();

    constructor(canvas) {
        this.canvas = canvas;
    }

    draw(players, { me = null } = {}) {
        const { w, h, c } = fit(this.canvas);
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.#last) / 1000);
        this.#last = now;
        c.clearRect(0, 0, w, h);
        const top = players.slice(0, ScoreLine.SHOWN);
        if (!top.length || w < 60) return;

        const high = top[0].score;
        const low = top[top.length - 1].score;
        const span = high - low;
        const radius = Math.max(9, Math.min(15, h * 0.15));
        const left = radius + 6;
        const right = w - radius - 6;
        const lineY = Math.round(h / 2);

        // The line, and the scores at its ends.
        const gradient = c.createLinearGradient(left, 0, right, 0);
        gradient.addColorStop(0, PINK);
        gradient.addColorStop(1, LIME);
        c.lineCap = 'round';
        c.lineWidth = 5;
        c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        c.beginPath();
        c.moveTo(left, lineY + 1);
        c.lineTo(right, lineY + 1);
        c.stroke();
        c.lineWidth = 3;
        c.strokeStyle = gradient;
        c.beginPath();
        c.moveTo(left, lineY);
        c.lineTo(right, lineY);
        c.stroke();

        const seen = new Set();
        const placed = top.map((player, index) => {
            seen.add(player.id);
            // Level with the leader (or all level): at the leader's end.
            const target = span < 1 ? 1 : (player.score - low) / span;
            let x = this.#x.get(player.id);
            x = x == null ? target : x + (target - x) * Math.min(1, dt * 4);
            this.#x.set(player.id, x);
            return { player, index, x: left + x * (right - left) };
        });
        for (const id of this.#x.keys()) if (!seen.has(id)) this.#x.delete(id);

        // The last place first, so the leader is drawn on top.
        c.textAlign = 'center';
        for (const { player, index, x } of placed.reverse()) {
            const isMe = player.id === me;
            const avatar = avatarFor(player);
            c.globalAlpha = player.online === false ? 0.55 : 1;
            c.save();
            c.beginPath();
            c.arc(x, lineY, radius, 0, Math.PI * 2);
            c.fillStyle = avatar.color;
            c.fill();
            c.clip();
            if (avatar.picture) c.drawImage(avatar.picture, x - radius, lineY - radius, radius * 2, radius * 2);
            c.restore();
            c.beginPath();
            c.arc(x, lineY, radius, 0, Math.PI * 2);
            c.lineWidth = isMe || index === 0 ? 3 : 2;
            c.strokeStyle = isMe ? YELLOW : index === 0 ? LIME : 'rgba(0, 0, 0, 0.8)';
            c.stroke();

            // Names take turns above and below the line, two rows each side.
            const above = index % 2 === 0;
            const row = Math.floor(index / 2) % 2;
            const size = Math.max(10, Math.min(13, h * 0.12));
            const gap = radius + 4 + row * (size + 2);
            const y = above ? lineY - gap - size * 0.35 : lineY + gap + size * 0.85;
            c.font = `700 ${size}px ${FONT_UI}`;
            const label = clip(c, `${index + 1}. ${player.name}`, Math.max(50, Math.min(120, w / 5)));
            const labelX = Math.min(w - c.measureText(label).width / 2 - 2, Math.max(c.measureText(label).width / 2 + 2, x));
            c.lineWidth = 3;
            c.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            c.strokeText(label, labelX, y);
            c.fillStyle = isMe ? YELLOW : '#ffffff';
            c.fillText(label, labelX, y);
        }
        c.globalAlpha = 1;
        c.textAlign = 'start';
    }
}

function clip(c, text, width) {
    if (c.measureText(text).width <= width) return text;
    let cut = text;
    while (cut.length > 1 && c.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
    return `${cut}…`;
}

/**
 * The flat tyre mini-game (Thumbtacks): stop the bike, find the hole, pump the tyre.
 * The game only draws and counts; the caller decides when the bike has stopped.
 */
export class TireGame {
    step = 'stop';          // 'stop' | 'find' | 'pump' | 'done'
    strokes = 0;
    static STROKES = 20;
    #angle = 0;             // wheel rotation
    #hole = Math.PI * (0.15 + Math.random() * 1.7);     // where the thumbtack went in
    #puffs = [];
    #handle = 0;            // pump handle 0 (up) … 1 (down)
    #down = false;
    #misses = [];

    constructor(canvas) {
        this.canvas = canvas;
    }

    get #geometry() {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        const r = Math.min(w * 0.3, h * 0.42);
        return { w, h, r, x: this.step === 'pump' ? w * 0.38 : w / 2, y: h / 2 };
    }

    /** A click on the canvas (CSS pixels). Returns true when it found the hole. */
    click(px, py) {
        if (this.step !== 'find') return false;
        const { r, x, y } = this.#geometry;
        const hx = x + Math.cos(this.#hole + this.#angle) * r * 0.92;
        const hy = y + Math.sin(this.#hole + this.#angle) * r * 0.92;
        if (Math.hypot(px - hx, py - hy) < Math.max(28, r * 0.2)) {
            this.step = 'pump';
            return true;
        }
        this.#misses.push({ x: px, y: py, t: performance.now() });
        return false;
    }

    /** Move the pump handle (0 = up, 1 = down). A full push down counts as one stroke. */
    pump(position) {
        if (this.step !== 'pump') return;
        this.#handle = Math.max(0, Math.min(1, position));
        if (this.#handle > 0.85 && !this.#down) {
            this.#down = true;
            this.strokes++;
            if (this.strokes >= TireGame.STROKES) this.step = 'done';
        } else if (this.#handle < 0.25) {
            this.#down = false;
        }
    }

    /** One stroke from a button or key. */
    stroke() {
        this.pump(1);
        setTimeout(() => this.pump(0), 120);
    }

    pumpPosition(py) {
        const { h } = this.#geometry;
        return (py - h * 0.25) / (h * 0.5 * 0.35); // the handle travels 35 % of the pump's height
    }

    draw(power = 0) {
        const { w, h, c } = fit(this.canvas);
        const { r, x, y } = this.#geometry;
        c.clearRect(0, 0, w, h);
        if (this.step === 'stop') this.#angle += Math.min(power, 600) / 4000;

        const inflated = this.step === 'done' ? 1 : this.step === 'pump' ? this.strokes / TireGame.STROKES : 0;
        // Tyre: flat at the bottom until pumped
        c.save();
        c.translate(x, y);
        c.scale(1, 1 - (1 - inflated) * 0.06);
        c.lineWidth = r * (0.12 + inflated * 0.05);
        c.strokeStyle = '#1b1b1f';
        c.beginPath();
        c.arc(0, 0, r, 0, Math.PI * 2);
        c.stroke();
        // Tread
        c.strokeStyle = 'rgba(255,255,255,0.08)';
        c.lineWidth = 2;
        for (let i = 0; i < 36; i++) {
            const a = this.#angle + (i / 36) * Math.PI * 2;
            c.beginPath();
            c.moveTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95);
            c.lineTo(Math.cos(a) * r * 1.05, Math.sin(a) * r * 1.05);
            c.stroke();
        }
        // Rim and spokes
        c.strokeStyle = PINK;
        c.lineWidth = r * 0.035;
        c.beginPath();
        c.arc(0, 0, r * 0.86, 0, Math.PI * 2);
        c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.75)';
        c.lineWidth = 1.5;
        for (let i = 0; i < 16; i++) {
            const a = this.#angle + (i / 16) * Math.PI * 2;
            c.beginPath();
            c.moveTo(Math.cos(a) * r * 0.1, Math.sin(a) * r * 0.1);
            c.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85);
            c.stroke();
        }
        c.fillStyle = LIME;
        c.beginPath();
        c.arc(0, 0, r * 0.1, 0, Math.PI * 2);
        c.fill();
        c.restore();

        // Escaping air near the hole: the only hint while you look for it.
        const hx = x + Math.cos(this.#hole + this.#angle) * r * 0.92;
        const hy = y + Math.sin(this.#hole + this.#angle) * r * 0.92;
        if (this.step === 'find' || this.step === 'stop') {
            if (Math.random() < 0.12) {
                const a = this.#hole + this.#angle + (Math.random() - 0.5) * 0.6;
                this.#puffs.push({ x: hx, y: hy, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30 - 10, life: 1 });
            }
        }
        this.#puffs = this.#puffs.filter((p) => (p.life -= 0.02) > 0);
        for (const p of this.#puffs) {
            p.x += p.vx / 60;
            p.y += p.vy / 60;
            c.fillStyle = `rgba(200, 240, 255, ${(p.life * 0.35).toFixed(2)})`;
            c.beginPath();
            c.arc(p.x, p.y, 3 + (1 - p.life) * 9, 0, Math.PI * 2);
            c.fill();
        }
        if (this.step === 'pump' || this.step === 'done') {
            // The patch
            c.fillStyle = YELLOW;
            c.beginPath();
            c.arc(hx, hy, Math.max(5, r * 0.05), 0, Math.PI * 2);
            c.fill();
        }
        const now = performance.now();
        this.#misses = this.#misses.filter((m) => now - m.t < 700);
        for (const miss of this.#misses) {
            c.strokeStyle = `rgba(255, 90, 90, ${1 - (now - miss.t) / 700})`;
            c.lineWidth = 3;
            c.beginPath();
            c.arc(miss.x, miss.y, 12, 0, Math.PI * 2);
            c.stroke();
        }

        if (this.step === 'pump' || this.step === 'done') this.#drawPump(c, w, h, inflated);
    }

    #drawPump(c, w, h, inflated) {
        const px = w * 0.8;
        const top = h * 0.25;
        const height = h * 0.5;
        const barrel = Math.max(26, w * 0.05);
        // Barrel
        roundRect(c, px - barrel / 2, top + height * 0.35, barrel, height * 0.65, 8);
        c.fillStyle = PINK;
        c.fill();
        // Handle (moves with the input)
        const handleY = top + this.#handle * height * 0.35;
        c.strokeStyle = '#ffffff';
        c.lineWidth = 6;
        c.beginPath();
        c.moveTo(px, handleY);
        c.lineTo(px, top + height * 0.4);
        c.stroke();
        roundRect(c, px - barrel * 1.2, handleY - 8, barrel * 2.4, 16, 8);
        c.fillStyle = LIME;
        c.fill();
        // Pressure gauge
        const gx = px;
        const gy = top + height + 34;
        c.fillStyle = 'rgba(0,0,0,0.5)';
        roundRect(c, gx - 70, gy - 12, 140, 24, 12);
        c.fill();
        roundRect(c, gx - 68, gy - 10, 136 * inflated, 20, 10);
        c.fillStyle = inflated >= 1 ? LIME : YELLOW;
        c.fill();
    }
}
