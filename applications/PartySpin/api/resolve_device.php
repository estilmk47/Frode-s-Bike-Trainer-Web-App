<?php
/*
 * POST {deviceId?} → {deviceId}
 * The id this browser rides with. A logged in hub user (checked with the login cookie) has the same
 * id on every device; a guest keeps the id stored in the browser. A guest who logs in takes their
 * guest id along to the account; someone who logged out becomes a new guest.
 */
require_once __DIR__ . '/partyspin_common.php';

require_method('POST');
require_same_origin();

$body = request_body();
$user = current_user();
$user_id = $user ? (int) $user['user_id'] : null;

$statement = $ps_db->prepare('SELECT device_id, user_id FROM partyspin_device WHERE device_id = ?');
$statement->execute([mb_substr((string) ($body['deviceId'] ?? ''), 0, 40)]);
$stored = $statement->fetch() ?: null;

$device_id = null;
if ($user_id !== null) {
    $statement = $ps_db->prepare('SELECT device_id FROM partyspin_device WHERE user_id = ?');
    $statement->execute([$user_id]);
    $device_id = $statement->fetchColumn() ?: null;
    if ($device_id === null && $stored && $stored['user_id'] === null) {
        $device_id = $stored['device_id'];     // a guest logged in: the guest id becomes the user's
    }
} elseif ($stored && $stored['user_id'] === null) {
    $device_id = $stored['device_id'];
}

if ($device_id === null) {
    $device_id = random_key(24);
    $ps_db->prepare('INSERT INTO partyspin_device (device_id, user_id) VALUES (?, ?)')->execute([$device_id, $user_id]);
} else {
    $ps_db->prepare('UPDATE partyspin_device SET user_id = ?, last_seen_at = CURRENT_TIMESTAMP WHERE device_id = ?')
        ->execute([$user_id, $device_id]);
}

respond(['deviceId' => $device_id]);
