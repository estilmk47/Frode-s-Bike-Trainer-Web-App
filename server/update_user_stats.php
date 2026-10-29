<?php
/*
 * User stats: totals, longest ride and level, calculated from the user's sessions.
 *
 * Included by save_user_session.php (recalculate_user_stats()).
 * POST to this file directly to recalculate the logged-in user's stats (only from this site).
 *
 * Keep the formulas in sync with core/api.js (sessionScore, coinsForSession) used in local mode.
 */
require_once __DIR__ . '/api_common.php';

const LEVEL_SESSIONS = 10; // the best N sessions count
const LEVEL_MONTHS = 6;    // ... of the last N months

/**
 * Score of a single session: watts per kilo (75 kg when unknown) × 10, scaled down for rides
 * shorter than an hour so a short sprint does not beat a long solid effort.
 */
function session_score(?float $avg_power, int $duration, ?float $weight): float
{
    if (!$avg_power || $duration <= 0) return 0.0;
    $watts_per_kilo = $avg_power / ($weight ?: 75);
    return $watts_per_kilo * 10 * min(1, sqrt($duration / 3600));
}

/** Coins earned for one session: 1 per km plus 1 per 10 minutes. */
function coins_for_session(float $distance, int $duration): int
{
    return intdiv((int) $distance, 1000) + intdiv($duration, 600);
}

function recalculate_user_stats(int $user_id): array
{
    global $database;

    $statement = $database->prepare(
        'SELECT COUNT(*) AS session_count, COALESCE(SUM(distance), 0) AS total_distance,
                COALESCE(SUM(duration), 0) AS total_time, COALESCE(MAX(distance), 0) AS longest_ride
         FROM session WHERE user_id = ?'
    );
    $statement->execute([$user_id]);
    $totals = $statement->fetch();

    $statement = $database->prepare('SELECT weight FROM user WHERE user_id = ?');
    $statement->execute([$user_id]);
    $weight = $statement->fetchColumn();
    $weight = $weight === null || $weight === false ? null : (float) $weight;

    $since = gmdate('Y-m-d\TH:i:s\Z', strtotime('-' . LEVEL_MONTHS . ' months'));
    $statement = $database->prepare('SELECT avg_power, duration FROM session WHERE user_id = ? AND started_at >= ?');
    $statement->execute([$user_id, $since]);
    $scores = array_map(function ($row) use ($weight) {
        return session_score($row['avg_power'] === null ? null : (float) $row['avg_power'], (int) $row['duration'], $weight);
    }, $statement->fetchAll());
    rsort($scores);
    $scores = array_slice($scores, 0, LEVEL_SESSIONS);

    $database->prepare('INSERT OR IGNORE INTO user_stats (user_id) VALUES (?)')->execute([$user_id]);
    $database->prepare(
        'UPDATE user_stats SET session_count = ?, total_distance = ?, total_time = ?, longest_ride = ? WHERE user_id = ?'
    )->execute([$totals['session_count'], $totals['total_distance'], $totals['total_time'], $totals['longest_ride'], $user_id]);

    // Without recent sessions the old level stays and falls off over time (see effective_level()).
    if ($scores) {
        $database->prepare('UPDATE user_stats SET level = ?, level_updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
            ->execute([array_sum($scores) / count($scores), $user_id]);
    }

    return user_stats($user_id);
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    require_method('POST');
    require_same_origin();
    $user = require_user();
    respond(['stats' => recalculate_user_stats((int) $user['user_id'])]);
}
