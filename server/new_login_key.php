<?php
/*
 * POST – give the logged-in user a new user_key and e-mail the new login link.
 *
 * A login link keeps working (on any number of devices) until this is done. Afterwards the old
 * link and every device logged in with it (this one too, and other sites that save sessions with
 * the key) are logged out. Only allowed from this site.
 *
 * If the e-mail can't be sent, nothing changes: the old key stays.
 */
require_once __DIR__ . '/api_common.php';

require_method('POST');
require_same_origin();
$user = require_user();

// Not more than one login e-mail per interval (as send_login_link.php).
$interval = (int) ($config['login_link_interval'] ?? 60);
$statement = $database->prepare("SELECT 1 FROM user WHERE user_id = ? AND last_login_link_at > datetime('now', ?)");
$statement->execute([$user['user_id'], "-$interval seconds"]);
if ($statement->fetchColumn() && empty($config['dev_return_login_link'])) {
    fail("A login e-mail was just sent. Wait a minute and try again.", 429, 'too_soon');
}

$user['user_key'] = random_key(32);
// One transaction: when the e-mail fails, fail() ends the script before the commit and the old key stays.
$database->beginTransaction();
$database->prepare('UPDATE user SET user_key = ? WHERE user_id = ?')->execute([$user['user_key'], $user['user_id']]);
$extra = mail_login_link($user);
$database->commit();

respond(['message' => "A new login link is on its way to {$user['email']}. All your devices are logged out."] + $extra);
