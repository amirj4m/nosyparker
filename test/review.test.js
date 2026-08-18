/**
 * The storage a review needs: a fourth resting state, a link between two
 * memories that already exist, and a pass to hang both off.
 *
 * Nothing here goes through the gate. That is the next file up; this one is
 * about what the store will and will not let a decision do, because every rule
 * the gate applies is only worth what the layer underneath it enforces.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  decisionsInPass,
  getMemory,
  getPass,
  listMemories,
  openPasses,
  OVERTAKEN,
  recordDecision,
  searchMemories,
  unknownMemories,
} from '../src/store.js';
import { OWNER, temporaryStore } from './helpers.js';

/**
 * Store one memory, the short way, so a test about states is not three quarters
 * setup.
 *
 * @param {import('../src/store.js').Store} store
 * @param {string} text
 * @returns {number}
 */
function store1(store, text) {
  const written = recordDecision(store, (actions, at) => ({
    owner: OWNER,
    verdict: 'stored',
    rule: 'keep',
    explanation: 'Stored.',
    input_excerpt: text,
    memory_id: actions.insertMemory({ owner: OWNER, text, at, supersedes: null }),
  }));
  return /** @type {number} */ (written.memory_id);
}

test('a memory can be left behind, and it is not forgotten and not superseded', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');

  recordDecision(store, (actions, at) => {
    actions.leaveBehind({ owner: OWNER, id, at, reason: 'The month it named has been and gone.' });
    return {
      owner: OWNER,
      verdict: OVERTAKEN,
      rule: 'overtaken',
      explanation: 'Left behind.',
      input_excerpt: '',
      memory_id: id,
    };
  });

  const memory = /** @type {import('../src/store.js').Memory} */ (
    getMemory(store, OWNER, id, { includeArchived: true })
  );

  assert.equal(memory.state, 'overtaken');
  assert.equal(memory.state_reason, 'The month it named has been and gone.');

  // The distinction the state exists for: nothing replaced it.
  assert.equal(memory.superseded_by, null);
});

test('an overtaken memory leaves every reader that shows active memories', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  recordDecision(store, (actions, at) => {
    actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
    return { owner: OWNER, verdict: OVERTAKEN, rule: 'overtaken', explanation: '.', input_excerpt: '' };
  });

  // The four filters, all of which say `state = 'active'` and none of which
  // name the states that are not. This is the assertion behind the claim that a
  // fourth state cost the readers nothing.
  assert.deepEqual(listMemories(store, OWNER), []);
  assert.deepEqual(searchMemories(store, OWNER, 'Berlin'), []);
  assert.equal(getMemory(store, OWNER, id), null);
  assert.equal(getMemory(store, OWNER, id, { includeArchived: true })?.id, id);

  // And the substring path, which is a different query from the trigram one.
  assert.deepEqual(searchMemories(store, OWNER, 'am'), []);
});

test('restore brings an overtaken memory back with no code of its own', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  recordDecision(store, (actions, at) => {
    actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
    return { owner: OWNER, verdict: OVERTAKEN, rule: 'overtaken', explanation: '.', input_excerpt: '' };
  });

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.bringBack({ owner: OWNER, id, at, wasInState: 'overtaken', wasSupersededBy: null });
    return { owner: OWNER, verdict: 'restored', rule: 'restored', explanation: '.', input_excerpt: '' };
  });

  const memory = /** @type {import('../src/store.js').Memory} */ (getMemory(store, OWNER, id));
  assert.equal(memory.state, 'active');
  assert.equal(memory.state_reason, null);
});

test('only an active memory can be left behind', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Next month I am going to Berlin');
  recordDecision(store, (actions, at) => {
    actions.putAway({ owner: OWNER, id, at, reason: 'no', wasInState: 'active' });
    return { owner: OWNER, verdict: 'forgotten', rule: 'forget', explanation: '.', input_excerpt: '' };
  });

  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
        return { owner: OWNER, verdict: OVERTAKEN, rule: 'overtaken', explanation: '.', input_excerpt: '' };
      }),
    /changed underneath this decision/u,
  );

  // The refusal rolled the whole thing back, so the memory is as it was and
  // there is no half-written row saying otherwise.
  assert.equal(getMemory(store, OWNER, id, { includeArchived: true })?.state, 'forgotten');
});

