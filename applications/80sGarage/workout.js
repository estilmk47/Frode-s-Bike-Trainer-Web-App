/**
 * The 80s Highway workout format: a comma separated list of steps.
 *
 *   14m30s@200W        a steady step: duration, '@', power in watts (W) or % of FTP (%)
 *   90s@110%
 *   5m b               a break (recovery at BREAK_POWER % of FTP)
 *   5m b@40%           a break at a chosen power
 *   ramp(50%, 90%, 10m)  power changes evenly from the first to the second value
 *   4x(3m@115%, 2m b)  repeat the steps inside the parentheses (can be nested)
 *
 * Durations: any combination of h, m and s in that order (1h, 45m, 90s, 1h30m, 14m30s).
 * Spaces and line breaks are allowed between steps. Upper/lower case does not matter.
 *
 * parseWorkout(text) → { steps, duration } or throws a WorkoutError with the position of the mistake.
 * A step: { kind: 'steady' | 'ramp' | 'break', start, duration (s), from, to } where from/to are
 * { value, unit: '%' | 'W' } (null for breaks).
 */

export const BREAK_POWER = 50; // % of FTP during a break
const MAX_DURATION = 24 * 3600;
const MAX_REPEAT = 100;

export class WorkoutError extends Error {
    constructor(message, index, length = 1) {
        super(message);
        this.index = index;
        this.length = length;
    }
}

export const FORMAT_RULES = [
    ['Steps are separated by commas', '10m@60%, 5m@200W'],
    ['A step is a duration, then @ and a power', '14m30s@200W'],
    ['Power in watts (W) or percent of your FTP (%)', '90s@110%'],
    ['Durations combine h, m and s', '1h, 45m, 90s, 1h30m, 14m30s'],
    ['A break: the duration followed by b (50 % of FTP), or b@ a power of your choice', '2m b, 2m b@40%'],
    ['A ramp from one power to another', 'ramp(50%, 90%, 10m)'],
    ['Repeat steps: a number, x and the steps in parentheses', '5x(3m@110%, 2m b)'],
];

export function parseWorkout(text) {
    const parser = new Parser(String(text ?? ''));
    const steps = parser.list(0);
    parser.space();
    if (!parser.done()) parser.fail(parser.peek() === ')' ? 'There is a ) without a matching (.' : 'Expected a comma between two steps.');
    if (!steps.length) throw new WorkoutError('The workout is empty.', 0, Math.max(1, text.length));
    let start = 0;
    for (const step of steps) {
        step.start = start;
        start += step.duration;
    }
    if (start > MAX_DURATION) throw new WorkoutError('A workout can be at most 24 hours long.', 0, text.length);
    return { steps, duration: start };
}

class Parser {
    constructor(text) {
        this.text = text;
        this.i = 0;
    }

    done() { return this.i >= this.text.length; }
    peek() { return this.text[this.i]; }
    space() { while (/\s/.test(this.text[this.i] ?? '')) this.i++; }
    fail(message, index = this.i, length = 1) { throw new WorkoutError(message, index, length); }

    eat(char) {
        this.space();
        if (this.text[this.i]?.toLowerCase() === char) { this.i++; return true; }
        return false;
    }

    expect(char, message) {
        if (!this.eat(char)) this.fail(message ?? `Expected "${char}".`);
    }

    /** Steps until the end, or until ")" at depth > 0. */
    list(depth) {
        const steps = [];
        for (;;) {
            this.space();
            if (this.done() || (depth > 0 && this.peek() === ')')) {
                if (steps.length) this.fail('Remove the comma at the end, or add a step after it.', this.lastComma);
                return steps;
            }
            steps.push(...this.item(depth));
            this.space();
            if (this.peek() !== ',') return steps;
            this.lastComma = this.i;
            this.i++;
            this.space();
            if (this.done() || (depth > 0 && this.peek() === ')')) this.fail('Remove the comma at the end, or add a step after it.', this.lastComma);
        }
    }

