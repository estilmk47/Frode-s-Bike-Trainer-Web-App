/**
 * Activities: your (and optionally your friends') sessions as a list or a calendar.
 * Each friend gets their own colour.
 */
import { initPage, icon, esc, localModeNotice, formatDistance, formatDuration } from '../core/ui.js';
import { local } from '../core/storage.js';
import { sessionRow, sessionTitle, bindSessionRows } from '../core/session-ui.js';

const platform = await initPage({ title: 'Activities', iconName: 'activities' });
const page = document.getElementById('page');

const FRIEND_COLORS = ['#f08a24', '#8a55d7', '#e0508f', '#3aa655', '#d4ae1c', '#2f7de1', '#e0393e', '#7a7a7a'];

const state = {
    view: local.get('activities.view', 'list'),
    friends: local.get('activities.friends', false),
    month: startOfMonth(new Date()),
};

const css = document.createElement('style');
css.textContent = `
    .toolbar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 1.25rem; }
    .toolbar .spacer { flex: 1; }
    .legend { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.85rem; margin-bottom: 1rem; }
    .legend span { display: inline-flex; align-items: center; gap: 0.35em; }
    .legend i { width: 12px; height: 12px; border-radius: 50%; background: var(--c); display: inline-block; }
    .month-title { margin: 1.5rem 0 0.6rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .calendar-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
    .calendar-head h2 { flex: 1; text-align: center; margin: 0; }
    .calendar { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
    .calendar .dow { font-size: 0.75rem; text-align: center; color: var(--muted); padding: 0.3rem 0; }
    .calendar .day { min-height: 92px; background: var(--surface); border-radius: var(--radius); padding: 0.3rem; display: grid; align-content: start; gap: 3px; }
    .calendar .day.other { opacity: 0.4; }
    .calendar .day.today { outline: 2px solid var(--accent); }
    .calendar .num { font-size: 0.75rem; color: var(--muted); }
    .calendar .chip { font-size: 0.72rem; padding: 0.15rem 0.35rem; border-radius: 4px; border: none; box-shadow: none; justify-content: flex-start;
        background: color-mix(in srgb, var(--c) 22%, var(--surface)); border-left: 3px solid var(--c); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; display: block; text-align: left; }
    .summary { display: flex; gap: 1.5rem; flex-wrap: wrap; color: var(--muted); margin-bottom: 1rem; }
    .summary strong { color: var(--text); }
    @media (max-width: 600px) { .calendar .day { min-height: 60px; } .calendar .chip { font-size: 0; height: 8px; padding: 0; } }`;
document.head.append(css);

const content = document.createElement('div');
page.append(content);
bindSessionRows(platform, content);

function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

async function render() {
    const canFriends = platform.backend.mode === 'server' && platform.isLoggedIn;
    if (platform.backend.mode === 'server' && !platform.isLoggedIn) {
        content.innerHTML = `<div class="empty"><p>Log in to see your activities.</p>
            <button class="primary" data-login>${icon('user')} Log in</button></div>`;
        return;
    }

    content.innerHTML = `
        ${localModeNotice(platform, 'Comparing with friends')}
        <div class="toolbar">
            <div class="segmented" role="tablist">
                <button role="tab" data-view="list" aria-selected="${state.view === 'list'}">${icon('list')} List</button>
                <button role="tab" data-view="calendar" aria-selected="${state.view === 'calendar'}">${icon('activities')} Calendar</button>
            </div>
            <span class="spacer"></span>
            <label class="hint"><input type="checkbox" data-friends ${state.friends && canFriends ? 'checked' : ''} ${canFriends ? '' : 'disabled'}> Include friends</label>
        </div>
        <div id="view"><p class="muted">Loading…</p></div>`;

    const view = content.querySelector('#view');
    const query = { username: platform.user?.username, friends: state.friends && canFriends };
    if (state.view === 'calendar') {
        // Include the visible days of the previous and next month.
        query.from = new Date(state.month.getFullYear(), state.month.getMonth(), -6).toISOString();
        query.to = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 7).toISOString();
    } else {
        query.limit = 200;
    }

    let sessions;
    try {
        sessions = await platform.api.sessions(query);
    } catch (error) {
        view.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
        return;
    }

    // Colour per rider: you in the accent colour, friends from the palette.
    const me = platform.user?.username;
    const riders = [...new Set(sessions.map((s) => s.username))].sort((a, b) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b)));
    const colors = Object.fromEntries(riders.map((name, i) => [name, name === me ? 'var(--accent)' : FRIEND_COLORS[(i - 1 + FRIEND_COLORS.length) % FRIEND_COLORS.length]]));
    const legend = query.friends && riders.length > 1
        ? `<div class="legend">${riders.map((name) => `<span style="--c:${colors[name]}"><i></i>${esc(name === me ? 'You' : name)}</span>`).join('')}</div>` : '';

    view.innerHTML = legend + (state.view === 'calendar'
        ? calendarHtml(sessions, colors)
        : listHtml(sessions, colors, !!query.friends));
}

