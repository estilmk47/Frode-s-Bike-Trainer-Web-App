-- Party Spin tables. By default they live in the hub's database (the same SQLite file as users and
-- sessions, its name is in server/config.php); applications/PartySpin/server/config.php can give
-- Party Spin a database file of its own instead (see config.example.php there).
--
-- Who writes what:
--   the PHP scripts (applications/PartySpin/api/)   devices, rooms (name, key, settings) and planned events
--   the Party Spin server (server/partyspin_server.py) players, the game state of a room, what happens in a game
--                                                     and the games that are over (partyspin_run, partyspin_run_player)
-- Who may create rooms is not in the database: see api/authentication_keys.php.
-- Both run this file when the tables are missing (the server every time it starts), so every statement
-- must be safe to run again.
--
-- Times: *_at DATETIME columns are for people (UTC). Game times are integers in ms: `started_at_ms`
-- and friends are server clock times (ms since 1970), `trigger_at` and `trigger_window` are game time
-- (ms since the start of the game, not counting pauses).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------- devices (riders)

-- Every browser that joins a game gets a device id, kept in its localStorage. It is how a rider is
-- known in a room, so a guest who loses the connection comes back as the same rider. A logged in hub
-- user has one device id on every device (resolve_device.php checks the login cookie).
CREATE TABLE IF NOT EXISTS partyspin_device (
    device_id       VARCHAR(40) PRIMARY KEY,
    user_id         INTEGER UNIQUE,                             -- the hub user (user.user_id), NULL for guests. Not a
                                                                -- foreign key: the hub's users may be in another file
    created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------- rooms

CREATE TABLE IF NOT EXISTS partyspin_room (
    room_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name            VARCHAR(40) NOT NULL,                       -- as the owner wrote it
    name_key        VARCHAR(40) NOT NULL UNIQUE,                -- lower case, no spaces: how riders find the room
    key_hash        VARCHAR(100) NOT NULL,                      -- the room key ("salt$pbkdf2-sha256"); it makes you a moderator
    owner           VARCHAR(80),                                -- the name of the authentication key that made it (api/authentication_keys.php)
    settings        TEXT        NOT NULL DEFAULT '{}',          -- JSON {mode, end: {type, value}, powerups, break, display: {background, color, video}}
                                                                -- powerups: cards can be played · break: nobody scores (cards still work);
                                                                -- both are switched on and off by moderators during a game
    edited_at_ms    INTEGER     NOT NULL DEFAULT 0,             -- last change of name, key, settings or planned events: the server reloads them

    -- The game, written by the Party Spin server.
    -- paused stops the clock (not needed in a normal game: a break is the `break` setting, the clock goes on)
    status          VARCHAR(10) NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'running', 'paused', 'ended')),
    run             INTEGER     NOT NULL DEFAULT 1,             -- the number of the game; a restart starts the next one
    started_at_ms   INTEGER,
    paused_at_ms    INTEGER,
    paused_total_ms INTEGER     NOT NULL DEFAULT 0,
    ended_at_ms     INTEGER,
    saved_at_ms     INTEGER,                                    -- time the room was not loaded does not count as game time

    created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The riders of a room, with their score and cards in the current game.
-- name, ftp, weight and difficulty are what the rider chose for Party Spin (not the hub user's values).
CREATE TABLE IF NOT EXISTS partyspin_player (
    room_id         INTEGER     NOT NULL REFERENCES partyspin_room (room_id) ON DELETE CASCADE,
    device_id       VARCHAR(40) NOT NULL REFERENCES partyspin_device (device_id) ON DELETE CASCADE,
    name            VARCHAR(40) NOT NULL,
    avatar          TEXT,                                       -- JSON {icon, image}
    ftp             REAL,
    weight          REAL,
    difficulty      INTEGER,                                    -- 1 relaxed … 5 extreme, NULL = normal
    score           REAL        NOT NULL DEFAULT 0,
    hand            TEXT        NOT NULL DEFAULT '[]',          -- JSON list of card numbers
    nope            INTEGER     NOT NULL DEFAULT 0,             -- 1: has the Nope card
    ghost           INTEGER     NOT NULL DEFAULT 0,             -- 1: ghost mode: power, heart rate, cadence and speed are sent but
                                                                --    not shown to others (only the place, name and score)
    joined_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, device_id)
);

-- ---------------------------------------------------------------------------- finished games

-- One row per game (run) that was played in a room, written when it ends and when the room is
-- restarted. The game's events stay in partyspin_event with the same run number, so a game can be
-- replayed later.
CREATE TABLE IF NOT EXISTS partyspin_run (
    room_id         INTEGER     NOT NULL REFERENCES partyspin_room (room_id) ON DELETE CASCADE,
    run             INTEGER     NOT NULL,
    status          VARCHAR(10) NOT NULL,                       -- ended, or running / paused when it was restarted before the end
    settings        TEXT        NOT NULL DEFAULT '{}',          -- the room's settings during the game (JSON, as partyspin_room)
    started_at_ms   INTEGER,
    ended_at_ms     INTEGER,
    duration_ms     INTEGER     NOT NULL DEFAULT 0,             -- game time played
    events          INTEGER     NOT NULL DEFAULT 0,             -- number of game events (seq 1 … events)
    created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, run)
);

