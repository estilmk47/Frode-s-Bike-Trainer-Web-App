<?php
/*
 * Helpers shared by every API script: JSON responses, request checks (same origin, API keys),
 * the logged-in user (from the fbt_accounts / fbt_active cookies) and user/session JSON.
 *
 * Access rules (see private-description.txt):
 * - Writing account data (create_user, update_user, ...): only this site itself.
 * - Saving sessions: this site, or the origins listed in config 'session_origins'.
 * - Reading public information (get_*): this site, or anyone with an API key from config 'api_keys'.
 */

require_once __DIR__ . '/database_link.php';

/* ---------- Responses ---------- */

function respond(array $data = [], int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode(['ok' => true] + $data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400, ?string $code = null): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['ok' => false, 'error' => $message, 'code' => $code], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function require_method(string $method): void
{
    if ($_SERVER['REQUEST_METHOD'] !== $method) fail("Use $method for this request.", 405, 'method');
}

/** The JSON request body as an array. */
function request_body(): array
{
    $data = json_decode(file_get_contents('php://input'), true);
    if (!is_array($data)) fail('Expected a JSON body.', 400, 'body');
    return $data;
}

/* ---------- Where does the request come from? ---------- */

function own_origin(): string
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    return ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? '');
}

function request_origin(): ?string
{
    return $_SERVER['HTTP_ORIGIN'] ?? null;
}

function is_same_origin(): bool
{
    // Modern browsers say it directly.
    if (isset($_SERVER['HTTP_SEC_FETCH_SITE'])) return $_SERVER['HTTP_SEC_FETCH_SITE'] === 'same-origin';
    $origin = request_origin();
    if ($origin !== null) return strcasecmp($origin, own_origin()) === 0;
    $referer = $_SERVER['HTTP_REFERER'] ?? '';
    if ($referer !== '') {
        $parts = parse_url($referer);
        $host = ($parts['host'] ?? '') . (isset($parts['port']) ? ':' . $parts['port'] : '');
        return strcasecmp($host, $_SERVER['HTTP_HOST'] ?? '') === 0;
    }
    return false;
}

function require_same_origin(): void
{
    if (!is_same_origin()) fail('This request is only allowed from the site itself.', 403, 'origin');
}

function has_valid_api_key(): bool
{
    global $config;
    $key = $_SERVER['HTTP_X_API_KEY'] ?? ($_GET['api_key'] ?? '');
    if ($key === '') return false;
    foreach (array_keys($config['api_keys'] ?? []) as $valid) {
        if (hash_equals((string) $valid, (string) $key)) return true;
    }
    return false;
}

function require_same_origin_or_api_key(): void
{
    if (is_same_origin()) return;
    if (has_valid_api_key()) {
        header('Access-Control-Allow-Origin: *');
        return;
    }
    fail('An API key is needed to read this from another site.', 403, 'api_key');
}

/* ---------- Users ---------- */

/** The active logged-in user from the cookies, or null. */
function current_user(): ?array
{
    static $user = false;
    if ($user !== false) return $user;
    $user = null;

    $accounts = json_decode($_COOKIE['fbt_accounts'] ?? '[]', true);
    if (!is_array($accounts)) return null;
    $active = $_COOKIE['fbt_active'] ?? null;

    $entry = null;
    foreach ($accounts as $account) {
        if (!is_array($account) || !isset($account['username'], $account['key'])) continue;
        if ($entry === null) $entry = $account; // first account as fallback
        if ($active !== null && strcasecmp($account['username'], $active) === 0) {
            $entry = $account;
            break;
        }
    }
    if ($entry === null) return null;
    $user = user_from_credentials((string) $entry['username'], (string) $entry['key']);
    return $user;
}

function user_from_credentials(string $username, string $key): ?array
{
    global $database;
    $statement = $database->prepare('SELECT * FROM user WHERE username = ?');
    $statement->execute([$username]);
    $row = $statement->fetch();
    return $row && hash_equals($row['user_key'], $key) ? $row : null;
}

function require_user(): array
{
    $user = current_user();
    if (!$user) fail('Log in first.', 401, 'login');
    return $user;
}

