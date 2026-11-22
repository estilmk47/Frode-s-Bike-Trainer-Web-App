<?php
/*
 * Sending e-mail, set up under 'mail' in server/config.php:
 *
 *   'smtp' – log in to a mail provider and send through it (Gmail: smtp.gmail.com with an
 *            App password). Needs PHP's openssl extension (extension=openssl in php.ini).
 *   'php'  – PHP's own mail(), for servers that have a working sendmail.
 *
 * A small SMTP client of its own, so nothing has to be installed. Passwords never end up in
 * the log or in a response.
 *
 * Try it from a terminal:  php server/test_mail.php you@example.com
 */

/**
 * Sends a plain-text e-mail. Returns null when it was sent, otherwise what went wrong
 * (for the server log, not for visitors).
 */
function send_mail(array $config, string $to, string $subject, string $text): ?string
{
    $mail = ($config['mail'] ?? []) + ['transport' => 'php'];
    $from = $config['mail_from'] ?? '';
    [$fromName, $fromAddress] = split_address($from);
    $to = clean_header($to);
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) return 'Not an e-mail address: ' . $to;

    if ($mail['transport'] === 'php') {
        $headers = 'From: ' . format_address($fromName, $fromAddress) . "\r\n"
            . "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit";
        return @mail($to, encode_header($subject), $text, $headers) ? null : 'PHP mail() failed (is sendmail set up?)';
    }
    if ($mail['transport'] !== 'smtp') return 'Unknown mail transport "' . $mail['transport'] . '"';
    if (!extension_loaded('openssl')) return 'PHP\'s openssl extension is off: enable extension=openssl in php.ini (' . php_ini_loaded_file() . ')';

    // Gmail only sends as the account itself (or its aliases): an empty sender is the account.
    if ($fromAddress === '') $fromAddress = (string) ($mail['username'] ?? '');

    $message = implode("\r\n", [
        'Date: ' . date('r'),
        'From: ' . format_address($fromName, $fromAddress),
        'To: <' . $to . '>',
        'Subject: ' . encode_header($subject),
        'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . (explode('@', $fromAddress)[1] ?? 'localhost') . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',    // no line length limits, no lines that start with a dot
        '',
        rtrim(chunk_split(base64_encode(str_replace(["\r\n", "\n"], ["\n", "\r\n"], $text)), 76, "\r\n")),
    ]);

    try {
        $smtp = new SmtpConnection($mail);
        $smtp->send($fromAddress, $to, $message);
        $smtp->quit();
        return null;
    } catch (RuntimeException $error) {
        return $error->getMessage();
    }
}

/** "Name <address>" → [name, address]; a bare address → ['', address]. */
function split_address(string $value): array
{
    $value = clean_header($value);
    if (preg_match('/^\s*"?(.*?)"?\s*<([^>]+)>\s*$/', $value, $m)) return [trim($m[1]), trim($m[2])];
    return ['', trim($value)];
}

function format_address(string $name, string $address): string
{
    return $name === '' ? "<$address>" : encode_header($name) . " <$address>";
}

/** Header text: plain ASCII stays as it is, anything else (æøå, quotes …) as UTF-8 base64. */
function encode_header(string $text): string
{
    $text = clean_header($text);
    return preg_match('/^[A-Za-z0-9 .,!?:()\-]*$/', $text) ? $text : '=?UTF-8?B?' . base64_encode($text) . '?=';
}

/** No line breaks in headers (they would let someone add headers of their own). */
function clean_header(string $text): string
{
    return trim(str_replace(["\r", "\n"], ' ', $text));
}

/** One SMTP session: connect, (STARTTLS,) log in, send. Errors are RuntimeExceptions. */
final class SmtpConnection
{
    /** @var resource */
    private $socket;

    public function __construct(private array $mail)
    {
        $host = (string) ($mail['host'] ?? '');
        $port = (int) ($mail['port'] ?? 465);
        $encryption = $mail['encryption'] ?? ($port === 465 ? 'ssl' : 'tls');
        $timeout = (int) ($mail['timeout'] ?? 15);
        if ($host === '') throw new RuntimeException('No mail host in config.php (mail → host).');

        $ssl = ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host];
        if (!empty($mail['ca_file'])) $ssl['cafile'] = $mail['ca_file'];
        $context = stream_context_create(['ssl' => $ssl]);
        $address = ($encryption === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port;
        $socket = @stream_socket_client($address, $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $context);
        if (!$socket) {
            // Certificate problems leave $errstr empty and only raise a warning.
            if ($errstr === '' || $errstr === null) $errstr = error_get_last()['message'] ?? 'unknown error';
            $hint = str_contains(strtolower((string) $errstr), 'certificate')
                ?' (if it is about certificates: set mail → ca_file to a cacert.pem, see config.example.php)' : '';
            throw new RuntimeException("Could not connect to $host:$port: $errstr$hint");
        }
        stream_set_timeout($socket, $timeout);
        $this->socket = $socket;

        $this->expect(220);
        $this->hello();
        if ($encryption === 'tls') {
            $this->command('STARTTLS', 220);
            if (!@stream_socket_enable_crypto($this->socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new RuntimeException('STARTTLS failed (certificates? see mail → ca_file in config.example.php)');
            }
            $this->hello();
        }
        $username = (string) ($mail['username'] ?? '');
        if ($username !== '') {
            // Google shows App passwords in groups of four ("abcd efgh ijkl mnop"): the spaces don't belong to it.
            $password = str_replace(' ', '', (string) ($mail['password'] ?? ''));
            $this->command('AUTH LOGIN', 334);
            $this->command(base64_encode($username), 334, 'the user name');
            $this->command(base64_encode($password), 235, 'the password',
                ' – for Gmail use an App password (Google account → Security → 2-Step Verification → App passwords), not the normal one');
        }
    }

    public function send(string $from, string $to, string $message): void
    {
        $this->command("MAIL FROM:<$from>", 250);
        $this->command("RCPT TO:<$to>", [250, 251]);
        $this->command('DATA', 354);
        $this->command($message . "\r\n.", 250, 'the message');
    }

    public function quit(): void
    {
        @fwrite($this->socket, "QUIT\r\n");
        @fclose($this->socket);
    }

    private function hello(): void
    {
        $name = preg_replace('/[^A-Za-z0-9.\-]/', '', gethostname() ?: 'localhost') ?: 'localhost';
        $this->command("EHLO $name", 250);
    }

    /** Sends one line; $what is how it is named in errors (so passwords are never shown). */
    private function command(string $line, int|array $expect, ?string $what = null, string $hint = ''): void
    {
        if (@fwrite($this->socket, $line . "\r\n") === false) throw new RuntimeException('The mail server closed the connection.');
        $this->expect($expect, $what ?? strtok($line, "\r\n"), $hint);
    }

    private function expect(int|array $codes, string $after = 'connecting', string $hint = ''): void
    {
        $reply = '';
        while (($line = fgets($this->socket, 1024)) !== false) {
            $reply .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') break;   // "250-…" goes on, "250 …" is the last line
        }
        $code = (int) substr($reply, 0, 3);
        if (!in_array($code, (array) $codes, true)) {
            $text = trim(preg_replace('/\s+/', ' ', $reply)) ?: 'no answer (timeout)';
            throw new RuntimeException("Mail server after $after: $text$hint");
        }
    }
}