test('the file itself refuses a state this code does not know, and accepts the four it does', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'Something');

  // Asked of the file rather than through an action, because no action can
  // write a fifth state and that is exactly why this has to be asked another
  // way. The CHECK is the backstop underneath the four, and a backstop nothing
  // exercises is a backstop nobody knows the shape of.
  const direct = new DatabaseSync(store.file);
  t.after(() => direct.close());

  for (const state of ['active', 'superseded', 'forgotten', 'overtaken']) {
    direct.prepare('UPDATE memories SET state = ? WHERE id = ?').run(state, id);
    assert.equal(
      /** @type {{state: string}} */ (
        /** @type {unknown} */ (direct.prepare('SELECT state FROM memories WHERE id = ?').get(id))
      ).state,
      state,
    );
  }

  assert.throws(
    () => direct.prepare('UPDATE memories SET state = ? WHERE id = ?').run('archived', id),
    /CHECK constraint failed/u,
  );
});

test('two memories that already exist can be linked, and the link is refused if it would overwrite one', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const older = store1(store, 'I live in Tehran');
  const newer = store1(store, 'I live in Berlin');
  const third = store1(store, 'I live in Vienna');

  recordDecision(store, (actions, at) => {
    actions.retire({ owner: OWNER, id: older, at, supersededBy: newer });
    actions.claimSupersedes({ owner: OWNER, id: newer, nowSupersedes: older });
    return { owner: OWNER, verdict: 'superseded', rule: 'replaces', explanation: '.', input_excerpt: '' };
  });

  assert.equal(getMemory(store, OWNER, older, { includeArchived: true })?.state, 'superseded');
  assert.equal(getMemory(store, OWNER, older, { includeArchived: true })?.superseded_by, newer);
  assert.equal(getMemory(store, OWNER, newer)?.supersedes, older);

  // The half that matters. Memory `newer` already says what it replaced, and a
  // second claim would silently rewrite it — leaving `older` retired, pointing
  // at a memory that points somewhere else, with nothing recording the change.
  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.retire({ owner: OWNER, id: third, at, supersededBy: newer });
        actions.claimSupersedes({ owner: OWNER, id: newer, nowSupersedes: third });
        return { owner: OWNER, verdict: 'superseded', rule: 'replaces', explanation: '.', input_excerpt: '' };
      }),
    /supersedes memory/u,
  );

  assert.equal(getMemory(store, OWNER, newer)?.supersedes, older);
  assert.equal(getMemory(store, OWNER, third)?.state, 'active');
});

