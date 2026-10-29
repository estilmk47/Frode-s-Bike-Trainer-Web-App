<?php
/*
 * POST {nickname?, birthday?, gender?, weight?, ftp?, difficulty?, home_layout?}
 * Saves the logged-in user's personal information (the "global" settings). Only the fields
 * that are sent are changed; null clears a value. Only allowed from this site.
 */
require_once __DIR__ . '/api_common.php';

require_method('POST');
require_same_origin();
$user = require_user();
$body = request_body();

function number_in_range($value, float $min, float $max, string $label): ?float
{
    if ($value === null || $value === '') return null;
    if (!is_numeric($value) || $value < $min || $value > $max) fail("$label must be between $min and $max.", 400, 'range');
    return (float) $value;
}

$changes = [];

if (array_key_exists('nickname', $body)) {
    $nickname = $body['nickname'] === null ? null : trim((string) $body['nickname']);
    if ($nickname !== null && mb_strlen($nickname) > 60) fail('The nickname can be at most 60 characters.', 400, 'nickname');
    $changes['nickname'] = $nickname === '' ? null : $nickname;
}
if (array_key_exists('birthday', $body)) {
    $birthday = $body['birthday'];
    if ($birthday !== null && $birthday !== '') {
        $date = DateTime::createFromFormat('Y-m-d', (string) $birthday);
        if (!$date || $date->format('Y-m-d') !== $birthday || $date > new DateTime()) fail('The birthday is not a valid date.', 400, 'birthday');
    }
    $changes['birthday'] = $birthday === '' ? null : $birthday;
}
if (array_key_exists('gender', $body)) {
    $gender = number_in_range($body['gender'], 0, 3, 'Gender');
    $changes['gender'] = $gender === null ? null : (int) $gender;
}
if (array_key_exists('weight', $body)) $changes['weight'] = number_in_range($body['weight'], 20, 300, 'Weight');
if (array_key_exists('ftp', $body)) $changes['ftp'] = number_in_range($body['ftp'], 30, 2000, 'FTP');
if (array_key_exists('difficulty', $body)) {
    $difficulty = number_in_range($body['difficulty'], 1, 5, 'Difficulty');
    $changes['difficulty'] = $difficulty === null ? null : (int) $difficulty;
}
if (array_key_exists('home_layout', $body)) {
    $layout = $body['home_layout'];
    if ($layout !== null) {
        if (!is_array($layout) || count($layout) > 100) fail('The home layout must be a list of application ids.', 400, 'home_layout');
        foreach ($layout as $id) {
            if (!is_string($id) || !preg_match('/^[A-Za-z0-9_\-]{1,60}$/', $id)) fail('Invalid application id in the home layout.', 400, 'home_layout');
        }
        $layout = json_encode(array_values(array_unique($layout)));
    }
    $changes['home_layout'] = $layout;
}

if ($changes) {
    $columns = implode(', ', array_map(function ($column) { return "$column = ?"; }, array_keys($changes)));
    $values = array_values($changes);
    $values[] = $user['user_id'];
    $database->prepare("UPDATE user SET $columns WHERE user_id = ?")->execute($values);
}

respond(['user' => own_user_json(find_user_by_username($user['username']))]);
