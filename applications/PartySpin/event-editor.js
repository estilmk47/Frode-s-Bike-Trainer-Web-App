/** The form for one scheduled event (a Hakoot question or a poker round), used by the create menu and the moderator. */
import { esc, modal, toast } from '../../core/ui.js';
import { COLORS, formatClock } from './rules.js';

export const EVENT_TYPES = {
    hakoot: 'Hakoot',
    poker: 'Poker',
};

/** A new event, placed two minutes after the last one. */
export function newEvent(type, schedule) {
    const at = Math.max(0, ...schedule.map((event) => event.at)) + 120;
    const id = Math.random().toString(36).slice(2, 10);
    if (type === 'poker') return { id, type, at, duration: 120, potMin: 1000, potMax: 5000 };
    return { id, type, at, question: '', answers: ['', '', '', ''], correct: 0, image: '', read: 5, answer: 10, rewards: 3 };
}

export const eventTitle = (event) => (event.type === 'poker'
    ? `Pot ${event.potMin.toLocaleString()}–${event.potMax.toLocaleString()} points, ${event.duration} s to bet`
    : event.question);

function readTime(text) {
    const parts = String(text).trim().split(':').map(Number);
    if (parts.some(Number.isNaN)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

function hakootFields(event) {
    return `
        <label class="field"><span>Question</span><textarea name="question" rows="2" maxlength="300">${esc(event.question)}</textarea></label>
        ${[0, 1, 2, 3].map((i) => `<div class="row answer-row" style="--answer:${COLORS[i]}">
            <label class="check" title="The right answer"><input type="radio" name="correct" value="${i}" ${event.correct === i ? 'checked' : ''}></label>
            <input class="grow" name="a${i}" maxlength="120" placeholder="Answer ${'ABCD'[i]}${i > 1 ? ' (optional)' : ''}" value="${esc(event.answers[i] ?? '')}"></div>`).join('')}
        <p class="muted">Tick the right answer.</p>
        <div class="row wrap">
            <label class="field"><span>Reading time (s)</span><input name="read" type="number" min="0" max="60" value="${event.read}"></label>
            <label class="field"><span>Answer time (s)</span><input name="answer" type="number" min="3" max="120" value="${event.answer}"></label>
            <label class="field"><span>Winners</span><input name="rewards" type="number" min="0" max="50" value="${event.rewards}"></label>
        </div>
        <label class="field"><span>Picture (address, optional)</span><input name="image" type="url" value="${esc(event.image)}"></label>`;
}

function pokerFields(event) {
    return `
        <p class="muted">The pot starts with a random number of points between the two below. While betting is open everyone can put a share of their score in it; whoever has the highest score at the end wins the pot. (Planned now, played in a later version.)</p>
        <div class="row wrap">
            <label class="field"><span>Pot from (points)</span><input name="potMin" type="number" min="0" max="1000000" step="100" value="${event.potMin}"></label>
            <label class="field"><span>Pot to (points)</span><input name="potMax" type="number" min="0" max="1000000" step="100" value="${event.potMax}"></label>
            <label class="field"><span>Betting time (s)</span><input name="duration" type="number" min="10" max="600" value="${event.duration}"></label>
        </div>`;
}

function readHakoot(body, f) {
    const answers = [0, 1, 2, 3].map((i) => f[`a${i}`].value.trim());
    const correct = Number(new FormData(body).get('correct') ?? 0);
    if (!f.question.value.trim() || answers.filter(Boolean).length < 2) throw new Error('Write a question and at least two answers.');
    if (!answers[correct]) throw new Error('The right answer is empty.');
    // Empty answers are removed; the right one keeps pointing at the same text.
    const kept = answers.map((text, i) => ({ text, i })).filter((answer) => answer.text);
    return {
        question: f.question.value.trim(), answers: kept.map((answer) => answer.text),
        correct: kept.findIndex((answer) => answer.i === correct),
        read: Number(f.read.value), answer: Number(f.answer.value), rewards: Number(f.rewards.value), image: f.image.value.trim(),
    };
}

function readPoker(f) {
    const potMin = Number(f.potMin.value) || 0;
    const potMax = Number(f.potMax.value) || 0;
    if (potMax < potMin) throw new Error('The pot can not end below where it starts.');
    return { duration: Number(f.duration.value) || 120, potMin, potMax };
}

/** @returns {Promise<object | null>} the edited event, or null when cancelled */
export async function editEvent(event) {
    const hakoot = event.type !== 'poker';
    const body = document.createElement('form');
    body.className = 'stack event-form';
    body.innerHTML = `
        <label class="field"><span>Starts at (game time, m:ss)</span><input name="at" value="${formatClock(event.at * 1000)}" required></label>
        ${hakoot ? hakootFields(event) : pokerFields(event)}`;
    let result = null;
    await modal({
        title: `${EVENT_TYPES[event.type] ?? 'Hakoot'} event`,
        body,
        actions: [{ label: 'Cancel', value: null }, {
            label: 'Save', primary: true,
            onClick: () => {
                const f = body.elements;
                const at = readTime(f.at.value);
                if (at == null) { toast('Write the time as m:ss.'); return false; }
                try {
                    const fields = hakoot
                        ? readHakoot(body, f)
                        : readPoker(f);
                    result = { ...event, ...fields, at };
                } catch (error) {
                    toast(error.message);
                    return false;
                }
                return true;
            },
        }],
    }).closed;
    return result;
}
