"""
The power-up cards. This is the only place their rules live: the server sends this list to every
client when it connects, so names, descriptions and targeting are never duplicated in JavaScript.

target:
    'self'    – affects the player who plays it
    'choose'  – the player picks another rider
    'behind'  – the rider directly behind you on the leaderboard (picked by the server)
    'ahead'   – the rider directly ahead of you on the leaderboard (picked by the server)
    None      – cannot be played (the Nope card is only used as an answer to an attack)

Scores grow by about 100 points per second for an average rider, so 1000 points ≈ 10 s of riding.
"""

NOPE = 1

CARDS = {
    1: {
        'name': 'Nope',
        'text': 'Cancel a card that someone plays on you. Kept in its own slot.',
        'target': None,
    },
    2: {
        'name': 'Boost',
        'text': '+1000 points for you, right now.',
        'target': 'self',
        'points': 1000,
    },
    3: {
        'name': 'Sabotage',
        'text': '−1000 points for a rider of your choice.',
        'target': 'choose',
        'points': -1000,
    },
    4: {
        'name': 'EPO',
        'text': 'Your points count ×1.2 for 90 seconds.',
        'target': 'self',
        'multiplier': 1.2,
        'duration': 90_000,
    },
    5: {
        'name': 'Copycat',
        'text': 'For 60 seconds your points are counted from another rider\'s watts.',
        'target': 'choose',
        'duration': 60_000,
    },
    6: {
        'name': 'Steal',
        'text': 'Take a random card from another rider.',
        'target': 'choose',
    },
    7: {
        'name': 'Thumbtacks',
        'text': 'The rider right behind you gets a flat tyre: no points until they fix it (max 60 s).',
        'target': 'behind',
        'duration': 60_000,
    },
    8: {
        'name': 'Pray',
        'text': 'Sacrifice 2000–4000 of your points: another rider scores nothing for 30–60 seconds.',
        'target': 'choose',
        'sacrifice': (2000, 4000),
        'duration': (30_000, 60_000),
    },
    9: {
        'name': 'Grapple',
        'text': 'You and the rider right ahead of you meet in the middle: both get the average score.',
        'target': 'ahead',
    },
}

PLAYABLE = [card for card, rules in CARDS.items() if rules['target']]

# How long a rider has to answer a card played on them with Nope (ms of game time).
NOPE_WINDOW = 6_000

HAND_SIZE = 5


def public_cards():
    """The card list as sent to clients (tuples become [min, max] lists in JSON)."""
    return {str(card): rules for card, rules in CARDS.items()}
