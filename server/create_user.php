<?php
/*
 * POST {username, email} – create a user and e-mail a login link.
 * New users are private by default. Only allowed from this site.
 */
require_once __DIR__ . '/api_common.php';

require_method('POST');
require_same_origin();

$body = request_body();
$username = trim((string) ($body['username'] ?? ''));
$email = trim((string) ($body['email'] ?? ''));

if (!valid_username($username)) fail('Usernames are 3–60 characters: letters, numbers, _ . and -.', 400, 'username');
if (!valid_email($email)) fail('That does not look like an e-mail address.', 400, 'email');
if (find_user_by_username($username)) fail('That username is taken. Pick another one.', 409, 'username_taken');

$statement = $database->prepare('SELECT 1 FROM user WHERE email = ?');
$statement->execute([$email]);
if ($statement->fetchColumn()) {
    fail('There is already a user with this e-mail. Use "Log in" to get a new login link.', 409, 'email_taken');
}

try {
    $database->beginTransaction();
    $database->prepare('INSERT INTO user (user_key, username, email, is_public) VALUES (?, ?, ?, 0)')
        ->execute([random_key(32), $username, $email]);
    $user_id = (int) $database->lastInsertId();
    $database->prepare('INSERT INTO user_stats (user_id) VALUES (?)')->execute([$user_id]);
    $database->commit();
} catch (PDOException $exception) {
    if ($database->inTransaction()) $database->rollBack();
    if ($exception->getCode() === '23000') fail('That username or e-mail is already in use.', 409, 'taken');
    throw $exception;
}

$user = find_user_by_username($username);
$extra = mail_login_link($user);
respond(['message' => "Welcome, $username! We sent a login link to $email."] + $extra);
