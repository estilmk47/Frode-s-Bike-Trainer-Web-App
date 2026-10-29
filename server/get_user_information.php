<?php
/*
 * GET                     – the logged-in user ({user: null} when nobody is logged in)
 * GET ?username=<name>    – a user's profile (everything for yourself, the public part for others)
 * GET ?search=<text>      – public users whose username or nickname matches (max 30)
 *
 * Allowed from this site, or from elsewhere with an API key (then only public information).
 */
require_once __DIR__ . '/api_common.php';

require_method('GET');
require_same_origin_or_api_key();

$viewer = is_same_origin() ? current_user() : null;

if (isset($_GET['search'])) {
    $search = trim((string) $_GET['search']);
    $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search) . '%';
    $statement = $database->prepare(
        "SELECT * FROM user WHERE is_public = 1 AND (username LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\')
         ORDER BY username = ? DESC, username LIMIT 30"
    );
    $statement->execute([$like, $like, $search]);
    $users = array_map(function ($row) use ($viewer) { return public_user_json($row, $viewer); }, $statement->fetchAll());
    respond(['users' => $users]);
}

if (isset($_GET['username'])) {
    $row = find_user_by_username((string) $_GET['username']);
    if (!$row) fail('There is no user with that name.', 404, 'not_found');
    if ($viewer && (int) $viewer['user_id'] === (int) $row['user_id']) respond(['user' => own_user_json($row)]);
    respond(['user' => public_user_json($row, $viewer)]);
}

respond(['user' => $viewer ? own_user_json($viewer) : null]);