function find_user_by_username(string $username): ?array
{
    global $database;
    $statement = $database->prepare('SELECT * FROM user WHERE username = ?');
    $statement->execute([$username]);
    return $statement->fetch() ?: null;
}

function user_stats(int $user_id): array
{
    global $database;
    $statement = $database->prepare('SELECT * FROM user_stats WHERE user_id = ?');
    $statement->execute([$user_id]);
    $stats = $statement->fetch() ?: ['longest_ride' => 0, 'total_distance' => 0, 'total_time' => 0, 'session_count' => 0, 'level' => 0, 'level_updated_at' => null, 'coins' => 0];
    return [
        'longest_ride' => (float) $stats['longest_ride'],
        'total_distance' => (float) $stats['total_distance'],
        'total_time' => (int) $stats['total_time'],
        'session_count' => (int) $stats['session_count'],
        'level' => effective_level((float) $stats['level'], $stats['level_updated_at']),
        'coins' => (int) $stats['coins'],
    ];
}

/**
 * The stored level slowly falls off when someone hasn't ridden for a while:
 * after one month without new sessions it drops 5 % per month.
 */
function effective_level(float $level, ?string $updated_at): float
{
    if ($updated_at === null) return $level;
    $months = (time() - strtotime($updated_at . ' UTC')) / (30 * 24 * 3600);
    if ($months <= 1) return round($level, 2);
    return round($level * pow(0.95, $months - 1), 2);
}

function is_following(int $user_id, int $friend_id): bool
{
    global $database;
    $statement = $database->prepare('SELECT 1 FROM user_friend WHERE user_id = ? AND friend_id = ?');
    $statement->execute([$user_id, $friend_id]);
    return (bool) $statement->fetchColumn();
}

function number_or_null($value): ?float
{
    return $value === null || $value === '' ? null : (float) $value;
}

/** Everything about the logged-in user, for themselves. Never includes user_key. */
function own_user_json(array $row): array
{
    $layout = json_decode($row['home_layout'] ?? 'null', true);
    return [
        'user_id' => (int) $row['user_id'],
        'username' => $row['username'],
        'nickname' => $row['nickname'],
        'email' => $row['email'],
        'icon' => $row['icon'],
        'icon_image' => $row['icon_image'],
        'is_public' => (int) $row['is_public'],
        'birthday' => $row['birthday'],
        'weight' => number_or_null($row['weight']),
        'ftp' => number_or_null($row['ftp']),
        'gender' => $row['gender'] === null ? null : (int) $row['gender'],
        'difficulty' => $row['difficulty'] === null ? null : (int) $row['difficulty'],
        'home_layout' => is_array($layout) ? $layout : null,
        'created_at' => $row['created_at'],
        'stats' => user_stats((int) $row['user_id']),
        'own' => true,
    ];
}

/** What other people may see. Private profiles show only the name. */
function public_user_json(array $row, ?array $viewer = null): array
{
    $result = [
        'username' => $row['username'],
        'nickname' => $row['nickname'],
        'icon' => $row['icon'],
        'icon_image' => $row['icon_image'],
        'is_public' => (int) $row['is_public'],
        'is_friend' => $viewer ? is_following((int) $viewer['user_id'], (int) $row['user_id']) : false,
    ];
    if ((int) $row['is_public'] === 1) $result['stats'] = user_stats((int) $row['user_id']);
    return $result;
}

/* ---------- Sessions ---------- */

/** Session row (joined with user columns) → JSON. */
function session_json(array $row, bool $with_data = false): array
{
    $result = [
        'session_key' => $row['session_key'],
        'username' => $row['username'],
        'nickname' => $row['nickname'],
        'icon' => $row['icon'],
        'icon_image' => $row['icon_image'],
        'application_id' => $row['application_id'],
        'is_public' => (int) $row['is_public'],
        'started_at' => $row['started_at'],
        'duration' => (int) $row['duration'],
        'distance' => (float) $row['distance'],
        'avg_power' => number_or_null($row['avg_power']),
        'max_power' => number_or_null($row['max_power']),
        'avg_hr' => number_or_null($row['avg_hr']),
        'avg_speed' => number_or_null($row['avg_speed']),
        'avg_cadence' => number_or_null($row['avg_cadence']),
        'energy' => number_or_null($row['energy']),
        'notes' => json_decode($row['notes'] ?? 'null', true) ?: new stdClass(),
    ];
    if ($with_data) $result['data'] = $row['session_data'] === null ? null : base64_encode($row['session_data']);
    return $result;
}

