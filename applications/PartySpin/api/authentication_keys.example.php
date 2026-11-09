<?php
/*
 * Authentication keys: who may create rooms in Party Spin (Create in the lobby).
 *
 * Copy this file to authentication_keys.php and put the real keys there. That file is in .gitignore,
 * so the keys never end up in the repository.
 *
 *   'Name' => 'key',
 *
 * - The name is shown as "Logged in as …", and the rooms someone makes belong to their name: give
 *   a person a new key under the same name and they keep their rooms.
 * - A key must be at least 12 characters (shorter ones are ignored). Make one with, for example:
 *       php -r "echo bin2hex(random_bytes(12));"
 * - Delete a line to take someone's access away (their rooms stay, but nobody can edit them).
 * - Changes count straight away: the PHP scripts and the Party Spin server read this file each time.
 * - Keep to the simple form above, one key per line: the Party Spin server (Python) reads it too.
 */
return [
    // 'Frode' => 'a-long-random-key',
];
