"""
The database, shared with the PHP scripts (see database/create-partyspin-tables.sql for the tables
and who writes what): the hub's SQLite file, or a file of its own when config.php (in this folder)
says so (`partyspin_database_path`).

The server loads a room when someone enters it and keeps it in memory while it is used. The PHP
scripts change a room's name, key, settings and planned events; they set `edited_at_ms`, and the
server reloads those parts (`changed_rooms`). The server writes the game: the room's state, the
players, the game events and the games that are over (partyspin_run, partyspin_run_player).
"""
import hmac
import json
import re
import sqlite3
from pathlib import Path

from cards import CARDS, HAND_SIZE, NOPE
from game import Player, Room, merge_settings, name_key, now_ms

HERE = Path(__file__).resolve().parent
SCHEMA = HERE / 'database' / 'create-partyspin-tables.sql'
HUB_SERVER = HERE.parents[2] / 'server'      # the hub's server/ folder (config.php, databases/)
AUTH_KEYS = HERE.parent / 'api' / 'authentication_keys.php'
CONFIG = HERE / 'config.php'              # Party Spin settings (see config.example.php)


def hub_database_path():
    """The hub's database file, named in server/config.php ('database_file')."""
    config = (HUB_SERVER / 'config.php').read_text(encoding='utf-8')
    match = re.search(r"""['"]database_file['"]\s*=>\s*['"]([^'"]+)['"]""", config)
    if not match:
        raise SystemExit('server/config.php has no database_file.')
    return HUB_SERVER / 'databases' / Path(match.group(1)).name


def php_text(path):
    """A PHP settings file as text without its comments ('' when it is missing)."""
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError:
        return ''
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'(?m)^\s*(//|#).*$', '', text)


def partyspin_database_path(config=CONFIG):
    """
    The Party Spin database, as in partyspin_common.php: 'database' in config.php is null (or the
    file is missing) for the hub's database, a file name for server/databases/<name>, or a full path.
    """
    match = re.search(r"""['"]database['"]\s*=>\s*(?:null|(['"])(.*?)\1)""", php_text(config), flags=re.I)
    name = (match.group(2) or '').strip() if match else ''
    if not name:
        return hub_database_path()
    if re.match(r'^([a-zA-Z]:)?[/\\]', name):
        return Path(name)
    return HUB_SERVER / 'databases' / Path(name).name


def auth_keys(path=AUTH_KEYS):
    """
    Who may create rooms: {name: key} from api/authentication_keys.php, read again every time so
    changes count straight away. Only the simple form 'Name' => 'key', is understood; comments are
    skipped and keys shorter than 12 characters are ignored (as in the PHP scripts).
    """
    pairs = re.findall(r"""(['"])(.+?)\1\s*=>\s*(['"])(.+?)\3""", php_text(path))
    return {name: key for _, name, _, key in pairs if len(key) >= 12}


def check_auth_key(key, path=AUTH_KEYS):
    """The name an authentication key belongs to, or None."""
    if not key:
        return None
    return next((name for name, valid in auth_keys(path).items() if hmac.compare_digest(valid, str(key))), None)


def dumps(value):
    return None if value is None else json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def loads(text, default=None):
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default


# ---------------------------------------------------------------- planned events
# Browser format (seconds), as in game.py set_quiz and the PHP helpers (ps_event_row / ps_event_json):
#   hakoot {id, type, at, question, answers, correct, image, read, answer, rewards}
#   poker  {id, type, at, duration, potMin, potMax}

def plan_row(item):
    """A planned event → (type, trigger_at, trigger_window, server_info, device_info)."""
    if item['type'] == 'poker':
        return ('poker', item['at'] * 1000, item['duration'] * 1000,
                {'pot_min': item['potMin'], 'pot_max': item['potMax']}, {'duration': item['duration']})
    return ('hakoot', item['at'] * 1000, (item['read'] + item['answer']) * 1000,
            {'correct': item['correct'], 'rewards': item['rewards']},
            {'question': item['question'], 'answers': item['answers'], 'image': item['image'],
             'read': item['read'], 'answer': item['answer']})