/** ISO 8601 (any timezone) → "YYYY-MM-DDTHH:MM:SSZ" in UTC, or null. */
function normalize_time($value): ?string
{
    if (!is_string($value) || $value === '') return null;
    $time = strtotime($value);
    return $time === false ? null : gmdate('Y-m-d\TH:i:s\Z', $time);
}

/* ---------- Profile pictures ----------
 * user.icon_image is one of:
 *   null                                              – the default picture (assets/profile_icons/default.png)
 *   "assets/profile_icons/<file>"                     – a picture from the library
 *   "assets/user_uploaded_profile_icons/<user>.png?v" – the user's own upload
 */

const PROFILE_ICON_FOLDER = 'assets/user_uploaded_profile_icons/';
const PROFILE_ICON_LIBRARY = 'assets/profile_icons/';
const PROFILE_ICON_DEFAULT = 'default.png';

/** File names of the library pictures, default first. */
function profile_icon_library(): array
{
    $files = [];
    foreach (scandir(dirname(__DIR__) . '/' . PROFILE_ICON_LIBRARY) ?: [] as $file) {
        if (preg_match('/^[A-Za-z0-9_.\-]+\.(png|jpe?g|webp|gif)$/i', $file)) $files[] = $file;
    }
    natcasesort($files);
    $files = array_values(array_diff($files, [PROFILE_ICON_DEFAULT]));
    if (is_file(dirname(__DIR__) . '/' . PROFILE_ICON_LIBRARY . PROFILE_ICON_DEFAULT)) array_unshift($files, PROFILE_ICON_DEFAULT);
    return $files;
}

function is_uploaded_profile_icon(?string $icon_image): bool
{
    return $icon_image !== null && strpos($icon_image, PROFILE_ICON_FOLDER) === 0;
}

/** Absolute path of a user's uploaded picture (one per user, named after the username). */
function profile_icon_path(string $username): string
{
    return dirname(__DIR__) . '/' . PROFILE_ICON_FOLDER . $username . '.png';
}

/** The value stored in user.icon_image; ?v= makes browsers fetch a replaced picture again. */
function profile_icon_url(string $username): string
{
    return PROFILE_ICON_FOLDER . rawurlencode($username) . '.png?v=' . time();
}

/* ---------- Misc ---------- */

function random_key(int $length): string
{
    $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    $key = '';
    for ($i = 0; $i < $length; $i++) $key .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return $key;
}

function valid_username(string $username): bool
{
    return (bool) preg_match('/^[A-Za-z0-9_.\-]{3,60}$/', $username);
}

function valid_email(string $email): bool
{
    return strlen($email) <= 254 && filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
}

function login_link(array $user): string
{
    global $config;
    return rtrim($config['site_url'], '/') . '/logIn/?username=' . rawurlencode($user['username']) . '&key=' . rawurlencode($user['user_key']);
}

/**
 * E-mail a login link to the user. Returns extra response fields
 * (the link itself when 'dev_return_login_link' is on).
 */
function mail_login_link(array $user): array
{
    global $config, $database;
    $link = login_link($user);
    $subject = "Your login link for Frode's Bike Trainer";
    $message = "Hi {$user['username']}!\r\n\r\n"
        . "Open this link to log in on your device:\r\n$link\r\n\r\n"
        . "The link keeps you logged in for one year. Anyone with the link can log in as you, so don't share it.\r\n"
        . "Didn't ask for this? Just ignore this e-mail.\r\n";
    $headers = 'From: ' . $config['mail_from'] . "\r\nContent-Type: text/plain; charset=utf-8";

    $database->prepare('UPDATE user SET last_login_link_at = CURRENT_TIMESTAMP WHERE user_id = ?')->execute([$user['user_id']]);

    if (!empty($config['dev_return_login_link'])) return ['login_link' => $link];
    if (!@mail($user['email'], $subject, $message, $headers)) {
        fail('The login e-mail could not be sent. Try again later.', 500, 'mail');
    }
    return [];
}