    item(depth) {
        this.space();
        const begin = this.i;
        const rest = this.text.slice(this.i);

        if (/^ramp\s*\(/i.test(rest)) {
            this.i += rest.match(/^ramp\s*\(/i)[0].length;
            const from = this.power();
            this.expect(',', 'A ramp needs three values: ramp(start power, end power, duration).');
            const to = this.power();
            this.expect(',', 'A ramp needs three values: ramp(start power, end power, duration).');
            const duration = this.duration();
            this.expect(')', 'Close the ramp with ")".');
            return [{ kind: 'ramp', duration, from, to }];
        }

        const repeat = rest.match(/^(\d+)\s*x\s*\(/i);
        if (repeat) {
            const count = Number(repeat[1]);
            if (count < 1 || count > MAX_REPEAT) this.fail(`Repeat between 1 and ${MAX_REPEAT} times.`, begin, repeat[1].length);
            this.i += repeat[0].length;
            const inner = this.list(depth + 1);
            if (!inner.length) this.fail('Put at least one step inside the parentheses.', begin, this.i - begin + 1);
            this.space();
            if (!this.done() && this.peek() !== ')') this.fail('Expected a comma between two steps (or ")" to close the repeat).');
            this.expect(')', 'Close the repeat with ")".');
            const steps = [];
            for (let n = 0; n < count; n++) for (const step of inner) steps.push({ ...step, repeat: { index: n, count } });
            return steps;
        }

        if (/^\d+\s*x/i.test(rest)) this.fail('After "x" put the steps to repeat in parentheses, e.g. 4x(3m@110%, 2m b).', begin);
        if (!/^\d/.test(rest)) this.fail(rest[0] === '(' ? 'Put a number and x before the parentheses, e.g. 4x(...).' : 'A step starts with a duration (e.g. 5m), "ramp(" or a repeat (e.g. 4x(...)).', begin);

        const duration = this.duration();
        this.space();
        if (this.peek()?.toLowerCase() === 'b') {
            this.i++;
            this.space();
            if (this.peek() === '@') {
                this.i++;
                const power = this.power();
                return [{ kind: 'break', duration, from: power, to: power }];
            }
            return [{ kind: 'break', duration, from: null, to: null }];
        }
        if (this.peek() === '@') {
            this.i++;
            const power = this.power();
            return [{ kind: 'steady', duration, from: power, to: power }];
        }
        this.fail('After the duration put "@" and a power (e.g. @200W or @80%), or "b" for a break.');
    }

    duration() {
        this.space();
        const begin = this.i;
        const match = this.text.slice(this.i).match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?/i);
        if (!match || !match[0]) {
            const number = this.text.slice(this.i).match(/^\d+(?:\.\d+)?/);
            if (number) this.fail('Add a unit to the duration: h, m or s (e.g. 90s or 5m).', begin + number[0].length);
            this.fail('Expected a duration such as 90s, 5m or 1h30m.');
        }
        this.i += match[0].length;
        if (/^\d/.test(this.text.slice(this.i))) this.fail('Write durations in the order h, m, s (e.g. 1h30m or 14m30s).', begin, this.i - begin + 1);
        const seconds = Math.round((Number(match[1] ?? 0) * 3600) + (Number(match[2] ?? 0) * 60) + Number(match[3] ?? 0));
        if (seconds <= 0) this.fail('A duration must be longer than 0 seconds.', begin, match[0].length);
        return seconds;
    }

    power() {
        this.space();
        const begin = this.i;
        const match = this.text.slice(this.i).match(/^(\d+(?:\.\d+)?)\s*(%|w)?/i);
        if (!match) this.fail('Expected a power such as 200W or 80%.');
        if (!match[2]) this.fail('Add a unit to the power: W (watts) or % (of your FTP).', begin + match[1].length);
        this.i += match[0].length;
        const value = Number(match[1]);
        const unit = match[2] === '%' ? '%' : 'W';
        if (unit === '%' && value > 500) this.fail('That is more than 500 % of your FTP.', begin, match[0].length);
        if (unit === 'W' && value > 3000) this.fail('That is more than 3000 W.', begin, match[0].length);
        return { value, unit };
    }
}

/* ---------------- Using a parsed workout ---------------- */

/** A power value in watts. */
export function toWatts(power, ftp) {
    if (!power) return (BREAK_POWER / 100) * ftp;
    return power.unit === '%' ? (power.value / 100) * ftp : power.value;
}

/** Target power (W, before the multiplier) at `t` seconds into the step. */
export function stepTarget(step, t, ftp) {
    if (step.kind === 'ramp') {
        const f = Math.min(1, Math.max(0, t / step.duration));
        return toWatts(step.from, ftp) + (toWatts(step.to, ftp) - toWatts(step.from, ftp)) * f;
    }
    return toWatts(step.from, ftp);
}

/** Index of the step at `t` seconds into the workout (steps.length when finished). */
export function stepIndexAt(workout, t) {
    const index = workout.steps.findIndex((s) => t < s.start + s.duration);
    return index === -1 ? workout.steps.length : index;
}

/** Duration, intensity factor, training stress score and an effort label for the rider's FTP. */
export function summarize(workout, ftp) {
    let sum4 = 0;
    let sum = 0;
    for (const step of workout.steps) {
        // Sample every 5 s – plenty for the estimate.
        for (let t = 0; t < step.duration; t += 5) {
            const dt = Math.min(5, step.duration - t);
            const p = stepTarget(step, t + dt / 2, ftp) / ftp;
            sum4 += p ** 4 * dt;
            sum += p * dt;
        }
    }
    const duration = workout.duration;
    const intensity = duration ? (sum4 / duration) ** 0.25 : 0;
    return {
        duration,
        intensity,                                       // IF (normalized power / FTP)
        average: duration ? sum / duration : 0,          // average power / FTP
        tss: (duration / 3600) * intensity * intensity * 100,
        effort: effortOf(intensity),
    };
}

export const EFFORTS = ['Easy', 'Moderate', 'Hard', 'Very hard'];

export function effortOf(intensity) {
    if (intensity < 0.6) return 'Easy';
    if (intensity < 0.76) return 'Moderate';
    if (intensity < 0.86) return 'Hard';
    return 'Very hard';
}

/** "1:05:30" / "5:30" */
export function clock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Human readable duration in a workout list: "45 min", "1 h 30 min". */
export function minutes(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/* ---------------- The library ---------------- */

/** Built-in workouts. Add more here – they are validated when the library opens. */
export const LIBRARY = [
    {
        id: 'spin-out', name: 'Spin Out', category: 'Recovery',
        description: 'Easy spinning to flush the legs. Keep the cadence high and the effort low.',
        code: '5m@45%, 20m@55%, 5m@45%',
    },
    {
        id: 'neon-cruise', name: 'Neon Cruise', category: 'Endurance',
        description: 'A steady endurance ride with a gentle warm-up. Good for building the base.',
        code: 'ramp(40%, 65%, 10m), 40m@68%, 10m@50%',
    },
    {
        id: 'long-highway', name: 'Long Highway', category: 'Endurance',
        description: 'Ninety minutes in zone 2 with short lifts to stay awake on the highway.',
        code: 'ramp(40%, 65%, 10m), 3x(20m@68%, 3m@80%), 11m@50%',
    },
    {
        id: 'sweet-spot-sunset', name: 'Sweet Spot Sunset', category: 'Sweet spot',
        description: 'Two long sweet spot blocks – just below threshold, where you get the most out of your time.',
        code: 'ramp(40%, 70%, 10m), 2x(15m@90%, 5m b), 10m@50%',
    },
    {
        id: 'cassette-tape', name: 'Cassette Tape', category: 'Sweet spot',
        description: 'Side A, side B: three blocks of 10 minutes at sweet spot.',
        code: 'ramp(45%, 75%, 8m), 3x(10m@88%, 4m b), 5m@50%',
    },
    {
        id: 'threshold-arcade', name: 'Threshold Arcade', category: 'Threshold',
        description: 'Classic 2×20 minutes at your FTP. Hard, but it is the best test of focus there is.',
        code: 'ramp(45%, 75%, 10m), 2x(20m@100%, 5m b), 10m@50%',
    },
    {
        id: 'over-under', name: 'Over Under', category: 'Threshold',
        description: 'Switch between just below and just above your FTP. Teaches you to recover while working.',
        code: 'ramp(45%, 75%, 10m), 3x(4x(2m@95%, 1m@105%), 5m b), 8m@50%',
    },
    {
        id: 'miami-intervals', name: 'Miami Intervals', category: 'VO2max',
        description: 'Five hard three-minute efforts. Big lungs, big smile.',
        code: 'ramp(45%, 80%, 10m), 5x(3m@115%, 3m b), 10m@50%',
    },
    {
        id: 'laser-tag', name: 'Laser Tag', category: 'VO2max',
        description: '30 seconds on, 30 seconds off – the minutes fly by.',
        code: 'ramp(45%, 75%, 10m), 2x(10x(30s@125%, 30s@50%), 5m b), 5m@50%',
    },
    {
        id: 'pixel-sprints', name: 'Pixel Sprints', category: 'Sprint',
        description: 'Short all-out bursts with full recovery. Go as hard as you can in every sprint.',
        code: 'ramp(45%, 75%, 10m), 8x(15s@200%, 2m45s b), 5m@50%',
    },
    {
        id: 'quick-fix', name: 'Quick Fix', category: 'Tempo',
        description: 'Short on time? 30 minutes with a solid tempo block.',
        code: 'ramp(45%, 70%, 6m), 18m@82%, 6m@50%',
    },
    {
        id: 'ramp-test', name: 'Ramp Test', category: 'Test',
        description: 'Power goes up 6 % of FTP every minute until you can\'t go on. Stop when you are done – your FTP is about 75 % of the best minute.',
        code: '5m@45%, ramp(50%, 150%, 17m), 5m@40%',
    },
    {
        id: 'pyramid', name: 'Synth Pyramid', category: 'Threshold',
        description: 'Up the steps and back down again: 1-2-3-4-3-2-1 minutes around threshold.',
        code: 'ramp(45%, 75%, 8m), 1m@100%, 1m b, 2m@100%, 2m b, 3m@100%, 3m b, 4m@100%, 3m b, 3m@100%, 2m b, 2m@100%, 1m b, 1m@100%, 8m@50%',
    },
];

export function libraryWorkouts() {
    return LIBRARY.map((w) => ({ ...w, source: 'library', workout: parseWorkout(w.code) }));
}
