/**
 * Focus navigation for keyboard and Zwift controllers – one cursor, always visible, every control reachable.
 *
 * Actions:
 *   next / prev   – the next/previous control in reading order, wrapping around. Repeating it reaches
 *                   every control on the screen, so even a controller with two buttons can do everything.
 *   left / right  – same as prev / next.
 *   up / down     – the control above/below in the same row group; at the edge of the group, jump
 *                   to the previous/next group (row), landing on the control remembered there.
 *   select        – press the control. On a dropdown, number or date field it starts "edit mode":
 *                   the directions then change the value, and select or back ends it.
 *   back, options – handed to the page (close page / open the options menu).
 *
 * Groups are the nearest ancestor matching GROUPS (or marked with data-nav-group).
 * The hub forwards controller buttons into pages as `fbt-nav` events ({detail: {action}}).
 *
 * The highlight is the `nav-focus` class (not :focus-visible), shown while <html data-input="nav">.
 * Using the mouse switches to data-input="pointer", which hides it until the next navigation action.
 */

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const GROUPS = [
    '[data-nav-group]', 'dialog', '.context-menu', '.page-header', '.action-bar', '.modal-actions', '.segmented',
    '.toolbar', '.pf-row', '.list', '.grid', '.calendar', '.calendar-head', '.device-card', '.search', '.color-picker',
    '.toc', 'form', '.section',
].join(', ');

const EDITABLE = 'select, input[type="number"], input[type="range"], input[type="date"]';
const TEXT_INPUT = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea';

const KEY_ACTIONS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/**
 * @param {Document} doc
 * @param {{onBack?: () => void, onOptions?: (element: Element) => void, initial?: () => Element | null}} options
 */
