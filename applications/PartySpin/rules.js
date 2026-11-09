/**
 * Scoring and card effects as seen by the browser. The server decides what happens; this file
 * reads the event log to know what is active right now (×1.2, copycat, flat tyre …) and turns
 * watts into points.
 */

/**
 * How watts become points: 100 points per second at the rider's *baseline*. The baseline is a share
 * of a reference (your FTP, 235 W or 3 W/kg) that depends on the rider's difficulty, so a harder
 * difficulty needs more watts for the same points.
 */
export const DIFFICULTY_SHARE = { 1: 0.55, 2: 0.7, 3: 0.85, 4: 1, 5: 1.1 };   // relaxed, easy, normal, hard, extreme
const NORMAL = 3;

export const MODES = {
    ftp: { label: 'Fair (by FTP)', text: 'Points by effort: 100 points/s at 85 % of your own FTP (normal difficulty). Everyone has a chance.' },
    power: { label: 'Raw watts', text: 'Points by power: 100 points/s at 200 W (normal difficulty). The strongest legs win.' },
    wkg: { label: 'Watts per kilo', text: 'Points by power for your weight: 100 points/s at 2.55 W/kg (normal difficulty).' },
};

export const difficultyShare = (difficulty) => DIFFICULTY_SHARE[difficulty] ?? DIFFICULTY_SHARE[NORMAL];

/** The watts that give 100 points per second for this rider. */
export function baselineWatts(mode, rider) {
    const share = difficultyShare(rider.difficulty);
    switch (mode) {
        case 'power': return share * 235;
        case 'wkg': return share * 3 * (rider.weight || 75);
        default: return share * (rider.ftp || 200);
    }
}

export function pointsPerSecond(power, mode, rider) {
    if (!power || power < 0) return 0;
    return (100 * power) / baselineWatts(mode, rider);
}

/** Colours of the old Party Spin, used for cards and answers. */
export const COLORS = ['#D05CBC', '#B6E682', '#F7E928', '#5CC8D0', '#F08A4B', '#9B7BEA', '#FF6F91', '#7DDBA3', '#E8B04A'];

export const cardColor = (card) => COLORS[(Number(card) - 1) % COLORS.length];
export const cardIcon = (card) => `assets/UI/powerups/icons/${card}.png`;
/** The big picture for a card (Nope has none yet: its icon is used). */
export const cardArt = (card) => (Number(card) === 1 ? null : `assets/UI/powerups/display/${card}.png`);

/**
 * Effects active for rider `pid` at game time `clock`, read from the event log.
 * @returns {{multiplier: number, copy: object | null, flat: object | null, list: object[]}}
 *   list: [{ kind, card, of, from, until, value?, source? }] for display
 */
export function activeEffects(events, pid, clock) {
    const played = new Map();
    const fixed = new Set();
    const result = { multiplier: 1, copy: null, flat: null, list: [] };
    for (const event of events) {
        if (event.type === 'powerup') played.set(event.id, event);
        if (event.type === 'fixed') fixed.add(event.of);
    }
    for (const event of events) {
        if (event.type !== 'resolve') continue;
        const card = played.get(event.of)?.card;
        for (const effect of event.effects ?? []) {
            if (effect.player !== pid || effect.until == null || clock < effect.from || clock >= effect.until) continue;
            if (effect.kind === 'flat' && fixed.has(event.of)) continue;
            const item = { ...effect, card, of: event.of };
            if (effect.kind === 'multiplier') result.multiplier *= effect.value;
            if (effect.kind === 'copy') result.copy = item;
            if (effect.kind === 'flat') result.flat = item;
            result.list.push(item);
        }
    }
    return result;
}

/** Cards played on `pid` that can still be answered with Nope. */
export function incomingCards(events, pid) {
    const resolved = new Set(events.filter((e) => e.type === 'resolve').map((e) => e.of));
    return events.filter((e) => e.type === 'powerup' && e.target === pid && e.owner !== pid && !resolved.has(e.id));
}

/** A short sentence for the event feed. `name(id)` gives a rider's name ("You" for yourself). */
export function describe(event, events, cards, name) {
    const cardName = (card) => cards[card]?.name ?? 'a card';
    const byId = (id) => events.find((e) => e.id === id);
    switch (event.type) {
        case 'powerup': {
            const on = event.target && event.target !== event.owner ? ` on ${name(event.target)}` : '';
            return `${name(event.owner)} played ${cardName(event.card)}${on}`;
        }
        case 'nope':
            return `${name(event.by)} said NOPE!`;
        case 'resolve': {
            const played = byId(event.of);
            if (!played) return null;
            if (event.outcome === 'noped') return `${cardName(played.card)} was cancelled`;
            if (event.outcome === 'fizzled') return `${cardName(played.card)} had no effect`;
            if (event.outcome === 'empty') return `${name(played.target)} had no cards to steal`;
            const parts = (event.effects ?? []).map((effect) => {
                switch (effect.kind) {
                    case 'points': return `${name(effect.player)} ${effect.delta >= 0 ? '+' : '−'}${Math.abs(effect.delta)} points`;
                    case 'multiplier': return effect.value === 0
                        ? `${name(effect.player)} scores nothing for ${Math.round((effect.until - effect.from) / 1000)} s`
                        : `${name(effect.player)} ×${effect.value} for ${Math.round((effect.until - effect.from) / 1000)} s`;
                    case 'copy': return `${name(effect.player)} copies ${name(effect.source)}'s watts`;
                    case 'card': return `${name(effect.to)} stole ${cardName(effect.card)} from ${name(effect.from)}`;
                    case 'flat': return `${name(effect.player)} got a flat tyre!`;
                    default: return '';
                }
            }).filter(Boolean);
            return parts.join(' · ') || null;
        }
        case 'fixed':
            return `${name(event.by)} fixed the tyre`;
        case 'deal': {
            const count = Object.keys(event.cards ?? {}).length;
            return count ? 'New cards dealt' : null;
        }
        case 'hakoot':
            return 'Hakoot! A question is coming up';
        case 'hakoot-result': {
            const winner = event.results?.find((r) => r.correct);
            return winner ? `${name(winner.player)} answered fastest` : 'Nobody got the question right';
        }
        default:
            return null;
    }
}