test('a pass is opened, closed once, and undone once', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  /** @type {number} */
  let pass = 0;
  recordDecision(store, (actions, at) => {
    pass = actions.openPass({ owner: OWNER, reviewer: 'an agent', at });
    return { owner: OWNER, verdict: 'began', rule: 'review-began', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.equal(getPass(store, OWNER, pass)?.reviewer, 'an agent');
  assert.deepEqual(openPasses(store, OWNER).map((row) => row.id), [pass]);

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.shutPass({ owner: OWNER, pass, at });
    return { owner: OWNER, verdict: 'closed', rule: 'review-closed', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.notEqual(getPass(store, OWNER, pass)?.closed_at, null);
  assert.deepEqual(openPasses(store, OWNER), []);

  // Closing again would move the timestamp off the moment the review actually
  // stopped, so it is refused rather than made idempotent.
  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.shutPass({ owner: OWNER, pass, at });
        return { owner: OWNER, verdict: 'closed', rule: 'review-closed', explanation: '.', input_excerpt: '' };
      }),
    /close review/u,
  );

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.abandonPass({ owner: OWNER, pass, at });
    return { owner: OWNER, verdict: 'undone', rule: 'review-undone', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.notEqual(getPass(store, OWNER, pass)?.undone_at, null);

  assert.throws(
    () =>
      recordDecision(store, (actions, at) => {
        actions.abandonPass({ owner: OWNER, pass, at });
        return { owner: OWNER, verdict: 'undone', rule: 'review-undone', explanation: '.', input_excerpt: '' };
      }),
    /undo review/u,
  );
});

test("a pass that was never closed is not left open once it has been undone", (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  /** @type {number} */
  let pass = 0;
  recordDecision(store, (actions, at) => {
    pass = actions.openPass({ owner: OWNER, reviewer: 'an agent', at });
    return { owner: OWNER, verdict: 'began', rule: 'review-began', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  store.tick();
  recordDecision(store, (actions, at) => {
    actions.abandonPass({ owner: OWNER, pass, at });
    return { owner: OWNER, verdict: 'undone', rule: 'review-undone', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  assert.deepEqual(openPasses(store, OWNER), []);
});

test("a pass's decisions come back newest first, which is the order an undo needs", (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const first = store1(store, 'I live in Tehran');
  const second = store1(store, 'I live in Berlin');

  /** @type {number} */
  let pass = 0;
  recordDecision(store, (actions, at) => {
    pass = actions.openPass({ owner: OWNER, reviewer: 'an agent', at });
    return { owner: OWNER, verdict: 'began', rule: 'review-began', explanation: '.', input_excerpt: '', pass_id: pass };
  });

  for (const id of [first, second]) {
    store.tick();
    recordDecision(store, (actions, at) => {
      actions.leaveBehind({ owner: OWNER, id, at, reason: 'gone by' });
      return {
        owner: OWNER,
        verdict: OVERTAKEN,
        rule: 'overtaken',
        explanation: '.',
        input_excerpt: '',
        memory_id: id,
        pass_id: pass,
        reasoning: 'the moment it named has passed',
        derived_from: String(id),
      };
    });
  }

  const inPass = decisionsInPass(store, OWNER, pass);
  assert.deepEqual(inPass.map((row) => row.memory_id), [second, first, null]);

  // The three review columns are on the decision row itself, so `why` shows a
  // review's reasoning beside everything else that ever happened.
  assert.equal(inPass[0].reasoning, 'the moment it named has passed');
  assert.equal(inPass[0].derived_from, String(second));
  assert.equal(inPass[0].pass_id, pass);
});

test('a decision taken outside a review carries none of the review columns', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const id = store1(store, 'I live in Tehran');
  const [written] = decisionsInPass(store, OWNER, 1);
  assert.equal(written, undefined);

  const memory = getMemory(store, OWNER, id);
  assert.notEqual(memory, null);
});

test('derived_from is checked against the store, archived rows included', (t) => {
  const store = temporaryStore();
  t.after(() => store.close());

  const kept = store1(store, 'I live in Tehran');
  const putAway = store1(store, 'I live in Berlin');

  recordDecision(store, (actions, at) => {
    actions.putAway({ owner: OWNER, id: putAway, at, reason: 'no', wasInState: 'active' });
    return { owner: OWNER, verdict: 'forgotten', rule: 'forget', explanation: '.', input_excerpt: '' };
  });

  // A review reads what has been put away as readily as what is on show, and
  // usually that is the point of reading it, so an archived id is a legitimate
  // thing to have reasoned from.
  assert.deepEqual(unknownMemories(store, OWNER, [kept, putAway]), []);
  assert.deepEqual(unknownMemories(store, OWNER, [kept, 9999, putAway, 4242]), [9999, 4242]);
  assert.deepEqual(unknownMemories(store, OWNER, []), []);

  // Somebody else's memory is not one this owner reasoned from.
  assert.deepEqual(unknownMemories(store, 'somebody-else', [kept]), [kept]);
});
