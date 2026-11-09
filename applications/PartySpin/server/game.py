"""
The rules of a Party Spin room, without any networking (so they are easy to test).

Everything that happens in a room is an *event* in an append-only log: a card played, a Nope, the
result of a card, a Hakoot question and its result, cards dealt. Every event gets the next id
(1, 2, 3 …), so a client can tell what it is missing from a short id list such as "1-57" (see
`id_ranges`). Restarting a room starts a new *run* with a fresh log.

Times inside the game are *game time*: milliseconds since the start, not counting pauses (and not
counting time the server was down). Effects such as "×1.2 for 90 s" are stored with game times, so
they freeze while the game is paused.

A room method changes the room and records what has to be sent; the server drains these after
every message (`new_events`, `hands_changed`, `room_changed`, `important`). What has to be saved is
recorded too (`log_changed`, `plan_changed`, `removed`, `archive`); store.py writes it to the database.

Two settings are switched during a game by moderators: `powerups` (cards can be played) and `break`
(nobody scores from riding; cards still work and the clock goes on). Pausing stops the clock and
is not needed in a normal game.

Planned events (Hakoot questions and poker rounds, made in the create menu or by a moderator) are in
`quiz`, with their database ids. When a planned question is asked, a copy goes into the log.
"""
import hashlib
import random
import secrets as tokens
import time

from cards import CARDS, HAND_SIZE, NOPE, NOPE_WINDOW, PLAYABLE

QUIZ_LEAD = 15_000      # Hakoot questions are sent this long before they are shown
ANSWER_GRACE = 1_500    # late answers (network delay) are still accepted for this long
MAX_POINTS_PER_REPORT = 5_000
MAX_NAME = 40

DEFAULT_SETTINGS = {
    'name': 'Party Spin',                   # the room's name (a column of its own in the database)
    'mode': 'ftp',                          # how watts become points: 'ftp' | 'power' | 'wkg'
    'end': {'type': 'time', 'value': 30},   # 'time' (minutes) | 'points' | 'manual'
    'powerups': True,                       # cards can be played
    'break': False,                         # a break: riding gives no points
    'display': {'background': 'brick', 'color': '#2b1d33', 'video': ''},
}

STATUSES = ('lobby', 'running', 'paused', 'ended')


def now_ms():
    return int(time.time() * 1000)


def name_key(name):
    """Room names are looked up without caring about upper case or spaces (as ps_name_key in PHP)."""
    return ''.join(str(name or '').split()).lower()


def hash_room_key(key):
    salt = tokens.token_hex(8)
    return f'{salt}${_room_key_digest(key, salt)}'


def check_room_key(key, stored):
    if not key or not stored or '$' not in stored:
        return False
    salt, digest = stored.split('$', 1)
    return tokens.compare_digest(_room_key_digest(key, salt), digest)


def _room_key_digest(key, salt):
    return hashlib.pbkdf2_hmac('sha256', str(key).encode(), salt.encode(), 50_000).hex()


def id_ranges(ids):
    """[1, 2, 3, 5, 7, 8] → '1-3,5,7-8'."""
    parts = []
    start = previous = None
    for value in sorted(ids):
        if start is None:
            start = previous = value
        elif value == previous + 1:
            previous = value
        else:
            parts.append(f'{start}-{previous}' if previous > start else str(start))
            start = previous = value
    if start is not None:
        parts.append(f'{start}-{previous}' if previous > start else str(start))
    return ','.join(parts)


def parse_ranges(text):
    """'1-3,5' → {1, 2, 3, 5}. Rubbish parts are ignored."""
    ids = set()
    for part in str(text or '').split(','):
        try:
            if '-' in part:
                low, high = (int(x) for x in part.split('-', 1))
                if 0 < low <= high and high - low < 100_000:
                    ids.update(range(low, high + 1))
            elif part.strip():
                ids.add(int(part))
        except ValueError:
            continue
    return ids