/* ---------- The bike's numbers (Profile): click power or speed to change how they are shown ---------- */

export const POWER_VIEWS = {
    raw: 'Watts',
    avg3: 'Watts, 3 s average',
    wkg: 'Watts per kilo',
    ftp: '% of FTP',
};

export const SPEED_VIEWS = {
    kmh: 'km/h',
    mph: 'Miles per hour',
    minkm: 'Minutes per km',
    minmi: 'Minutes per mile',
};

/** The next view in a list (for clicking through them). */
export const nextView = (views, current) => {
    const keys = Object.keys(views);
    return keys[(keys.indexOf(current) + 1) % keys.length];
};

/**
 * Points, short: at most three digits before the point and one after, with k, M … ("523", "12.3k",
 * "4.6M"). Small numbers stay whole: points have no useful decimals.
 */
export function formatPoints(points) {
    const value = Math.max(0, Number(points) || 0);
    if (value < 1000) return String(Math.floor(value));
    const units = ['k', 'M', 'G', 'T'];
    let scaled = value;
    let unit = -1;
    while (scaled >= 1000 && unit < units.length - 1) {
        scaled /= 1000;
        unit += 1;
    }
    // Rounded down, so 999 999 is "999.9k" and a score never looks higher than it is.
    return `${(Math.floor(scaled * 10) / 10).toFixed(1)}${units[unit]}`;
}

/**
 * The number that earns points in this scoring mode, for the top bar: % of FTP (fair), watts (raw)
 * or watts per kilo. `watts` is the power that counts (0 with a flat tyre, the copied rider's …).
 */
export function scoringStat(mode, watts, rider) {
    const view = { ftp: 'ftp', power: 'raw', wkg: 'wkg' }[mode] ?? 'ftp';
    const label = { ftp: 'Your effort: % of your FTP', raw: 'Your watts', wkg: 'Your watts per kilo' }[view];
    const shown = formatPower(view, watts, rider);
    return { ...shown, unit: view === 'raw' ? 'W' : shown.unit, label: `${label} (what scores in this room)` };
}

/** {value, unit} for the top bar. `watts` is the current power or the 3 s average. */
export function formatPower(view, watts, rider) {
    const unit = { wkg: 'W/kg', ftp: '% FTP', avg3: 'W 3s' }[view] ?? 'W';
    if (watts == null) return { value: '–', unit };
    switch (view) {
        case 'wkg': return { value: (watts / (rider.weight || 75)).toFixed(1), unit };
        case 'ftp': return { value: String(Math.round((100 * watts) / (rider.ftp || 200))), unit };
        default: return { value: String(Math.round(watts)), unit };
    }
}

/** {value, unit} for a speed in km/h. */
export function formatSpeedView(view, kmh) {
    const pace = (minutes) => {
        const seconds = Math.round(minutes * 60);
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    const units = { kmh: 'km/h', mph: 'mph', minkm: '/km', minmi: '/mi' };
    if (kmh == null || (kmh < 1 && (view === 'minkm' || view === 'minmi'))) return { value: '–', unit: units[view] ?? 'km/h' };
    switch (view) {
        case 'mph': return { value: (kmh / 1.609344).toFixed(1), unit: 'mph' };
        case 'minkm': return { value: pace(60 / kmh), unit: '/km' };
        case 'minmi': return { value: pace(60 / (kmh / 1.609344)), unit: '/mi' };
        default: return { value: kmh.toFixed(1), unit: 'km/h' };
    }
}

/**
 * The speed (km/h) this power gives on a flat road, for bikes that don't report a speed (spin bikes).
 * The same kind of physics as the 80s Highway road: rolling resistance and air drag.
 */
export function flatSpeed(power, weight = 75) {
    if (!power || power <= 0) return 0;
    const mass = (weight || 75) + 9;
    const needed = (v) => (mass * 9.81 * 0.004 + 0.5 * 1.225 * 0.32 * v * v) * v / 0.975;
    let low = 0;
    let high = 30;  // m/s
    for (let i = 0; i < 30; i++) {
        const middle = (low + high) / 2;
        if (needed(middle) < power) low = middle;
        else high = middle;
    }
    return low * 3.6;
}

export function formatClock(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Time left / target for the room's end condition, for the clock display. */
export function endText(settings, clock, leader, status = null) {
    const end = settings?.end;
    if (status === 'ended') return 'Final score';
    if (end?.type === 'time') return `${formatClock(end.value * 60_000 - clock)} left`;
    if (end?.type === 'points') return `First to ${formatPoints(end.value)} (${formatPoints(leader)})`;
    return formatClock(clock);
}