def plan_item(row):
    server = loads(row['server_info'], {}) or {}
    device = loads(row['device_info'], {}) or {}
    item = {'id': row['event_id'], 'type': row['type'], 'at': (row['trigger_at'] or 0) // 1000}
    if row['type'] == 'poker':
        return {**item, 'duration': device.get('duration', 120),
                'potMin': server.get('pot_min', 1000), 'potMax': server.get('pot_max', 5000)}
    return {**item, 'question': device.get('question', ''), 'answers': device.get('answers', []),
            'image': device.get('image', ''), 'read': device.get('read', 5), 'answer': device.get('answer', 10),
            'correct': server.get('correct', 0), 'rewards': server.get('rewards', 3)}


def upgrade(db):
    """Columns added after the tables were first made (partyspin_common.php does the same)."""
    columns = lambda table: [row[1] for row in db.execute(f'PRAGMA table_info({table})')]
    with db:
        room = columns('partyspin_room')
        if 'owner' not in room:
            # Rooms made while authentication keys were in the database get their owner's name.
            db.execute('ALTER TABLE partyspin_room ADD COLUMN owner VARCHAR(80)')
            if 'owner_id' in room:
                db.execute('UPDATE partyspin_room SET owner = (SELECT label FROM partyspin_auth_key WHERE auth_key_id = owner_id)')
        if 'ghost' not in columns('partyspin_player'):
            db.execute('ALTER TABLE partyspin_player ADD COLUMN ghost INTEGER NOT NULL DEFAULT 0')
        # Room names used to be found with single spaces kept; now spaces don't count at all.
        db.execute("UPDATE OR IGNORE partyspin_room SET name_key = REPLACE(name_key, ' ', '') WHERE name_key LIKE '% %'")


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.execute('PRAGMA busy_timeout = 5000')     # the PHP scripts write to the same file
        self.db.executescript(SCHEMA.read_text(encoding='utf-8'))
        upgrade(self.db)

    # ---------------------------------------------------------------- rooms

    def find_room(self, name):
        """The id of the room with this name, or None."""
        row = self.db.execute('SELECT room_id FROM partyspin_room WHERE name_key = ?', (name_key(name),)).fetchone()
        return row[0] if row else None

    def room_exists(self, room_id):
        return self.db.execute('SELECT 1 FROM partyspin_room WHERE room_id = ?', (room_id,)).fetchone() is not None

    def load(self, room_id, now=None):
        """A room with its game, as it was saved. Time it was not loaded does not count as game time."""
        now = now_ms() if now is None else now
        row = self.db.execute('SELECT * FROM partyspin_room WHERE room_id = ?', (room_id,)).fetchone()
        if not row:
            return None
        room = Room(row['room_id'], row['name'], row['key_hash'], row['owner'], loads(row['settings'], {}))
        room.edited_at = row['edited_at_ms']
        room.status = row['status']
        room.run = room.saved_run = row['run']
        room.started_at = row['started_at_ms']
        room.paused_at = row['paused_at_ms']
        room.paused_total = row['paused_total_ms']
        room.ended_at = row['ended_at_ms']
        if room.status == 'running' and row['saved_at_ms']:
            room.paused_total += max(0, now - row['saved_at_ms'])

        for p in self.db.execute('SELECT * FROM partyspin_player WHERE room_id = ? ORDER BY joined_at', (room_id,)):
            player = Player(p['device_id'], p['name'])
            player.avatar = loads(p['avatar'], {}) or {}
            player.ftp, player.weight, player.difficulty = p['ftp'] or 200, p['weight'] or 75, p['difficulty']
            player.score = float(p['score'])
            player.hand = [c for c in loads(p['hand'], []) if c in CARDS and c != NOPE][:HAND_SIZE]
            player.nope = bool(p['nope'])
            player.ghost = bool(p['ghost'])
            room.players[player.id] = player

        self._load_plan(room)
        for e in self.db.execute('SELECT * FROM partyspin_event WHERE room_id = ? AND run = ? ORDER BY seq',
                                 (room_id, room.run)):
            event = loads(e['device_info'], {})
            if event.get('id') != len(room.events) + 1:     # the log must be 1, 2, 3 … without gaps
                break
            room.events.append(event)
            if e['type'] == 'powerup' and e['status'] == 'open':
                room.pending.append(event['id'])
            if e['type'] == 'hakoot':
                room.hakoots[event['id']] = loads(e['server_info'], {}) or {'correct': 0, 'answers': {}, 'closed': True}
        room._reset_outbox()
        return room

    def _load_plan(self, room):
        rows = self.db.execute('SELECT * FROM partyspin_event WHERE room_id = ? AND run IS NULL ORDER BY trigger_at, event_id',
                               (room.id,)).fetchall()
        room.quiz = [plan_item(row) for row in rows]
        room.emitted = {row['event_id'] for row in rows if row['status'] in ('open', 'done')} | (room.emitted & {r['event_id'] for r in rows})
        room.plan_done = {row['event_id'] for row in rows if row['status'] == 'done'} | (room.plan_done & {r['event_id'] for r in rows})

    def edited(self, room_ids):
        """{room id: edited_at_ms} of these rooms; deleted rooms are missing."""
        if not room_ids:
            return {}
        marks = ','.join('?' * len(room_ids))
        return dict(self.db.execute(f'SELECT room_id, edited_at_ms FROM partyspin_room WHERE room_id IN ({marks})',
                                    list(room_ids)).fetchall())

    def reload(self, room):
        """Pick up what the PHP scripts (or another moderator) changed: name, key, settings, planned events."""
        row = self.db.execute('SELECT * FROM partyspin_room WHERE room_id = ?', (room.id,)).fetchone()
        if not row:
            return False
        room.key_hash = row['key_hash']
        room.owner = row['owner']
        room.settings = merge_settings(room.settings, {**(loads(row['settings'], {}) or {}), 'name': row['name']})
        room.edited_at = row['edited_at_ms']
        self._load_plan(room)
        room.room_changed = True
        return True

    def save(self, room, now=None):
        """Write the game. Returns False when the room has been deleted meanwhile."""
        now = now_ms() if now is None else now
        with self.db:
            updated = self.db.execute(
                '''UPDATE partyspin_room SET status = ?, run = ?, started_at_ms = ?, paused_at_ms = ?, paused_total_ms = ?,
                   ended_at_ms = ?, saved_at_ms = ? WHERE room_id = ?''',
                (room.status, room.run, room.started_at, room.paused_at, room.paused_total, room.ended_at, now, room.id)).rowcount
            if not updated:
                return False
            if room.archive:                    # a game ended or was restarted: keep how it went
                self._archive(room.id, room.archive)
                room.archive = None
            if room.saved_run != room.run:      # a restart: the old game's events stay under their run
                room.saved_run = room.run
                room.log_changed = {event['id'] for event in room.events}

            for pid in room.removed:
                self.db.execute('DELETE FROM partyspin_player WHERE room_id = ? AND device_id = ?', (room.id, pid))
            room.removed = set()
            for player in room.players.values():
                self.db.execute('INSERT OR IGNORE INTO partyspin_device (device_id) VALUES (?)', (player.id,))
                self.db.execute(
                    '''INSERT INTO partyspin_player (room_id, device_id, name, avatar, ftp, weight, difficulty, score, hand, nope, ghost)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (room_id, device_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar,
                       ftp = excluded.ftp, weight = excluded.weight, difficulty = excluded.difficulty,
                       score = excluded.score, hand = excluded.hand, nope = excluded.nope, ghost = excluded.ghost''',
                    (room.id, player.id, player.name, dumps(player.avatar), player.ftp, player.weight, player.difficulty,
                     player.score, dumps(player.hand), int(player.nope), int(player.ghost)))

            for seq in sorted(room.log_changed):
                event = room.event(seq)
                if event:
                    self.db.execute(
                        '''INSERT INTO partyspin_event (room_id, device_id, type, run, seq, trigger_at, trigger_window, status, server_info, device_info)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT (room_id, run, seq) DO UPDATE SET status = excluded.status,
                           server_info = excluded.server_info, device_info = excluded.device_info''',
                        (room.id, *self._log_row(room, event)))
            room.log_changed = set()

            if room.plan_changed:
                for item in room.quiz:
                    if isinstance(item['id'], int):
                        self.db.execute('UPDATE partyspin_event SET status = ? WHERE event_id = ? AND room_id = ? AND run IS NULL',
                                        (room.plan_status(item['id']), item['id'], room.id))
                room.plan_changed = False
        room.dirty = False
        return True

    def _archive(self, room_id, game):
        """Write a finished (or restarted) game: partyspin_run and its riders."""
        self.db.execute(
            '''INSERT INTO partyspin_run (room_id, run, status, settings, started_at_ms, ended_at_ms, duration_ms, events)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (room_id, run) DO UPDATE SET status = excluded.status, settings = excluded.settings,
               started_at_ms = excluded.started_at_ms, ended_at_ms = excluded.ended_at_ms,
               duration_ms = excluded.duration_ms, events = excluded.events''',
            (room_id, game['run'], game['status'], dumps(game['settings']), game['started_at'], game['ended_at'],
             game['duration'], game['events']))
        self.db.execute('DELETE FROM partyspin_run_player WHERE room_id = ? AND run = ?', (room_id, game['run']))
        for p in game['players']:
            self.db.execute(
                '''INSERT INTO partyspin_run_player (room_id, run, device_id, name, place, score, ftp, weight, difficulty)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (room_id, game['run'], p['id'], p['name'], p['place'], p['score'], p['ftp'], p['weight'], p['difficulty']))

    def runs(self, room_id):
        """The games played in a room, newest first, with their riders (for a history view later)."""
        runs = [dict(row) for row in self.db.execute('SELECT * FROM partyspin_run WHERE room_id = ? ORDER BY run DESC', (room_id,))]
        for run in runs:
            run['settings'] = loads(run['settings'], {})
            run['players'] = [dict(row) for row in self.db.execute(
                'SELECT * FROM partyspin_run_player WHERE room_id = ? AND run = ? ORDER BY place', (room_id, run['run']))]
        return runs

    def _log_row(self, room, event):
        """A game event → (device_id, type, run, seq, trigger_at, trigger_window, status, server_info, device_info)."""
        kind = event['type']
        device = event.get('owner') or event.get('by')
        if device and device not in room.players:
            self.db.execute('INSERT OR IGNORE INTO partyspin_device (device_id) VALUES (?)', (device,))
        trigger, window, status, server = event.get('t'), None, 'done', None
        if kind == 'powerup':
            window = event['resolveAt'] - event['t']
            status = 'open' if event['id'] in room.pending else 'done'
        elif kind == 'hakoot':
            trigger, window = event['start'], event['read'] + event['answer']
            server = room.hakoots.get(event['id'])
            status = 'done' if server and server.get('closed') else 'open'
        elif kind == 'resolve' and event.get('outcome') == 'noped':
            status = 'cancelled'
        return (device, kind, room.run, event['id'], trigger, window, status, dumps(server), dumps(event))

    def save_settings(self, room):
        """A moderator changed the settings (the name stays: only the owner changes it, in the create menu)."""
        settings = {k: v for k, v in room.settings.items() if k != 'name'}
        room.edited_at = now_ms()
        with self.db:
            self.db.execute('UPDATE partyspin_room SET settings = ?, edited_at_ms = ? WHERE room_id = ?',
                            (dumps(settings), room.edited_at, room.id))

    def save_plan(self, room):
        """A moderator changed the planned events: make the database match room.quiz (new ones get their ids)."""
        existing = {row[0] for row in self.db.execute(
            'SELECT event_id FROM partyspin_event WHERE room_id = ? AND run IS NULL', (room.id,))}
        kept = set()
        with self.db:
            for item in room.quiz:
                kind, trigger, window, server, device = plan_row(item)
                if item['id'] in existing:
                    self.db.execute(
                        '''UPDATE partyspin_event SET type = ?, trigger_at = ?, trigger_window = ?, server_info = ?, device_info = ?
                           WHERE event_id = ?''', (kind, trigger, window, dumps(server), dumps(device), item['id']))
                else:
                    item['id'] = self.db.execute(
                        '''INSERT INTO partyspin_event (room_id, type, trigger_at, trigger_window, status, server_info, device_info)
                           VALUES (?, ?, ?, ?, 'planned', ?, ?)''',
                        (room.id, kind, trigger, window, dumps(server), dumps(device))).lastrowid
                kept.add(item['id'])
            for event_id in existing - kept:
                self.db.execute('DELETE FROM partyspin_event WHERE event_id = ?', (event_id,))
            room.edited_at = now_ms()
            self.db.execute('UPDATE partyspin_room SET edited_at_ms = ? WHERE room_id = ?', (room.edited_at, room.id))
        room.plan_changed = True

    def close(self):
        self.db.close()