-- The riders of a finished game and how they did.
CREATE TABLE IF NOT EXISTS partyspin_run_player (
    room_id         INTEGER     NOT NULL,
    run             INTEGER     NOT NULL,
    device_id       VARCHAR(40) NOT NULL,
    name            VARCHAR(40) NOT NULL,
    place           INTEGER     NOT NULL,
    score           REAL        NOT NULL,
    ftp             REAL,
    weight          REAL,
    difficulty      INTEGER,
    samples         TEXT,                                       -- not used yet: room for the score (and power …) over time
    PRIMARY KEY (room_id, run, device_id),
    FOREIGN KEY (room_id, run) REFERENCES partyspin_run (room_id, run) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------- events

-- The kinds of event. server_info and device_info of an event depend on its type: what they hold is
-- written here, so the table documents itself.
CREATE TABLE IF NOT EXISTS partyspin_event_type (
    type            VARCHAR(20) PRIMARY KEY,
    name            VARCHAR(40) NOT NULL,
    planned         INTEGER     NOT NULL DEFAULT 0,             -- 1: can be planned before a game (create menu, moderator)
    playable        INTEGER     NOT NULL DEFAULT 1,             -- 0: can be planned, but the game does not run it yet
    description     TEXT,
    server_info     TEXT,                                       -- what partyspin_event.server_info holds
    device_info     TEXT                                        -- what partyspin_event.device_info holds
);

INSERT INTO partyspin_event_type (type, name, planned, playable, description, server_info, device_info) VALUES
    ('hakoot', 'Hakoot', 1, 1,
        'A quiz question. The fastest right answers win cards (the fastest two). Planned (run NULL) it is the question; when it is asked a copy is added to the game (run n) with a link to the plan.',
        '{correct: index of the right answer, rewards: how many riders win cards, answers: {device: {choice, ms}} (in a game), closed: bool (in a game)}',
        '{question, answers: [2-4 texts], image, read: s before answers open, answer: s to answer} (in a game also: type, quiz: planned event id, start: game ms, read/answer in ms, rewards)'),
    ('poker', 'Poker', 1, 0,
        'By Sigrid Oen. The pot starts with a random number of points between pot_min and pot_max. For `duration` seconds everyone may put a share of their score in the pot; whoever has the highest score at the end wins the pot.',
        '{pot_min, pot_max, pot: points in the pot (in a game), bets: {device: points} (in a game)}',
        '{duration: s for betting}'),
    ('toast', 'Toast', 1, 0,
        'From the original game: a countdown, then a work interval, with cards for the best riders. Not made yet.',
        '{rewards}', '{countdown: s, work: s}'),
    ('powerup', 'Power-up', 0, 1,
        'A card played by a rider (device_id). Open while the target can still answer with Nope (trigger_window), then done.',
        NULL, '{type, card, owner, target, resolveAt: game ms}'),
    ('nope', 'Nope', 0, 1, 'A rider (device_id) cancelled a card played on them.', NULL, '{type, of: seq of the card, by}'),
    ('resolve', 'Result of a card', 0, 1, 'What a card did once its Nope window had passed.', NULL,
        '{type, of: seq of the card, outcome: applied | noped | fizzled | empty, effects: [{kind, player, …}]}'),
    ('fixed', 'Tyre fixed', 0, 1, 'A rider (device_id) fixed the flat tyre from Thumbtacks.', NULL, '{type, of: seq of the card, by}'),
    ('deal', 'Cards dealt', 0, 1, 'A moderator dealt cards to everyone.', NULL, '{type, cards: {device: [card numbers]}}'),
    ('hakoot-result', 'Hakoot result', 0, 1, 'Who answered what, and who won cards.', NULL,
        '{type, of: seq of the question, correct, results: [{player, choice, ms, correct, cards}]}')
ON CONFLICT (type) DO UPDATE SET
    name = excluded.name, planned = excluded.planned, playable = excluded.playable, description = excluded.description,
    server_info = excluded.server_info, device_info = excluded.device_info;

-- Everything that is planned for, or happens in, a room.
--   Planned events (run NULL) belong to the room and are part of every game in it: Hakoot questions
--   and poker rounds made in the create menu or by a moderator.
--   Game events (run n, numbered by seq 1, 2, 3 …) happened in game n: cards played, answers,
--   a planned question when it was asked. Clients keep track of them by seq ("1-57"). They are
--   kept when the room is restarted (see partyspin_run).
CREATE TABLE IF NOT EXISTS partyspin_event (
    event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id         INTEGER     NOT NULL REFERENCES partyspin_room (room_id) ON DELETE CASCADE,
    device_id       VARCHAR(40) REFERENCES partyspin_device (device_id) ON DELETE SET NULL,  -- the rider it belongs to, if any
    type            VARCHAR(20) NOT NULL REFERENCES partyspin_event_type (type),
    run             INTEGER,                                    -- NULL: planned · n: happened in game n
    seq             INTEGER,                                    -- game events: place in the game's log
    trigger_at      INTEGER,                                    -- game ms when it starts
    trigger_window  INTEGER,                                    -- ms it stays open (reading + answering, the Nope window, betting)
    status          VARCHAR(10) NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'open', 'done', 'cancelled')),
    server_info     TEXT,                                       -- JSON only the server sees: right answers, the pot …
    device_info     TEXT,                                       -- JSON for the browsers: the question, the card …
    created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (room_id, run, seq)
);
CREATE INDEX IF NOT EXISTS partyspin_event_by_room ON partyspin_event (room_id, run, seq);
