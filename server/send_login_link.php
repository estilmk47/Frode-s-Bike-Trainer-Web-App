<?php
/*
 * POST {email} – e-mail a new login link. Only allowed from this site.
 * The answer is the same whether the address exists or not.
 */
require_once __DIR__ . '/api_common.php';

require_method('POST');
require_same_origin();

$body = request_body();
$email = trim((string) ($body['email'] ?? ''));
if (!valid_email($email)) fail('That does not look like an e-mail address.', 400, 'email');

$message = 'If there is a user with that e-mail, a login link is on its way. Check your inbox (and the spam folder).';

$statement = $database->prepare('SELECT * FROM user WHERE email = ?');
$statement->execute([$email]);
$user = $statement->fetch();
if (!$user) respond(['message' => $message]);

// Don't send more than one e-mail per interval to the same address.
$interval = (int) ($config['login_link_interval'] ?? 60);
$statement = $database->prepare("SELECT 1 FROM user WHERE user_id = ? AND last_login_link_at > datetime('now', ?)");
$statement->execute([$user['user_id'], "-$interval seconds"]);
if ($statement->fetchColumn() && empty($config['dev_return_login_link'])) respond(['message' => $message]);

respond(['message' => $message] + mail_login_link($user));