export function createNavigation(doc = document, { onBack, onOptions, initial } = {}) {
    const root = doc.documentElement;
    let current = null;
    let editing = null;
    let lastIdentity = null;
    const memory = new WeakMap(); // group → last control used in it

    if (!root.dataset.input) root.dataset.input = 'nav';

    /* ---------- What can be focused right now ---------- */

    function scope() {
        const dialogs = doc.querySelectorAll('dialog[open]');
        if (dialogs.length) return dialogs[dialogs.length - 1];
        const traps = doc.querySelectorAll('[data-nav-trap]');
        return traps.length ? traps[traps.length - 1] : doc.body;
    }

    function visible(element) {
        if (element.closest('[inert], [hidden]')) return false;
        if (!element.getClientRects().length) return false;
        return getComputedStyle(element).visibility !== 'hidden';
    }

    function candidates() {
        return [...scope().querySelectorAll(FOCUSABLE)].filter(visible);
    }

    function groupOf(element) {
        const s = scope();
        const group = element.parentElement?.closest(GROUPS);
        return group && s.contains(group) ? group : s;
    }

    /** A selector that finds "the same" control again after a page re-renders it. */
    function identity(element) {
        if (element.id) return `#${CSS.escape(element.id)}`;
        for (const attribute of element.attributes) {
            if (attribute.name.startsWith('data-') && attribute.name !== 'data-nav-group') {
                return `${element.tagName.toLowerCase()}[${attribute.name}="${CSS.escape(attribute.value)}"]`;
            }
        }
        if (element.name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(element.name)}"]`;
        return null;
    }

    function resolveCurrent(items) {
        const active = doc.activeElement;
        if (active && items.includes(active)) return active;
        if (current && current.isConnected && items.includes(current)) return current;
        if (lastIdentity) {
            const again = scope().querySelector(lastIdentity);
            if (again && items.includes(again)) return again;
        }
        return null;
    }

    /* ---------- Cursor ---------- */

    function setCurrent(element, { scroll = true } = {}) {
        if (!element) return;
        if (current && current !== element) current.classList.remove('nav-focus');
        current = element;
        element.classList.add('nav-focus');
        memory.set(groupOf(element), element);
        lastIdentity = identity(element) ?? lastIdentity;
        if (doc.activeElement !== element) element.focus({ preventScroll: true });
        if (scroll) element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }

    // Mouse, touch or Tab focus also moves the cursor (without forcing the highlight on).
    doc.addEventListener('focusin', (event) => {
        if (event.target.matches?.(FOCUSABLE)) setCurrent(event.target, { scroll: false });
    });
    doc.addEventListener('pointerdown', () => { root.dataset.input = 'pointer'; stopEditing(); }, true);

    /* ---------- Movement ---------- */

    function center(rect) { return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }

    function linear(items, from, step) {
        if (!from) return items[0];
        const index = items.indexOf(from);
        return items[(index + step + items.length) % items.length];
    }

    function vertical(items, from, direction) {
        const sign = direction === 'down' ? 1 : -1;
        const fromRect = from.getBoundingClientRect();
        const origin = center(fromRect);
        const group = groupOf(from);

        // 1. The nearest control above/below in the same group (rows inside a grid or form).
        let best = null;
        let bestScore = Infinity;
        for (const element of items) {
            if (element === from || groupOf(element) !== group) continue;
            const c = center(element.getBoundingClientRect());
            const forward = (c.y - origin.y) * sign;
            if (forward < fromRect.height / 2) continue;
            const score = forward + Math.abs(c.x - origin.x) * 2;
            if (score < bestScore) { bestScore = score; best = element; }
        }
        if (best) return best;

        // 2. The previous/next group, on the control remembered there or the one closest horizontally.
        const groups = [];
        for (const element of items) {
            const g = groupOf(element);
            if (!groups.includes(g)) groups.push(g);
        }
        const target = groups[groups.indexOf(group) + sign];
        if (!target) return null;
        const members = items.filter((element) => groupOf(element) === target);
        const remembered = memory.get(target);
        if (remembered && members.includes(remembered)) return remembered;
        // Enter the group on its first row (going down) or last row (going up).
        const rows = members.map((element) => ({ element, c: center(element.getBoundingClientRect()) }));
        const edgeY = sign > 0 ? Math.min(...rows.map((r) => r.c.y)) : Math.max(...rows.map((r) => r.c.y));
        const edge = rows.filter((r) => Math.abs(r.c.y - edgeY) < 12);
        edge.sort((a, b) => Math.abs(a.c.x - origin.x) - Math.abs(b.c.x - origin.x));
        return edge[0]?.element ?? members[0];
    }

    /* ---------- Edit mode (dropdowns, numbers, dates) ---------- */

    function startEditing(element) {
        editing = element;
        element.classList.add('nav-editing');
        if (element.type === 'number' && element.value === '' && element.dataset.navStart) {
            element.value = element.dataset.navStart;
            fire(element);
        }
        if (element.type === 'date' && element.value === '') {
            element.value = element.dataset.navStart ?? new Date().toISOString().slice(0, 10);
            fire(element);
        }
    }

    function stopEditing() {
        editing?.classList.remove('nav-editing');
        editing = null;
    }

    function fire(element) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function adjust(element, action) {
        const up = action === 'right' || action === 'up' || action === 'next';
        if (element.tagName === 'SELECT') {
            const index = Math.min(element.options.length - 1, Math.max(0, element.selectedIndex + (up ? 1 : -1)));
            if (index !== element.selectedIndex) { element.selectedIndex = index; fire(element); }
        } else if (element.type === 'date') {
            const date = new Date(`${element.value}T12:00:00`);
            if (action === 'up' || action === 'down') date.setFullYear(date.getFullYear() + (up ? 1 : -1));
            else date.setMonth(date.getMonth() + (up ? 1 : -1));
            element.value = date.toISOString().slice(0, 10);
            fire(element);
        } else {
            const step = Number(element.dataset.navStep || element.step) || 1;
            const min = element.min === '' ? -Infinity : Number(element.min);
            const max = element.max === '' ? Infinity : Number(element.max);
            const value = Math.min(max, Math.max(min, (Number(element.value) || 0) + (up ? step : -step)));
            element.value = Number(value.toFixed(4));
            fire(element);
        }
    }

    /* ---------- Actions ---------- */

    function perform(action) {
        const wasPointer = root.dataset.input === 'pointer';
        root.dataset.input = 'nav';

        if (editing) {
            if (!editing.isConnected) stopEditing();
            else if (action === 'select' || action === 'back') { stopEditing(); return; }
            else if (['left', 'right', 'up', 'down', 'next', 'prev'].includes(action)) { adjust(editing, action); return; }
        }

        if (action === 'back') {
            const dialogs = doc.querySelectorAll('dialog[open]');
            if (dialogs.length) dialogs[dialogs.length - 1].close();
            else onBack?.();
            return;
        }

        const items = candidates();
        const from = resolveCurrent(items);

        if (action === 'options') {
            if (from) onOptions?.(from);
            return;
        }
        if (!from) {
            // Nothing selected yet (page just opened or re-rendered): show the cursor first.
            setCurrent(initial?.() ?? items[0]);
            return;
        }
        // After using the mouse, the first action only shows where the cursor is.
        if (wasPointer && action !== 'select') { setCurrent(from); return; }

        if (action === 'select') {
            if (from.matches(EDITABLE)) startEditing(from);
            else if (from.matches(TEXT_INPUT)) from.focus();
            else from.click();
            return;
        }
        let target = null;
        if (action === 'next' || action === 'right') target = linear(items, from, 1);
        if (action === 'prev' || action === 'left') target = linear(items, from, -1);
        if (action === 'up' || action === 'down') target = vertical(items, from, action);
        if (target) setCurrent(target);
    }

    /* ---------- Input sources ---------- */

    doc.addEventListener('fbt-nav', (event) => perform(event.detail?.action));

    doc.addEventListener('keydown', (event) => {
        const target = event.target;
        const typing = target.matches?.(TEXT_INPUT) && !target.matches(EDITABLE);
        const action = KEY_ACTIONS[event.key];

        if (action) {
            // Arrow keys keep moving the text cursor inside text fields.
            if (typing && (action === 'left' || action === 'right')) return;
            event.preventDefault();
            perform(action);
        } else if (event.key === 'Enter') {
            if (editing || target.matches?.(EDITABLE)) { event.preventDefault(); perform('select'); }
            else if (!event.isTrusted) perform('select'); // a real Enter already presses buttons
            else root.dataset.input = 'nav';
        } else if (event.key === 'Escape') {
            if (doc.querySelector('dialog[open]') && !editing) return; // the dialog closes itself
            if (typing && !editing) { target.blur(); return; }
            event.preventDefault();
            perform('back');
        } else if ((event.key === 'ContextMenu' || event.key.toLowerCase() === 'y') && onOptions && !typing) {
            event.preventDefault();
            perform('options');
        } else if (event.key === 'Tab') {
            root.dataset.input = 'nav';
        }
    });

    return {
        perform,
        focus: (element) => setCurrent(element),
        get current() { return current; },
        get editing() { return editing; },
    };
}

/** Send a navigation action to a document (e.g. a page inside the hub's frame). */
export function sendNavigation(targetWindow, action) {
    targetWindow.document.dispatchEvent(new targetWindow.CustomEvent('fbt-nav', { detail: { action } }));
}

/**
 * Zwift Click v2 / Ride button → action.
 * Right shifter: next/previous control. Left shifter: row down/up. A select, B back, Y options.
 * The Ride's D-pad (and the Click v2's navigation buttons) move in their own directions.
 */
export const CONTROLLER_ACTIONS = {
    shiftUpR: 'next', shiftDownR: 'prev',
    shiftUpL: 'down', shiftDownL: 'up',
    left: 'left', right: 'right', up: 'up', down: 'down',
    a: 'select', powerupR: 'select',
    b: 'back', powerupL: 'back',
    y: 'options', z: 'options',
};
