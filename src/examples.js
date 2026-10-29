// Ready-made contraptions. Each entry is [type, x, y, rot, flip, size]; x and y
// are on the quarter-cell subgrid.
// All of them reach the star when played.

const EXAMPLES = {
  'Domino Run': {
    blurb: 'Marble, ramp, dominoes, star. The classic.',
    items: [
      ['block', 2, 0], ['block', 2, 1], ['block', 2, 2],
      ['block', 3, 0], ['block', 3, 1], ['block', 4, 0], ['block', 4, 1],
      ['ramp', 3, 2, 0, false, { w: 2, h: 1 }], ['marble', 3, 4],
      ['domino', 7, 0], ['domino', 8, 0], ['domino', 9, 0], ['domino', 10, 0], ['domino', 11, 0],
      ['star', 12.5, 0],
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
      ['fan', 0, 0, 0], ['marble', 1, 1],
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
      ['ramp', 2, 2, 0, false, { w: 2, h: 1 }], ['bowling', 2, 3],
      ['pendulum', 6, 1],
      ['domino', 7, 0], ['domino', 8, 0], ['domino', 9, 0],
      ['star', 10.5, 0],
    ],
  },

  'Bounce Alley': {
    blurb: 'The marble rolls off a tower and bounces pad to pad, catching the star mid-air.',
    items: [
      ['block', 0, 0], ['block', 0, 1], ['block', 0, 2], ['block', 0, 3],
      ['block', 1, 0], ['block', 1, 1], ['block', 1, 2], ['block', 1, 3],
      ['block', 2, 0], ['block', 2, 1], ['block', 2, 2], ['block', 2, 3],
      ['ramp', 1, 4, 0, false, { w: 2, h: 1 }], ['marble', 1, 4.75],
      ['bouncer', 4.5, 0], ['bouncer', 9.5, 0], ['bouncer', 14, 0],
      ['star', 11, 3],
    ],
  },

  'Launch & Catch': {
    blurb: 'A launcher shoots the marble off a ledge onto a conveyor, which drops it into a bucket with the star.',
    items: [
      ['block', 1, 0], ['block', 1, 1], ['block', 2, 0], ['block', 2, 1],
      ['launcher', 1, 2, 3], ['marble', 2, 1.75],
      ['block', 4, 0], ['block', 5, 0], ['conveyor', 4, 1],
      ['bucket', 6, 0], ['star', 6.25, 1],
      ['block', 7.5, 0], ['block', 7.5, 1],
    ],
  },

  'Plank Bridge': {
    blurb: 'The marble rolls down a ramp, across a loose plank bridge, and off the end into a row of dominoes.',
    items: [
      ['block', 0, 0], ['block', 0, 1], ['block', 0, 2],
      ['block', 1, 0], ['block', 1, 1], ['block', 1, 2],
      ['block', 2, 0], ['block', 2, 1], ['block', 3, 0], ['block', 3, 1],
      ['ramp', 2, 2, 0, false, { w: 2, h: 1 }], ['marble', 2, 2.75],
      ['block', 4, 0], ['block', 4, 1, 0, false, { w: 1, h: 0.75 }], ['plank', 4, 1.75],
      ['block', 6, 0], ['block', 6, 1, 0, false, { w: 1, h: 0.75 }],
      ['domino', 9, 0], ['domino', 10, 0], ['domino', 11, 0],
      ['star', 12.5, 0],
    ],
  },

  'Bell Ringer': {
    blurb: 'A pendulum, pulled back two columns, swings into a bell and the star behind it.',
    items: [
      ['pendulum', 6, 1, -2],
      ['bell', 8, 2],
      ['star', 8, 1],
    ],
  },
};