function listHtml(sessions, colors, showUser) {
    if (!sessions.length) return '<div class="empty">No sessions yet. Start an application from the home screen and go for a ride!</div>';
    const mine = sessions.filter((s) => s.username === platform.user?.username);
    let html = `<div class="summary">
        <span><strong>${mine.length}</strong> sessions</span>
        <span><strong>${formatDistance(mine.reduce((a, s) => a + (s.distance || 0), 0))}</strong></span>
        <span><strong>${formatDuration(mine.reduce((a, s) => a + (s.duration || 0), 0))}</strong></span>
    </div>`;
    let month = '';
    for (const s of sessions) {
        const label = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(s.started_at));
        if (label !== month) {
            if (month) html += '</div>';
            html += `<h3 class="month-title">${esc(label)}</h3><div class="list">`;
            month = label;
        }
        html += sessionRow(platform, s, { showUser, color: showUser ? colors[s.username] : null });
    }
    return html + '</div>';
}

function calendarHtml(sessions, colors) {
    const byDay = {};
    for (const s of sessions) (byDay[dayKey(new Date(s.started_at))] ??= []).push(s);

    const first = state.month;
    const offset = (first.getDay() + 6) % 7; // weeks start on Monday
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    const today = dayKey(new Date());
    const weekdays = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 1 + i)));

    let cells = '';
    for (let i = 0; i < 42; i++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const key = dayKey(date);
        const chips = (byDay[key] ?? []).map((s) =>
            `<button class="chip" style="--c:${colors[s.username]}" data-session="${esc(s.session_key)}"
                title="${esc(`${s.username}: ${sessionTitle(platform, s)} · ${formatDistance(s.distance)}`)}">${esc(sessionTitle(platform, s))}</button>`).join('');
        cells += `<div class="day ${date.getMonth() !== first.getMonth() ? 'other' : ''} ${key === today ? 'today' : ''}">
            <span class="num">${date.getDate()}</span>${chips}</div>`;
    }
    return `
        <div class="calendar-head">
            <button class="small" data-month="-1" aria-label="Previous month">‹</button>
            <h2>${esc(new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(first))}</h2>
            <button class="small" data-month="1" aria-label="Next month">›</button>
        </div>
        <div class="calendar">${weekdays.map((d) => `<div class="dow">${esc(d)}</div>`).join('')}${cells}</div>`;
}

content.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.matches('[data-login]')) platform.openPage('logIn/');
    if (button.dataset.view) {
        state.view = button.dataset.view;
        local.set('activities.view', state.view);
        render();
    }
    if (button.dataset.month) {
        state.month = new Date(state.month.getFullYear(), state.month.getMonth() + Number(button.dataset.month), 1);
        render();
    }
});

content.addEventListener('change', (event) => {
    if (event.target.matches('[data-friends]')) {
        state.friends = event.target.checked;
        local.set('activities.friends', state.friends);
        render();
    }
});

render();
