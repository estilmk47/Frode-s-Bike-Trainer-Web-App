<?php
/*
 * Checks the mail settings in config.php by sending a test e-mail. Only from a terminal:
 *
 *   php server/test_mail.php you@example.com
 */
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/mailer.php';

$to = $argv[1] ?? '';
if ($to === '') {
    fwrite(STDERR, "Usage: php server/test_mail.php you@example.com\n");
    exit(2);
}
$config = require __DIR__ . '/config.php';
$mail = ($config['mail'] ?? []) + ['transport' => 'php'];
echo 'Sending with "' . $mail['transport'] . '"'
    . ($mail['transport'] === 'smtp' ? ' through ' . ($mail['host'] ?? '?') . ':' . ($mail['port'] ?? '?') . ' as ' . ($mail['username'] ?? '?') : '')
    . " to $to …\n";

$error = send_mail($config, $to, "Test from Frode's Bike Trainer",
    "Hi!\r\n\r\nThe mail settings work: this was sent at " . date('Y-m-d H:i:s') . ".\r\n");
if ($error !== null) {
    fwrite(STDERR, "Not sent: $error\n");
    exit(1);
}
echo "Sent. Look in the inbox (and the spam folder) of $to.\n";
