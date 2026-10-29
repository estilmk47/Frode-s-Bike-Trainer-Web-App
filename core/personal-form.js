/**
 * Form for the personal information fields (PERSONAL_FIELDS in settings.js).
 *
 * withLocal = true  (Settings page): a global column and a "this device" override column.
 * withLocal = false (Profile page):  global values only; fields overridden on this device are greyed out.
 */
import { PERSONAL_FIELDS } from './settings.js';
import { esc } from './ui.js';

function inputHtml(field, name, value, disabled) {
    const common = `name="${name}" data-key="${field.key}" ${disabled ? 'disabled' : ''}`;
    if (field.type === 'select') {
        return `<select ${common}>${field.options.map((o) =>
            `<option value="${esc(o.value)}" ${String(o.value) === String(value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    }
    const attrs = [
        field.min !== undefined ? `min="${field.min}"` : '',
        field.max !== undefined ? `max="${field.max}"` : '',
        field.step !== undefined ? `step="${field.step}"` : '',
        field.maxLength ? `maxlength="${field.maxLength}"` : '',
        // Controller edit mode (core/navigation.js): bigger steps and a sensible starting value.
        field.navStep ? `data-nav-step="${field.navStep}"` : '',
        field.navStart ? `data-nav-start="${field.navStart}"` : '',
    ].join(' ');
    return `<input type="${field.type}" ${common} ${attrs} value="${esc(value ?? '')}" placeholder="${field.unit ? esc(field.unit) : ''}">`;
}

function readValue(field, element) {
    const raw = element.value.trim();
    if (raw === '') return null;
    if (field.type === 'number' || field.number) {
        const number = Number(raw);
        return Number.isFinite(number) ? number : null;
    }
    return raw;
}

/**
 * @param {import('./platform.js').Platform} platform
 * @returns {{element: HTMLElement, changes: () => {global: object, local: object}, dirty: () => {global: boolean, local: boolean}, commit: (part: string) => void, reset: () => void}}
 */
export function createPersonalForm(platform, { withLocal = true, onChange = () => {} } = {}) {
    const element = document.createElement('div');
    element.className = 'personal-form';
    let initial;

    function render() {
        const overrides = platform.settings.overrides();
        initial = { global: {}, local: { ...overrides } };
        element.innerHTML = `
            <div class="pf-row pf-head ${withLocal ? '' : 'no-local'}">
                <span></span><span>Account (global)</span>${withLocal ? '<span>This device only (local)</span>' : ''}
            </div>
            ${PERSONAL_FIELDS.map((field) => {
                const global = platform.settings.global(field.key);
                initial.global[field.key] = global ?? null;
                const overridden = field.key in overrides;
                const localPart = withLocal ? `
                    <div class="pf-local">
                        <label class="pf-flag"><input type="checkbox" data-flag="${field.key}" ${overridden ? 'checked' : ''}> Override</label>
                        ${inputHtml(field, `local-${field.key}`, overridden ? overrides[field.key] : global, !overridden)}
                    </div>` : '';
                const note = !withLocal && overridden
                    ? `<small class="muted">Overridden on this device (${esc(String(overrides[field.key]))}). Change it in Settings.</small>` : '';
                return `
                    <div class="pf-row ${withLocal ? '' : 'no-local'}">
                        <label class="pf-label"><span>${esc(field.label)}${field.unit ? ` <span class="muted">(${esc(field.unit)})</span>` : ''}</span>
                            ${field.help ? `<small class="muted">${esc(field.help)}</small>` : ''}</label>
                        <div class="pf-global ${!withLocal && overridden ? 'overridden' : ''}">
                            ${inputHtml(field, `global-${field.key}`, global, !withLocal && overridden)}${note}
                        </div>
                        ${localPart}
                    </div>`;
            }).join('')}`;
    }

    function changes() {
        const result = { global: {}, local: {} };
        for (const field of PERSONAL_FIELDS) {
            const globalInput = element.querySelector(`[name="global-${field.key}"]`);
            if (!globalInput.disabled) result.global[field.key] = readValue(field, globalInput);
            else result.global[field.key] = initial.global[field.key];
            if (withLocal && element.querySelector(`[data-flag="${field.key}"]`).checked) {
                const value = readValue(field, element.querySelector(`[name="local-${field.key}"]`));
                if (value !== null) result.local[field.key] = value;
            }
        }
        if (!withLocal) result.local = initial.local;
        return result;
    }

    function dirty() {
        const now = changes();
        const globalDirty = PERSONAL_FIELDS.some((f) => (now.global[f.key] ?? null) !== (initial.global[f.key] ?? null));
        return { global: globalDirty, local: JSON.stringify(now.local) !== JSON.stringify(initial.local) };
    }

    element.addEventListener('input', (event) => {
        const flag = event.target.dataset.flag;
        if (flag) {
            const input = element.querySelector(`[name="local-${flag}"]`);
            input.disabled = !event.target.checked;
            if (event.target.checked) input.focus();
        }
        onChange();
    });

    /** Mark the current values of one column as saved ('global' | 'local'). */
    function commit(part) {
        initial[part] = { ...changes()[part] };
    }

    render();
    return { element, changes, dirty, commit, reset: render };
}

/* Styles for the form, injected once per document. */
const css = `
.personal-form { display: grid; gap: 0.25rem; }
.pf-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(150px, 1.2fr) minmax(190px, 1.4fr); gap: 0.75rem 1rem; align-items: start; padding: 0.7rem 0; border-bottom: 1px solid var(--border); }
.pf-row.no-local { grid-template-columns: minmax(150px, 1fr) minmax(180px, 1.5fr); }
.pf-head { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 700; padding-bottom: 0.3rem; }
.pf-label { display: grid; gap: 0.2rem; font-weight: 600; }
.pf-label small { font-weight: 400; }
.pf-global { display: grid; gap: 0.3rem; }
.pf-global.overridden input, .pf-global.overridden select { opacity: 0.45; }
.pf-local { display: grid; grid-template-columns: auto 1fr; gap: 0.6rem; align-items: center; }
.pf-flag { display: flex; align-items: center; gap: 0.35em; font-size: 0.85rem; color: var(--muted); white-space: nowrap; }
@media (max-width: 700px) {
    .pf-row, .pf-row.no-local { grid-template-columns: 1fr; gap: 0.4rem; }
    .pf-head { display: none; }
    .pf-local::before { content: "This device:"; grid-column: 1 / -1; font-size: 0.8rem; color: var(--muted); }
}`;
if (!document.getElementById('personal-form-css')) {
    const style = document.createElement('style');
    style.id = 'personal-form-css';
    style.textContent = css;
    document.head.append(style);
}