class GameError(Exception):
    """A request that is not allowed right now. The message is shown to the user."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class Player:
    def __init__(self, pid, name='Rider'):
        self.id = pid
        self.name = name
        self.avatar = {}
        self.ftp = 200
        self.weight = 75
        self.difficulty = None
        self.score = 0.0
        self.hand = []          # up to HAND_SIZE cards (numbers from CARDS)
        self.nope = False       # the separate Nope slot
        self.ghost = False      # ghost mode: the browsers don't show this rider's numbers
        self.live = {}          # last reported power, cadence, hr, speed, eff (power used for points), mult
        self.online = False

    def public(self):
        """
        What everyone in the room gets every second. A ghost's numbers are sent too (for the animations
        to come); the browsers don't show them.
        """
        live = self.live
        return {
            'id': self.id, 'name': self.name, 'avatar': self.avatar, 'score': round(self.score),
            'power': live.get('power'), 'cadence': live.get('cadence'), 'hr': live.get('hr'), 'speed': live.get('speed'),
            'eff': live.get('eff'), 'mult': live.get('mult', 1), 'online': self.online, 'ghost': self.ghost,
            'cards': len(self.hand) + (1 if self.nope else 0),
        }


class Room:
    def __init__(self, room_id, name='Party Spin', key_hash=None, owner=None, settings=None):
        self.id = room_id           # partyspin_room.room_id
        self.key_hash = key_hash    # the room key: whoever knows it becomes a moderator
        self.owner = owner          # id of the authentication key that created the room
        self.settings = merge_settings(DEFAULT_SETTINGS, {**(settings or {}), 'name': name})
        self.edited_at = 0          # partyspin_room.edited_at_ms of what is loaded
        self.quiz = []              # planned events: Hakoot (with the right answers) and poker
        self.status = 'lobby'
        self.started_at = None      # server time (ms)
        self.paused_at = None
        self.paused_total = 0
        self.ended_at = None
        self.run = 1
        self.players = {}
        self.events = []
        self.pending = []           # ids of played cards waiting for their Nope window
        self.hakoots = {}           # event id → {'correct', 'answers': {pid: {'choice', 'ms'}}, 'closed'}
        self.emitted = set()        # planned events already asked in this run
        self.plan_done = set()      # … and finished
        self.saved_run = 1          # the run the database has game events of
        self.archive = None         # a finished game to write to partyspin_run (see snapshot)
        self.activity = now_ms()
        self._reset_outbox()

    # ---------------------------------------------------------------- bookkeeping

    def _reset_outbox(self):
        self.new_events = []
        self.hands_changed = set()
        self.room_changed = False
        self.important = False      # save to the database right away
        self.dirty = False          # save soon (scores)
        self.log_changed = set()    # log ids (seq) to write
        self.plan_changed = False   # statuses of planned events to write
        self.removed = set()        # players to delete

    def drain(self):
        out = (self.new_events, self.hands_changed, self.room_changed, self.important)
        self.new_events, self.hands_changed, self.room_changed, self.important = [], set(), False, False
        return out

    @property
    def name(self):
        return self.settings['name']

    def clock(self, now=None):
        """Game time in ms."""
        now = now_ms() if now is None else now
        if self.started_at is None:
            return 0
        end = {'running': now, 'paused': self.paused_at, 'ended': self.ended_at}.get(self.status, now)
        return max(0, int(end - self.started_at - self.paused_total))

    def ids(self):
        return f'1-{len(self.events)}' if len(self.events) > 1 else ('1' if self.events else '')

    def event(self, event_id):
        if isinstance(event_id, int) and 0 < event_id <= len(self.events):
            return self.events[event_id - 1]
        return None

    def _append(self, event, now):
        event = {'id': len(self.events) + 1, 't': self.clock(now), **event}
        self.events.append(event)
        self.new_events.append(event)
        self.log_changed.add(event['id'])
        self.important = True
        return event

    def ranking(self):
        return sorted(self.players.values(), key=lambda p: (-p.score, p.name.lower(), p.id))

    def _neighbour(self, pid, step):
        order = [p.id for p in self.ranking()]
        index = order.index(pid) + step
        return order[index] if 0 <= index < len(order) else None

    def _player(self, pid):
        player = self.players.get(pid)
        if not player:
            raise GameError('You are not in this room.')
        return player

    # ---------------------------------------------------------------- messages for clients

    def info(self, admin=False, now=None):
        info = {
            'id': self.id, 'settings': self.settings, 'status': self.status, 'clock': self.clock(now),
            'run': self.run, 'ids': self.ids(),
        }
        if admin:
            info['quiz'] = self.quiz
        return info

    def state(self, now=None):
        return {
            'status': self.status, 'clock': self.clock(now),
            'players': [player.public() for player in self.ranking()],
        }

    def hand(self, pid):
        player = self.players.get(pid)
        return {'hand': player.hand, 'nope': player.nope} if player else {'hand': [], 'nope': False}

    # ---------------------------------------------------------------- players

    def join(self, pid, info):
        """A rider enters the room, or changes their profile (name, FTP, weight, difficulty, ghost mode)."""
        player = self.players.get(pid)
        if not player:
            player = self.players[pid] = Player(pid)
        self.important = True
        player.name = str(info.get('name') or 'Rider')[:40]
        avatar = info.get('avatar') or {}
        player.avatar = {k: str(v)[:300] for k, v in avatar.items() if k in ('icon', 'image') and v} if isinstance(avatar, dict) else {}
        player.ftp = clamp_number(info.get('ftp'), 30, 999, 200)
        player.weight = clamp_number(info.get('weight'), 20, 300, 75)
        player.difficulty = clamp_number(info.get('difficulty'), 1, 5, None)
        player.ghost = bool(info.get('ghost'))
        self.hands_changed.add(pid)
        self.activity = now_ms()
        return player

    def stats(self, pid, data, now):
        """A rider's live numbers, sent about once per second. The client is trusted with its points."""
        player = self._player(pid)
        player.live = {
            'power': clamp_number(data.get('power'), 0, 3000, None),
            'cadence': clamp_number(data.get('cadence'), 0, 250, None),
            'hr': clamp_number(data.get('hr'), 0, 250, None),
            'speed': clamp_number(data.get('speed'), 0, 150, None),
            'eff': clamp_number(data.get('eff'), 0, 3000, None),
            'mult': clamp_number(data.get('mult'), 0, 10, 1),
        }
        if self.status == 'running' and not self.settings['break']:
            points = clamp_number(data.get('points'), 0, MAX_POINTS_PER_REPORT, 0)
            if points:
                player.score += points
                self.dirty = True
        self.activity = now

    # ---------------------------------------------------------------- cards

    def draw(self, player):
        """Give a random card. Returns it, or None when there is no room for it."""
        pool = list(PLAYABLE) if len(player.hand) < HAND_SIZE else []
        if not player.nope:
            pool.append(NOPE)
        if not pool:
            return None
        card = random.choice(pool)
        if card == NOPE:
            player.nope = True
        else:
            player.hand.append(card)
        self.hands_changed.add(player.id)
        return card

    def play(self, pid, slot, target, now, card=None):
        if self.status != 'running':
            raise GameError('Cards can only be played while the game is running.')
        if not self.settings['powerups']:
            raise GameError('Power-ups are switched off.')
        player = self._player(pid)
        if not isinstance(slot, int) or not 0 <= slot < len(player.hand) or card not in (None, player.hand[slot]):
            raise GameError('That card is not in your hand any more.')
        card = player.hand[slot]
        kind = CARDS[card]['target']
        if kind == 'self':
            target = pid
        elif kind == 'choose':
            if target == pid or target not in self.players:
                raise GameError('Pick another rider for this card.')
        elif kind == 'behind':
            target = self._neighbour(pid, 1)
            if not target:
                raise GameError('Nobody is behind you.')
        elif kind == 'ahead':
            target = self._neighbour(pid, -1)
            if not target:
                raise GameError('You are already in the lead.')
        else:
            raise GameError('This card cannot be played.')

        player.hand.pop(slot)
        self.hands_changed.add(pid)
        clock = self.clock(now)
        event = self._append({
            'type': 'powerup', 'owner': pid, 'card': card, 'target': target,
            'resolveAt': clock + (NOPE_WINDOW if target != pid else 0),
        }, now)
        self.pending.append(event['id'])
        if target == pid:
            self._resolve(event, now)
        return event

    def discard(self, pid, slot):
        player = self._player(pid)
        if isinstance(slot, int) and 0 <= slot < len(player.hand):
            player.hand.pop(slot)
            self.hands_changed.add(pid)
            self.important = True

    def nope(self, pid, of, now):
        event = self.event(of)
        player = self._player(pid)
        if not event or event['type'] != 'powerup' or event['target'] != pid:
            raise GameError('That card was not played on you.')
        if of not in self.pending:
            raise GameError('Too late – that card has already happened.')
        if not player.nope:
            raise GameError('You have no Nope card.')
        player.nope = False
        self.hands_changed.add(pid)
        self.pending.remove(of)
        self._append({'type': 'nope', 'of': of, 'by': pid}, now)
        self._append({'type': 'resolve', 'of': of, 'outcome': 'noped', 'effects': []}, now)

    def fixed(self, pid, of, now):
        """The rider fixed the flat tyre from Thumbtacks card `of`."""
        result = next((e for e in self.events if e['type'] == 'resolve' and e['of'] == of), None)
        flat = result and next((x for x in result['effects'] if x['kind'] == 'flat' and x['player'] == pid), None)
        if not flat:
            raise GameError('You have no flat tyre to fix.')
        if any(e['type'] == 'fixed' and e['of'] == of for e in self.events):
            return
        self._append({'type': 'fixed', 'of': of, 'by': pid}, now)

    def _resolve(self, event, now):
        """The effect of a played card, once its Nope window has passed."""
        if event['id'] in self.pending:
            self.pending.remove(event['id'])
        self.log_changed.add(event['id'])
        card = event['card']
        rules = CARDS[card]
        owner = self.players.get(event['owner'])
        target = self.players.get(event['target'])
        clock = self.clock(now)
        effects = []
        outcome = 'applied'

        def points(player, delta):
            if player.score + delta < 0:
                delta = -player.score
            player.score += delta
            effects.append({'kind': 'points', 'player': player.id, 'delta': round(delta)})

        if not owner or not target:
            outcome = 'fizzled'
        elif card in (2, 3):                                        # Boost, Sabotage
            points(target, rules['points'])
        elif card == 4:                                             # EPO
            effects.append({'kind': 'multiplier', 'player': target.id, 'value': rules['multiplier'],
                            'from': clock, 'until': clock + rules['duration']})
        elif card == 5:                                             # Copycat
            effects.append({'kind': 'copy', 'player': owner.id, 'source': target.id,
                            'from': clock, 'until': clock + rules['duration']})
        elif card == 6:                                             # Steal
            choices = []
            if len(owner.hand) < HAND_SIZE:
                choices += [('hand', i) for i in range(len(target.hand))]
            if target.nope and not owner.nope:
                choices.append(('nope', None))
            if not choices:
                outcome = 'empty'
            else:
                where, index = random.choice(choices)
                if where == 'nope':
                    target.nope, owner.nope, stolen = False, True, NOPE
                else:
                    stolen = target.hand.pop(index)
                    owner.hand.append(stolen)
                self.hands_changed.update({owner.id, target.id})
                effects.append({'kind': 'card', 'from': target.id, 'to': owner.id, 'card': stolen})
        elif card == 7:                                             # Thumbtacks
            effects.append({'kind': 'flat', 'player': target.id, 'from': clock, 'until': clock + rules['duration']})
        elif card == 8:                                             # Pray
            points(owner, -random.randint(*rules['sacrifice']))
            effects.append({'kind': 'multiplier', 'player': target.id, 'value': 0,
                            'from': clock, 'until': clock + random.randint(*rules['duration'])})
        elif card == 9:                                             # Grapple
            if owner.score < target.score:
                middle = (owner.score + target.score) / 2
                points(owner, middle - owner.score)
                points(target, middle - target.score)
            else:
                outcome = 'fizzled'
        self._append({'type': 'resolve', 'of': event['id'], 'outcome': outcome, 'effects': effects}, now)

    def deal(self, count, now):
        count = clamp_number(count, 1, 5, 1)
        dealt = {}
        for player in self.players.values():
            cards = [card for card in (self.draw(player) for _ in range(count)) if card]
            if cards:
                dealt[player.id] = cards
        self._append({'type': 'deal', 'cards': dealt}, now)

    # ---------------------------------------------------------------- Hakoot

    def set_quiz(self, items):
        quiz = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            # Saved events have their database id; new ones a temporary text id until they are saved.
            event_id = item['id'] if isinstance(item.get('id'), int) else str(item.get('id') or tokens.token_hex(4))[:20]
            if item.get('type') == 'poker':
                pot_min = clamp_number(item.get('potMin'), 0, 1_000_000, 1000)
                quiz.append({
                    'id': event_id,
                    'type': 'poker',
                    'at': clamp_number(item.get('at'), 0, 24 * 3600, 60),
                    'duration': clamp_number(item.get('duration'), 10, 600, 120),
                    'potMin': pot_min,
                    'potMax': max(pot_min, clamp_number(item.get('potMax'), 0, 1_000_000, 5000)),
                })
                continue
            answers = [str(a)[:120] for a in item.get('answers', []) if str(a).strip()][:4]
            if not str(item.get('question', '')).strip() or len(answers) < 2:
                continue
            quiz.append({
                'id': event_id,
                'type': 'hakoot',
                'at': clamp_number(item.get('at'), 0, 24 * 3600, 60),
                'question': str(item['question'])[:300],
                'answers': answers,
                'correct': clamp_number(item.get('correct'), 0, len(answers) - 1, 0),
                'image': str(item.get('image') or '')[:500],
                'read': clamp_number(item.get('read'), 0, 60, 5),
                'answer': clamp_number(item.get('answer'), 3, 120, 10),
                'rewards': clamp_number(item.get('rewards'), 0, 50, 3),
            })
        self.quiz = sorted(quiz, key=lambda q: q['at'])
        ids = {q['id'] for q in self.quiz}
        self.emitted &= ids
        self.plan_done &= ids
        self.room_changed = True

    def launch(self, quiz_id, now):
        """Show a prepared question a few seconds from now."""
        question = next((q for q in self.quiz if q['id'] == quiz_id and q.get('type') != 'poker'), None)
        if not question:
            raise GameError('That question no longer exists.')
        if self.status != 'running':
            raise GameError('Start the game first.')
        self._emit_question(question, self.clock(now) + 8_000, now)

    def _emit_question(self, question, start, now):
        self.emitted.add(question['id'])
        self.plan_changed = True
        event = self._append({
            'type': 'hakoot', 'quiz': question['id'], 'start': start, 'question': question['question'],
            'answers': question['answers'], 'image': question['image'], 'read': question['read'] * 1000,
            'answer': question['answer'] * 1000, 'rewards': question['rewards'],
        }, now)
        self.hakoots[event['id']] = {'correct': question['correct'], 'answers': {}, 'closed': False}

    def answer(self, pid, of, choice, now):
        event = self.event(of)
        secret = self.hakoots.get(of)
        self._player(pid)
        if not event or event['type'] != 'hakoot' or not secret or secret['closed']:
            raise GameError('That question is closed.')
        opens = event['start'] + event['read']
        clock = self.clock(now)
        if not opens <= clock <= opens + event['answer'] + ANSWER_GRACE:
            raise GameError('Answers are not open right now.')
        if pid in secret['answers']:
            raise GameError('You have already answered.')
        if not isinstance(choice, int) or not 0 <= choice < len(event['answers']):
            raise GameError('Pick one of the answers.')
        secret['answers'][pid] = {'choice': choice, 'ms': max(0, clock - opens)}
        self.log_changed.add(of)
        self.important = True

    def _close_question(self, event_id, now):
        event = self.events[event_id - 1]
        secret = self.hakoots[event_id]
        secret['closed'] = True
        self.log_changed.add(event_id)
        if event.get('quiz') is not None:
            self.plan_done.add(event['quiz'])
            self.plan_changed = True
        answers = sorted(secret['answers'].items(), key=lambda item: item[1]['ms'])
        results = []
        winners = 0
        for pid, answer in answers:
            correct = answer['choice'] == secret['correct']
            cards = []
            player = self.players.get(pid)
            if correct and player and winners < event['rewards']:
                # The fastest correct answer wins two cards, the next ones one each.
                cards = [card for card in (self.draw(player) for _ in range(2 if winners == 0 else 1)) if card]
                winners += 1
            results.append({'player': pid, 'choice': answer['choice'], 'ms': answer['ms'], 'correct': correct, 'cards': cards})
        self._append({'type': 'hakoot-result', 'of': event_id, 'correct': secret['correct'], 'results': results}, now)

    # ---------------------------------------------------------------- time passes

    def tick(self, now):
        """Called a few times per second: resolves cards, sends and closes questions, ends the game."""
        clock = self.clock(now)
        for event_id in list(self.pending):
            event = self.events[event_id - 1]
            if clock >= event['resolveAt']:
                self._resolve(event, now)
        if self.status == 'running':
            for question in self.quiz:
                if question.get('type') == 'poker':     # the rules of poker are still to be decided
                    continue
                if question['id'] not in self.emitted and clock >= question['at'] * 1000 - QUIZ_LEAD:
                    self._emit_question(question, max(question['at'] * 1000, clock + 5_000), now)
        for event_id, secret in self.hakoots.items():
            event = self.events[event_id - 1]
            if not secret['closed'] and clock >= event['start'] + event['read'] + event['answer'] + ANSWER_GRACE:
                self._close_question(event_id, now)
        if self.status == 'running':
            end = self.settings['end']
            if end['type'] == 'time' and clock >= end['value'] * 60_000:
                self.end(now, at_clock=end['value'] * 60_000)
            elif end['type'] == 'points' and any(p.score >= end['value'] for p in self.players.values()):
                self.end(now)

    # ---------------------------------------------------------------- the host

    def start(self, now):
        if self.status == 'ended':
            raise GameError('Restart the room to play again.')
        if self.status == 'lobby':
            self.status = 'running'
            self.started_at = now
            self.paused_total = 0
        elif self.status == 'paused':
            self.resume(now)
            return
        self.room_changed = self.important = True

    def pause(self, now):
        if self.status == 'running':
            self.status = 'paused'
            self.paused_at = now
            self.room_changed = self.important = True

    def resume(self, now):
        if self.status == 'paused':
            self.paused_total += now - self.paused_at
            self.paused_at = None
            self.status = 'running'
            self.room_changed = self.important = True

    def end(self, now, at_clock=None):
        if self.status not in ('running', 'paused'):
            return
        if self.status == 'paused':
            now = self.paused_at
        self.ended_at = now if at_clock is None else self.started_at + self.paused_total + at_clock
        self.status = 'ended'
        self.paused_at = None
        self.archive = self.snapshot()
        self.room_changed = self.important = True

    def snapshot(self):
        """This game as it is now, for partyspin_run: settings, time and how everyone did."""
        return {
            'run': self.run, 'status': self.status, 'settings': {k: v for k, v in self.settings.items() if k != 'name'},
            'started_at': self.started_at, 'ended_at': self.ended_at, 'duration': self.clock(), 'events': len(self.events),
            'players': [{'id': p.id, 'name': p.name, 'place': place, 'score': p.score, 'ftp': p.ftp, 'weight': p.weight,
                         'difficulty': p.difficulty} for place, p in enumerate(self.ranking(), 1)],
        }

    def restart(self):
        """
        A new game in the same room: scores, cards and the event log start over. The game that was
        played is kept (archive → partyspin_run; its events stay in the database under its run).
        Riders who aren't connected are taken out of the room, so the new game starts with those here.
        """
        if self.started_at is not None:
            self.archive = self.snapshot()      # with everyone who rode, also those who left
        for pid in [p.id for p in self.players.values() if not p.online]:
            self.remove_player(pid)
        self.status = 'lobby'
        self.started_at = self.paused_at = self.ended_at = None
        self.paused_total = 0
        self.run += 1
        self.events = []
        self.pending = []
        self.hakoots = {}
        self.emitted = set()
        self.plan_done = set()
        self.plan_changed = True
        self.log_changed = set()
        for player in self.players.values():
            player.score = 0.0
            player.hand = []
            player.nope = False
            self.hands_changed.add(player.id)
        self.room_changed = self.important = True

    def update_settings(self, changes):
        self.settings = merge_settings(self.settings, changes if isinstance(changes, dict) else {})
        self.room_changed = self.important = True

    def remove_player(self, pid):
        if self.players.pop(pid, None):
            self.removed.add(pid)
            self.important = True

    def plan_status(self, event_id):
        """The status of a planned event in this run, as stored in partyspin_event.status."""
        if event_id in self.plan_done:
            return 'done'
        return 'open' if event_id in self.emitted else 'planned'


def merge_settings(base, changes):
    settings = {**base, **{k: v for k, v in changes.items() if k in DEFAULT_SETTINGS}}
    settings['name'] = ' '.join(str(settings.get('name') or 'Party Spin').split())[:MAX_NAME]
    if settings.get('mode') not in ('ftp', 'power', 'wkg'):
        settings['mode'] = 'ftp'
    end = settings.get('end') if isinstance(settings.get('end'), dict) else {}
    end_type = end.get('type') if end.get('type') in ('time', 'points', 'manual') else 'time'
    settings['end'] = {'type': end_type, 'value': clamp_number(end.get('value'), 1, 10_000_000, 30)}
    settings['powerups'] = bool(settings.get('powerups'))
    settings['break'] = bool(settings.get('break'))
    display = settings.get('display') if isinstance(settings.get('display'), dict) else {}
    settings['display'] = {
        'background': display.get('background') if display.get('background') in ('brick', 'color', 'video') else 'brick',
        'color': str(display.get('color') or '#2b1d33')[:20],
        'video': str(display.get('video') or '')[:500],
    }
    return settings


def clamp_number(value, low, high, default):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    number = float(min(high, max(low, number)))
    return int(number) if number.is_integer() else number
