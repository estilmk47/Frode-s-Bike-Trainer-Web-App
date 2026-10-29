/**
 * Accounts logged in on this device.
 *
 * Like a game console, several riders can be logged in on the same browser and switch between
 * each other. Each login link stores `{username, key}` in the `fbt_accounts` cookie (one year),
 * and `fbt_active` remembers who is riding right now. The PHP backend reads the same cookies,
 * so no password and no extra token are ever needed.
 */
import { readCookie, writeCookie, deleteCookie } from './storage.js';

const ACCOUNTS_COOKIE = 'fbt_accounts';
const ACTIVE_COOKIE = 'fbt_active';

export function getAccounts() {
    try {
        const list = JSON.parse(readCookie(ACCOUNTS_COOKIE) || '[]');
        return Array.isArray(list) ? list.filter((a) => a && typeof a.username === 'string' && typeof a.key === 'string') : [];
    } catch {
        return [];
    }
}

function saveAccounts(list) {
    if (list.length) writeCookie(ACCOUNTS_COOKIE, JSON.stringify(list));
    else deleteCookie(ACCOUNTS_COOKIE);
}

export function getActiveUsername() {
    const accounts = getAccounts();
    const active = readCookie(ACTIVE_COOKIE);
    if (accounts.some((a) => a.username === active)) return active;
    return accounts[0]?.username ?? null;
}

export function setActiveUsername(username) {
    if (username) writeCookie(ACTIVE_COOKIE, username);
    else deleteCookie(ACTIVE_COOKIE);
}

export function addAccount(username, key) {
    const accounts = getAccounts().filter((a) => a.username.toLowerCase() !== username.toLowerCase());
    accounts.push({ username, key });
    saveAccounts(accounts);
    setActiveUsername(username);
}

export function removeAccount(username) {
    const accounts = getAccounts().filter((a) => a.username !== username);
    saveAccounts(accounts);
    if (getActiveUsername() === username || readCookie(ACTIVE_COOKIE) === username) {
        setActiveUsername(accounts[0]?.username ?? null);
    }
}

/** Replace the stored username after a rename, keeping the key. */
export function renameAccount(oldUsername, newUsername) {
    const accounts = getAccounts().map((a) => (a.username === oldUsername ? { ...a, username: newUsername } : a));
    saveAccounts(accounts);
    if (readCookie(ACTIVE_COOKIE) === oldUsername) setActiveUsername(newUsername);
}
