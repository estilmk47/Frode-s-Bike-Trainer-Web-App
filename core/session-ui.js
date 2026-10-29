/** Session rows and the session detail dialog, shared by Profile, Activities and Browse. */
import { esc, icon, avatar, modal, notify, formatDate, formatDistance, formatDuration, formatNumber, formatSpeed } from './ui.js';

export function sessionTitle(platform, s) {
    return s.notes?.title || platform.app(s.application_id)?.title || s.application_id || 'Ride';
}

/** One clickable row. `color` marks whose session it is when friends are included. */
export function sessionRow(platform, s, { showUser = false, color = null } = {}) {
    return `
        <button class="list-item session-row" data-session="${esc(s.session_key)}" ${color ? `style="border-left:5px solid ${color}"` : ''}>
            ${showUser ? avatar(s) : `<span class="avatar" style="--avatar-color:var(--accent)">${icon('bike')}</span>`}
            <span class="grow">
                <span class="title">${esc(sessionTitle(platform, s))}</span>
                <span class="sub">${showUser ? `${esc(s.nickname || s.username)} · ` : ''}${formatDate(s.started_at)}${s.is_public ? '' : ' · private'}</span>
            </span>
            <span class="sub" style="text-align:right">${formatDistance(s.distance)}<br>${formatDuration(s.duration)}</span>
            <span class="sub" style="text-align:right;min-width:4.5em">${formatNumber(s.avg_power, 'W')}<br>${s.avg_hr ? formatNumber(s.avg_hr, 'bpm') : ''}</span>
        </button>`;
}

export async function openSessionDetails(platform, sessionKey) {
    let s;
    try {
        s = await platform.api.session(sessionKey);
    } catch (error) {
        modal({ title: 'Session', body: `<div class="notice error">${esc(error.message)}</div>` });
        return;
    }
    const body = `
        <p class="muted">${esc(s.nickname || s.username || '')} · ${formatDate(s.started_at, { dateStyle: 'full', timeStyle: 'short' })}</p>
        ${s.notes?.description ? `<p>${esc(s.notes.description)}</p>` : ''}
        <div class="stat-grid">
            ${stat('Duration', formatDuration(s.duration))}
            ${stat('Distance', formatDistance(s.distance))}
            ${stat('Avg power', formatNumber(s.avg_power, 'W'))}
            ${stat('Max power', formatNumber(s.max_power, 'W'))}
            ${stat('Avg speed', formatSpeed(s.avg_speed))}
            ${stat('Avg cadence', formatNumber(s.avg_cadence, 'rpm'))}
            ${stat('Avg heart rate', formatNumber(s.avg_hr, 'bpm'))}
            ${stat('Work', formatNumber(s.energy, 'kJ'))}
        </div>
        <p class="muted">Recorded in ${esc(platform.app(s.application_id)?.title ?? s.application_id ?? 'unknown')}.</p>`;
    modal({
        title: sessionTitle(platform, s),
        body,
        actions: [
            { label: 'Download TCX', onClick: () => download(platform, sessionKey, 'tcx').then(() => false) },
            { label: 'Download .ride', onClick: () => download(platform, sessionKey, 'ride').then(() => false) },
            { label: 'Close', primary: true },
        ],
    });
}

function stat(label, value) {
    return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}

async function download(platform, sessionKey, format) {
    try {
        const record = await platform.api.session(sessionKey, { withData: true });
        if (!record.data) throw new Error('This session has no recorded data.');
        const session = await platform.toSession(record);
        if (format === 'tcx') session.downloadTCX();
        else session.downloadBinary();
    } catch (error) {
        notify(platform, `Download failed: ${error.message}`);
        console.error(error);
    }
}

/** Click handling for any container with session rows. */
export function bindSessionRows(platform, container) {
    container.addEventListener('click', (event) => {
        const key = event.target.closest('[data-session]')?.dataset.session;
        if (key) openSessionDetails(platform, key);
    });
}
