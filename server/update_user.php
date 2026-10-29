<?php
/*
 * POST {is_public?, icon?, username?, email?} – change account settings of the logged-in user.
 * icon is the background colour of the profile picture (the picture itself: upload_profile_icon.php).
 * Only allowed from this site. After a username change the front end must update its cookie
 * (core/accounts.js renameAccount).
 */
require_once __DIR__ . '/api_common.php';

require_method('POST');
require_same_origin();
$user = require_user();
$body = request_body();

$changes = [];

if (array_key_exists('is_public', $body)) {
    $changes['is_public'] = $body['is_public'] ? 1 : 0;
}
if (array_key_exists('icon', $body)) {
    $icon = (string) $body['icon'];
    if (!preg_match('/^[a-z]{1,20}$/', $icon)) fail('Invalid background colour.', 400, 'icon');
    $changes['icon'] = $icon;
}
if (array_key_exists('username', $body)) {
    $username = trim((string) $body['username']);
    if (!valid_username($username)) fail('Usernames are 3–60 characters: letters, numbers, _ . and -.', 400, 'username');
    $existing = find_user_by_username($username);
    if ($existing && (int) $existing['user_id'] !== (int) $user['user_id']) fail('That username is taken.', 409, 'username_taken');
    $changes['username'] = $username;
}
if (array_key_exists('email', $body)) {
    $email = trim((string) $body['email']);
    if (!valid_email($email)) fail('That does not look like an e-mail address.', 400, 'email');
    $statement = $database->prepare('SELECT user_id FROM user WHERE email = ? AND user_id <> ?');
    $statement->execute([$email, $user['user_id']]);
    if ($statement->fetchColumn()) fail('That e-mail is used by another user.', 409, 'email_taken');
    $changes['email'] = $email;
}

// The uploaded picture is named after the username, so it moves along with a rename.
if (isset($changes['username']) && $changes['username'] !== $user['username'] && is_uploaded_profile_icon($user['icon_image'])) {
    if (is_file(profile_icon_path($user['username']))) rename(profile_icon_path($user['username']), profile_icon_path($changes['username']));
    $changes['icon_image'] = profile_icon_url($changes['username']);
}

if ($changes) {
    $columns = implode(', ', array_map(function ($column) { return "$column = ?"; }, array_keys($changes)));
    $values = array_values($changes);
    $values[] = $user['user_id'];
    $database->prepare("UPDATE user SET $columns WHERE user_id = ?")->execute($values);
}

$statement = $database->prepare('SELECT * FROM user WHERE user_id = ?');
$statement->execute([$user['user_id']]);
respond(['user' => own_user_json($statement->fetch())]);
