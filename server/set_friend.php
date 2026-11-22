<?php
/*
 * POST {username, follow: true|false} – add or remove a friend (a one-way follow).
 * Only public users can be added. Only allowed from this site.
 */
require_once __DIR__ . '/api_common.php';

require_method('POST');
require_same_origin();
$user = require_user();
$body = request_body();

$friend = find_user_by_username((string) ($body['username'] ?? ''));
if (!$friend) fail('There is no user with that name.', 404, 'not_found');
if ((int) $friend['user_id'] === (int) $user['user_id']) fail('You are already your own best friend.', 400, 'self');

if (!empty($body['follow'])) {
    // A private profile answers like a name that doesn't exist (nobody learns that it's there).
    if ((int) $friend['is_public'] !== 1) fail('There is no user with that name.', 404, 'not_found');
    $database->prepare('INSERT OR IGNORE INTO user_friend (user_id, friend_id) VALUES (?, ?)')->execute([$user['user_id'], $friend['user_id']]);
} else {
    $database->prepare('DELETE FROM user_friend WHERE user_id = ? AND friend_id = ?')->execute([$user['user_id'], $friend['user_id']]);
}

respond(['is_friend' => is_following((int) $user['user_id'], (int) $friend['user_id'])]);
