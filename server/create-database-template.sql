-- Frode's Bike Trainer – SQLite database template.
-- database_link.php runs this automatically when the database file does not exist yet.
-- Every statement must be safe to run again (IF NOT EXISTS).

PRAGMA foreign_keys = ON;

-- User
-- user_id is the public identifier (safe to show and to reference from other tables).
-- user_key is the secret login token that is sent in login links and stored in the cookie.
-- Keeping them apart means a public session or friend list never leaks anyone's login.
CREATE TABLE IF NOT EXISTS user (
    user_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key            VARCHAR(32)  NOT NULL UNIQUE,
    is_public           INTEGER      NOT NULL DEFAULT 0,          -- 0 = private (default), 1 = public
    username            VARCHAR(60)  NOT NULL UNIQUE COLLATE NOCASE, -- what other people search for
    nickname            VARCHAR(60),                              -- does not have to be unique
    email               VARCHAR(254) NOT NULL UNIQUE COLLATE NOCASE,
    icon                VARCHAR(60),                              -- background colour of the profile picture (name from core/ui.js AVATAR_COLORS)
    icon_image          VARCHAR(120),                             -- uploaded picture "assets/user_uploaded_profile_icons/<username>.png?v=<time>", null = default
    birthday            DATE,                                     -- can be null
    weight              DECIMAL(5,2),                             -- kg, can be null (applications use their own default)
    ftp                 DECIMAL(5,2),                             -- W, can be null
    gender              INTEGER,                                  -- null/0 = not specified, 1 = female, 2 = male, 3 = other
    difficulty          INTEGER,                                  -- 1 relaxed … 5 extreme, can be null
    home_layout         TEXT,                                     -- JSON array of application ids on the home screen
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_link_at  DATETIME                                  -- throttles login e-mails
);

-- User stats (one row per user, recalculated by update_user_stats.php)
CREATE TABLE IF NOT EXISTS user_stats (
    user_id             INTEGER PRIMARY KEY REFERENCES user(user_id) ON DELETE CASCADE,
    longest_ride        REAL    NOT NULL DEFAULT 0,               -- m
    total_distance      REAL    NOT NULL DEFAULT 0,               -- m
    total_time          INTEGER NOT NULL DEFAULT 0,               -- s
    session_count       INTEGER NOT NULL DEFAULT 0,
    level               REAL    NOT NULL DEFAULT 0,               -- best 10 sessions of the last 6 months, with fall-off
    level_updated_at    DATETIME,
    coins               INTEGER NOT NULL DEFAULT 0                -- the in-game currency
);

-- Bike (the 3D bikes that can be owned, see assets/3D/bikes)
CREATE TABLE IF NOT EXISTS bike (
    bike_key            VARCHAR(20) PRIMARY KEY,
    name                VARCHAR(60),
    mesh                VARCHAR(20),
    texture             VARCHAR(20),
    material            VARCHAR(20),
    price               INTEGER NOT NULL DEFAULT 0                -- coins
);

-- Bikes a user owns
CREATE TABLE IF NOT EXISTS user_bike (
    user_id             INTEGER     NOT NULL REFERENCES user(user_id) ON DELETE CASCADE,
    bike_key            VARCHAR(20) NOT NULL REFERENCES bike(bike_key),
    texture_overwrite   VARCHAR(60),
    is_selected         INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, bike_key)
);

-- Session
-- session_key is random rather than user + date, so a session can be shared by link without being guessable.
CREATE TABLE IF NOT EXISTS session (
    session_key         VARCHAR(16) PRIMARY KEY,
    user_id             INTEGER     NOT NULL REFERENCES user(user_id) ON DELETE CASCADE,
    application_id      VARCHAR(60),                              -- id from core/catalog.json
    is_public           INTEGER     NOT NULL DEFAULT 0,
    started_at          DATETIME    NOT NULL,                     -- ISO 8601, UTC
    duration            INTEGER     NOT NULL DEFAULT 0,           -- s (active time)
    distance            REAL        NOT NULL DEFAULT 0,           -- m
    avg_power           REAL,
    max_power           REAL,
    avg_hr              REAL,
    avg_speed           REAL,                                     -- km/h
    avg_cadence         REAL,
    energy              REAL,                                     -- kJ
    session_data        BLOB,                                     -- .ride binary (cycling-power-ble RIDE format)
    notes               TEXT,                                     -- JSON: title, description, (images, ...)
    created_at          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS session_user_started ON session(user_id, started_at);
CREATE INDEX IF NOT EXISTS session_public_started ON session(is_public, started_at);

-- Friends (one-way "follow"; two rows when both follow each other)
CREATE TABLE IF NOT EXISTS user_friend (
    user_id             INTEGER NOT NULL REFERENCES user(user_id) ON DELETE CASCADE,
    friend_id           INTEGER NOT NULL REFERENCES user(user_id) ON DELETE CASCADE,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, friend_id)
);
