// Ready-made contraptions. Each entry is [type, x, y, rot].
// All of them reach the star when played.

const EXAMPLES = {
  'Domino Run': {
    blurb: 'Marble, ramp, dominoes, star. The classic.',
    items: [
      ['block', 2, 0], ['block', 2, 1], ['block', 2, 2],
      ['block', 3, 0], ['block', 3, 1], ['block', 4, 0], ['block', 4, 1],
      ['longramp', 3, 2], ['marble', 3, 4],
      ['domino', 7, 0], ['domino', 8, 0], ['domino', 9, 0], ['domino', 10, 0], ['domino', 11, 0],
      ['star', 13, 0],
    ],
  },

  'Seesaw Launch': {
    blurb: 'A bowling ball slams one end of a seesaw and flings the marble into the star.',
    items: [
      ['block', 4, 0], ['block', 4, 1],
      ['seesaw', 5, 0], ['marble', 5, 1],
      ['bowling', 7, 6],
      ['star', 6, 4],
    ],
  },

  'Fan Elevator': {
    blurb: 'One fan rolls the marble up a ramp, a second lifts it, a third blows it across to the star.',
    items: [
      ['fan', 0, 0, 0], ['marble', 2, 0],
      ['ramp', 4, 0, 1], ['fan', 5, 0, 1],
      ['fan', 4, 4, 0],
      ['block', 12, 0], ['block', 12, 1], ['block', 12, 2], ['block', 12, 3], ['block', 12, 4],
      ['star', 12, 5],
    ],
  },

  'Wrecking Ball': {
    blurb: 'A bowling ball rolls into a pendulum, which swings into a row of dominoes.',
    items: [
      ['block', 0, 0], ['block', 0, 1], ['block', 0, 2],
      ['block', 1, 0], ['block', 1, 1], ['block', 1, 2],
      ['block', 2, 0], ['block', 2, 1], ['block', 3, 0], ['block', 3, 1],
      ['longramp', 2, 2], ['bowling', 2, 3],
      ['pendulum', 6, 1],
      ['domino', 7, 0], ['domino', 8, 0], ['domino', 9, 0],
      ['star', 11, 0],
    ],
  },

  'Bounce Alley': {
    blurb: 'The marble rolls off a tower and bounces pad to pad, catching the star mid-air.',
    items: [
      ['block', 0, 0], ['block', 0, 1], ['block', 0, 2], ['block', 0, 3],
      ['block', 1, 0], ['block', 1, 1], ['block', 1, 2], ['block', 1, 3],
      ['block', 2, 0], ['block', 2, 1], ['block', 2, 2], ['block', 2, 3],
      ['longramp', 1, 4], ['marble', 1, 5],
      ['bouncer', 5, 0], ['bouncer', 10, 0], ['bouncer', 16, 0],
      ['star', 13, 5],
    ],
  },

  'Launch & Catch': {
    blurb: 'A launcher shoots the marble off a ledge onto a conveyor, which drops it into a bucket with the star.',
    items: [
      ['block', 1, 0], ['block', 1, 1], ['block', 2, 0], ['block', 2, 1],
      ['launcher', 1, 2, 3], ['marble', 2, 2],
      ['block', 4, 0], ['block', 5, 0], ['conveyor', 4, 1],
      ['bucket', 6, 0], ['star', 6, 1],
      ['block', 7, 0], ['block', 7, 1],
    ],
  },

  'Plank Bridge': {
    blurb: 'The marble rolls down a ramp, across a loose plank bridge, and off the end into a row of dominoes.',
    items: [
      ['block', 0, 0], ['block', 0, 1], ['block', 0, 2],
      ['block', 1, 0], ['block', 1, 1], ['block', 1, 2],
      ['block', 2, 0], ['block', 2, 1], ['block', 3, 0], ['block', 3, 1],
      ['longramp', 2, 2], ['marble', 2, 3],
      ['block', 4, 0], ['block', 4, 1], ['plank', 4, 2],
      ['block', 6, 0], ['block', 6, 1],
      ['domino', 9, 0], ['domino', 10, 0], ['domino', 11, 0],
      ['star', 13, 0],
    ],
  },

  'Bell Ringer': {
    blurb: 'A pendulum, pulled back two columns, swings into a bell and the star behind it.',
    items: [
      ['pendulum', 6, 1, 2],
      ['bell', 8, 2],
      ['star', 8, 1],
    ],
  },
};
