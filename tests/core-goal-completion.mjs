import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { OPEN_STATUSES, completionPatch, createCompletionReconciler, findReportedCompletions } from '../src/core/goal-completion.mjs';
import { createVisualGoals } from '../src/core/visual-goals.mjs';
import { conversationText } from '../src/core/sessions/recent-context.mjs';
import { redact } from '../src/core/workstreams.mjs';

const CREATED = '2026-09-20T10:00:00.000Z';
const HEARD = '2026-09-21T09:00:00.000Z';
const RIVERA = 'Follow up with Professor Rivera';
const SENT = 'I sent the follow up to Rivera';
const heardId = id => `heard-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
let sequence = 0;

function goal(title, extra = {}) {
  return { id: `goal-${++sequence}`, repoId: 'harbor', title, status: 'planned', evidence: [], completion: null, revision: 1, createdAt: CREATED, updatedAt: CREATED, ...extra };
}
function message(text, extra = {}) {
  return { id: `msg-${++sequence}`, provider: 'claude', sessionKey: 'claude:session-harbor', text, at: HEARD, truncated: false, ...extra };
}
const heard = (title, text, goalExtra, messageExtra) => findReportedCompletions({ goals: [goal(title, goalExtra)], messages: [message(text, messageExtra)] });
// The journal stores text as conversationText shapes it, with every line break flattened.
const reports = (titles, text) => {
  const goals = [].concat(titles).map(title => goal(title));
  return findReportedCompletions({ goals, messages: [message(conversationText(text))] }).map(match => goals.find(item => item.id === match.goalId).title);
};
const never = cases => { for (const [titles, text] of cases) assert.deepEqual(reports(titles, text), [], text); };
async function store(t, clock = { at: Date.parse(CREATED) }) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-heard-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return createVisualGoals({ dataDir, now: () => (clock.at += 1000) });
}

test('a first-person completed action that names the goal reports it', () => {
  const cases = [
    [RIVERA, "We just sent rivera a follow up email. what's the next highest leverage step?", 'We just sent rivera a follow up email.'],
    [RIVERA, 'we just sent rivera a follow up email, what should I do next', 'we just sent rivera a follow up email, what should I do next'],
    [RIVERA, 'The Rivera follow-up went out', 'The Rivera follow-up went out'],
    [RIVERA, 'I emailed rivera to follow up on my application', 'I emailed rivera to follow up on my application'],
    [RIVERA, 'I followed up with rivera, no reply so far', 'I followed up with rivera, no reply so far'],
    [RIVERA, 'I emailed rivera yet again', 'I emailed rivera yet again'],
    ['Submit the conference abstract', 'ok I submitted the conference abstract this morning', 'ok I submitted the conference abstract this morning'],
    ['Submit the conference abstract', "I've submitted the conference abstract", "I've submitted the conference abstract"],
    ['Reply to Dana about the pilot', 'replied to dana', 'replied to dana'],
    ['Ship the onboarding checklist', 'the onboarding checklist is done', 'the onboarding checklist is done'],
    ['Send the slides to Rivera', 'Already sent the slides to Rivera', 'Already sent the slides to Rivera'],
    ['Send the slides to Dr. Rivera', 'I emailed Dr. Rivera the slides', 'I emailed Dr. Rivera the slides'],
    ['Email Rivera', '- [x] emailed rivera', '- [x] emailed rivera'],
    ['File the I-9', 'I filed the I-9', 'I filed the I-9'],
    ['Pay invoice 1042', 'I paid invoice 1042', 'I paid invoice 1042'],
    ['Email Will', 'I emailed Will this morning', 'I emailed Will this morning'],
    ['Email José', 'I emailed José', 'I emailed José'],
  ];
  for (const [title, text, quote] of cases) {
    const target = goal(title, { revision: 4 }), said = message(text, { role: 'user' });
    const found = findReportedCompletions({ goals: [target], messages: [said] });
    assert.equal(found.length, 1, text);
    assert.deepEqual(found[0], { goalId: target.id, repoId: 'harbor', expectedRevision: 4, evidenceId: heardId(said.id), messageId: said.id, quote, at: HEARD, provider: 'claude', sessionKey: 'claude:session-harbor' }, text);
    assert.match(found[0].evidenceId, /^heard-[0-9a-f]{16}$/);
  }
});

test('plans, questions, requests, negations and third-party actions never report', () => {
  const cases = [
    [RIVERA, 'I might send Rivera a second email'],
    [RIVERA, 'should I follow up with rivera?'],
    [RIVERA, "I haven't sent rivera the follow up yet"],
    [RIVERA, 'I havent sent rivera the follow up yet'],
    [RIVERA, 'remind me to email rivera tomorrow'],
    [RIVERA, 'draft the email to professor rivera'],
    [RIVERA, 'why is follow up with professor rivera still in my goals?'],
    [RIVERA, 'We sent the report to Jordan'],
    [RIVERA, 'sent the follow up'],
    [RIVERA, 'if I sent rivera the follow up, would he reply?'],
    [RIVERA, 'Rivera sent me feedback on the draft'],
    [RIVERA, "I'll have sent rivera the follow up by noon"],
    [RIVERA, 'I think I sent rivera the follow up'],
    [RIVERA, 'did I send rivera the follow up'],
    [RIVERA, 'I was sent the notes by Rivera'],
    [RIVERA, 'Rivera is done with the review'],
    [RIVERA, 'the agent wrote "I sent the follow up to Rivera"'],
    ['Ship the onboarding checklist', 'the onboarding checklist is almost done'],
    ['Submit the conference abstract', 'I finished reading the abstract guidelines'],
    ['Submit the conference abstract', 'I emailed rivera about the conference abstract'],
    ['Submit the conference abstract', 'the email about the conference abstract is sent'],
  ];
  for (const [title, text] of cases) assert.deepEqual(heard(title, text), [], text);
});

test('a follow-up goal needs a follow-up, not the earlier send it follows', () => {
  never([
    [RIVERA, 'Help me write the follow-up. I emailed Professor Rivera two weeks ago about joining her lab.'],
    [RIVERA, 'I emailed Rivera on the 3rd. She never answered, so what should the follow-up say?'],
    [RIVERA, 'Already sent it to Rivera 2 days ago'],
    [RIVERA, 'I emailed Rivera'],
    ['Email Rivera', 'I emailed Rivera two weeks ago'],
    ['Email Rivera', 'I emailed Rivera on the 3rd'],
  ]);
});

test('pasted drafts and requests to write a message are never heard', () => {
  never([
    ['Submit the conference abstract', 'Dear Professor Rivera, I sent you my revised abstract on Monday. Best, Sam. — polish this please'],
    ['Submit the conference abstract', 'Dear Professor Rivera,\nI just submitted the conference abstract.\nBest, Sam'],
    ['Submit the revised proposal', 'Hi Professor Rivera,\nI just submitted the revised proposal.'],
    ['Submit the revised proposal', 'polish this draft:\nI just submitted the revised proposal and wanted to check in'],
    ['Email Rivera', 'Sent the deck to rivera\ncan you draft the next email to jordan'],
  ]);
});

test('lists flattened by the journal keep their items and to-do sections apart', () => {
  never([
    [[RIVERA, 'Submit the conference abstract', 'Email Rivera'], 'Done:\n- submitted abstract\nTodo:\n- email Rivera'],
    ['Email Rivera', 'Done:\n- submitted the conference abstract\nTodo:\n- emailed Rivera'],
    ['Email Rivera', 'Shipped the harbor export\nemail Rivera next'],
    ['Email Rivera', 'sent the abstract, next up emailing rivera'],
    ['Email Jordan', 'Shipped the onboarding checklist\nJordan follow-up is still open'],
    ['Email Rivera', 'I merged the PR\nRivera office hours are Tuesday'],
    ['Email Rivera', 'Emailed rivera\nwhat should I do next'],
    ['Email Rivera', 'Things I still need to do:\n- emailed rivera'],
  ]);
  assert.deepEqual(reports(['Email Rivera', 'Reply to Dana about the pilot'], 'Done:\n- emailed rivera\n- replied to dana'), ['Email Rivera', 'Reply to Dana about the pilot']);
  assert.deepEqual(reports('Send the deck to Rivera', '• sent rivera the deck'), ['Send the deck to Rivera']);
});

test('what an action names stops at the next clause, preposition or purpose', () => {
  never([
    ['Email Jordan', 'Sent rivera the deck, jordan is next'],
    ['Email Jordan', 'I merged the PR, Jordan follow-up still pending'],
    ['Email Jordan', 'sent rivera the deck, still need to email jordan'],
    [[RIVERA, 'Email Rivera'], "I replied to Jordan's comment on Rivera's paper"],
    [[RIVERA, 'Email Rivera'], "I sent jordan the notes from rivera's lecture"],
    [[RIVERA, 'Email Rivera'], "I emailed jordan for rivera's recommendation"],
    ['Schedule a meeting with Rivera', 'I emailed rivera to schedule a meeting'],
    ['Get feedback from Rivera on the draft', 'I sent rivera the draft and now waiting on feedback'],
    ['Email Rivera', 'I sent the draft that was due to rivera'],
  ]);
  assert.deepEqual(reports(['Email Rivera', 'Reply to Dana about the pilot'], 'I emailed rivera, replied to dana'), ['Email Rivera', 'Reply to Dana about the pilot']);
});

test('a finished state needs a thing as its subject, never a bare name', () => {
  never(['Rivera is done', 'Rivera got paid', 'Rivera went out to the lobby', 'Rivera went out yesterday', 'Rivera was published in Nature', "Rivera's class is finished",
    "The grades for Rivera's class are posted", 'I talked to rivera and the abstract is done', 'We met Rivera this morning, the deck is finished', 'the draft that rivera wanted is done']
    .map(text => [[RIVERA, 'Email Rivera'], text]));
  assert.deepEqual(reports(RIVERA, 'the follow up went out to rivera'), [RIVERA]);
});

test('names, numbers and two-term titles must match in full', () => {
  never([
    [['Follow up with Ana Rivera', 'Email Ana Rivera'], 'I texted Ana'],
    [['Follow up with Ana Rivera', 'Email Ana Rivera'], 'I emailed Ana Lopez about dinner plans'],
    [['Follow up with Smith-Jones', 'Email Smith-Jones'], 'I emailed Jordan Smith'],
    ['Submit Q3 report', 'I submitted the Q2 report'],
    ['Submit HW 3', 'I submitted HW 2'],
    ['Submit problem set 4', 'I submitted problem set 3'],
    ['Submit the conference abstract', 'ok I submitted the abstract this morning'],
  ]);
  assert.deepEqual(reports('Submit W-2', 'Submitted the W-2 to payroll'), ['Submit W-2']);
});

test('the action must fit what the title asks for', () => {
  never([
    [RIVERA, 'I paid rivera back for lunch'],
    [RIVERA, "I submitted the homework for Rivera's class"],
    [RIVERA, "I finished rivera's reading"],
    ['Call mom', 'I sent mom the photos'],
    ['Pay rent', 'I paid for the rent-a-car'],
    ['Follow up on the paper', 'I submitted the paper towel order'],
  ]);
  assert.deepEqual(reports('Taxes', 'I filed my taxes'), ['Taxes']);
});

test("speaker labels, logs, sign-offs and code are not the user's own actions", () => {
  never([
    [[RIVERA, 'Email Rivera'], 'Jordan: sent rivera the draft'],
    [[RIVERA, 'Email Rivera'], 'Jordan - sent rivera the draft'],
    [[RIVERA, 'Email Rivera'], 'status: sent to rivera'],
    [[RIVERA, 'Email Rivera'], '2026-09-22 10:00:01 - sent heartbeat to rivera-api'],
    ['Get grades from Rivera', 'Rivera replied: sent the grades'],
    ["Upload Rivera's recommendation letter", 'Error: uploaded file exceeds the limit (rivera-letter.pdf)'],
    ['Deploy the webhook handler', 'git log: merged webhook handler refactor from main'],
    ['Fix the login redirect', 'Merged pull request #42 from harbor/login-cleanup'],
    [[RIVERA, 'Email Rivera'], 'Published work by Professor Rivera shows the effect'],
    [[RIVERA, 'Email Rivera'], 'Signed, Professor Rivera'],
    [[RIVERA, 'Email Rivera'], "Paid attention to rivera's feedback"],
    [[RIVERA, 'Email Rivera'], "Signed up for rivera's seminar"],
    [[RIVERA, 'Email Rivera'], 'for (i sent of rivera) {}'],
  ]);
});

test('quoted, reported and hypothetical speech is not heard', () => {
  never(["he said 'I sent it to rivera'", 'Jordan wrote ‘I emailed Rivera already’', 'Say I sent rivera the email. What then?', 'Write a message saying I sent Rivera the slides',
    'Jordan claims we sent rivera the wrong version', 'My advisor said I emailed rivera too early'].map(text => [[RIVERA, 'Email Rivera'], text]));
});

test('"done with", habits, jokes, retractions and old events are not completions', () => {
  never([
    ...["done with rivera's class for the semester", "Finally done with Rivera's lecture", 'Finished with Rivera, moving to the budget', 'Rivera gets published next month',
      'yeah right, I sent rivera the email', 'I just sent rivera a follow up email lol jk', 'Oh sure, we already emailed Rivera. In my dreams.', 'I sent Rivera the email... NOT',
      'Back in August I emailed Rivera', 'Last time I emailed Rivera it took a week', 'I sent zero emails to rivera', 'I sent rivera the email - not sure it arrived'].map(text => [[RIVERA, 'Email Rivera'], text]),
    ['Send the newsletter', 'The newsletter gets sent every Monday'],
    ['Post the report', 'The report is posted every Friday'],
  ]);
});

test('only user messages after the goal was created are heard', () => {
  assert.deepEqual(heard(RIVERA, SENT, {}, { at: '2026-09-19T09:00:00.000Z' }), []);
  assert.deepEqual(heard(RIVERA, SENT, {}, { at: CREATED }), []);
  assert.deepEqual(heard(RIVERA, SENT, {}, { role: 'assistant' }), []);
  assert.deepEqual(heard(RIVERA, SENT, {}, { at: 'not a date' }), []);
  assert.equal(heard(RIVERA, SENT, {}, { role: 'user' }).length, 1);
});

test('only open goals are heard', () => {
  assert.deepEqual(OPEN_STATUSES, ['planned', 'working', 'blocked']);
  for (const status of ['working', 'blocked']) assert.equal(heard(RIVERA, SENT, { status }).length, 1, status);
  for (const status of ['done', 'dismissed', 'deferred', 'needs-verification']) assert.deepEqual(heard(RIVERA, SENT, { status }), [], status);
});

test('a message already recorded as evidence, or said before the user reopened the goal, is not heard again', () => {
  const said = message(SENT);
  const target = goal(RIVERA, { evidence: [{ id: heardId(said.id), summary: 'You said this was done.', reference: '' }] });
  assert.deepEqual(findReportedCompletions({ goals: [target], messages: [said] }), []);
  const later = message('Replied to Rivera again', { at: '2026-09-22T09:00:00.000Z' });
  assert.equal(findReportedCompletions({ goals: [target], messages: [said, later] })[0].messageId, later.id, 'A new message can still report the goal.');
  const history = [{ at: CREATED, actor: 'user', status: 'planned', nextStep: '', sessionKey: null }, { at: '2026-09-21T09:01:00.000Z', actor: 'agent', status: 'needs-verification', nextStep: '', sessionKey: null },
    { at: '2026-09-21T09:30:00.000Z', actor: 'user', status: 'blocked', nextStep: '', sessionKey: null }];
  assert.deepEqual(findReportedCompletions({ goals: [goal(RIVERA, { status: 'blocked', history })], messages: [said] }), [], 'The revert outranks the earlier message.');
  assert.equal(findReportedCompletions({ goals: [goal(RIVERA, { status: 'blocked', history })], messages: [later] }).length, 1);
});

test('one message that would finish three goals reports none of them', () => {
  const goals = [goal(RIVERA), goal('Reply to Dana about the pilot'), goal('Submit the conference abstract')];
  assert.deepEqual(findReportedCompletions({ goals, messages: [message('Done: I followed up with rivera, replied to dana and submitted the conference abstract')] }), []);
  const two = findReportedCompletions({ goals, messages: [message('I followed up with rivera and replied to dana')] });
  assert.deepEqual(two.map(item => item.goalId), [goals[0].id, goals[1].id]);
});

test('the earliest qualifying message wins and each goal is reported once', () => {
  const target = goal(RIVERA);
  const late = message('Sent Rivera the follow up', { at: '2026-09-22T09:00:00.000Z' }), early = message('I followed up with Rivera', { at: '2026-09-21T08:00:00.000Z' });
  const found = findReportedCompletions({ goals: [target], messages: [late, early] });
  assert.deepEqual(found.map(item => item.messageId), [early.id]);
});

test('titles with three distinctive terms need two of them', () => {
  const title = 'Book flights to Denver for the summit';
  assert.deepEqual(heard(title, 'I booked a hotel in Denver'), []);
  assert.equal(heard(title, 'I booked the flights to Denver').length, 1);
  assert.deepEqual(heard('Follow up with the team', 'I followed up with the team'), [], 'A title of only generic words is never heard.');
});

test('the cut sentence of a truncated or full-length message is ignored', () => {
  assert.deepEqual(heard(RIVERA, 'We talked about the budget. I sent rivera the follow up but I have…', {}, { truncated: true }), []);
  assert.equal(heard(RIVERA, 'I sent rivera the follow up. We talked about the budget and…', {}, { truncated: true }).length, 1);
  const tail = '. I sent Rivera the follow up draft but', full = 'Notes on the retreat seating plan'.padEnd(1000 - tail.length, '. Notes on the retreat seating plan') + tail;
  assert.equal(full.length, 1000);
  assert.deepEqual(heard(RIVERA, full), [], 'Text at the excerpt bound may have lost its ending.');
});

test('repeated filler words stay fast', () => {
  const started = performance.now();
  assert.deepEqual(heard('Email Rivera', `${'earlier today '.repeat(60)}rivera; the deck is done`), []);
  assert.deepEqual(heard('Email Rivera', `${'ok ok, '.repeat(140)}sent rivera`), []);
  assert.deepEqual(heard('Email Rivera', `i ${'just '.repeat(190)}sent rivera`), []);
  assert.ok(performance.now() - started < 1000);
});

test('completionPatch reports needs-verification with appended evidence', () => {
  const kept = { id: 'note-1', summary: 'Earlier evidence.', reference: '' };
  const target = goal(RIVERA, { revision: 3, evidence: [kept] });
  const [match] = findReportedCompletions({ goals: [target], messages: [message(`${SENT}. What now?`, { id: 'm-1' })] });
  const reference = `Claude message at ${HEARD}; evidence ${heardId('m-1')}`;
  assert.deepEqual(completionPatch(target, match), {
    id: target.id, repoId: 'harbor', expectedRevision: 3, status: 'needs-verification',
    completion: { kind: 'reported', summary: `Reported from your own message: "${SENT}."`, reference },
    evidence: [kept, { id: heardId('m-1'), summary: `You said this was done: "${SENT}."`, reference }],
  });
  assert.equal(completionPatch({ ...target, status: 'done' }, match), null);
  assert.equal(completionPatch({ ...target, evidence: [{ id: match.evidenceId, summary: 'Reverted.', reference: '' }] }, match), null);
  const full = Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}`, summary: 'Evidence.', reference: '' }));
  assert.equal(completionPatch({ ...target, evidence: full }, match), null);
  const long = findReportedCompletions({ goals: [target], messages: [message(`${SENT} ${'with notes '.repeat(60)}`)] })[0];
  assert.ok(long.quote.length <= 300 && long.quote.endsWith('…'));
  const emoji = findReportedCompletions({ goals: [target], messages: [message(`I sent Rivera the follow up ${'x'.repeat(271)}🎉 and more text here`)] })[0];
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji.quote), false, 'A clipped quote never ends in half a character.');
});

test('the reconciler reports through the real goal store and a user revert sticks', async t => {
  const goals = await store(t);
  const [saved] = await goals.save({ repoId: 'harbor', title: RIVERA, nextStep: 'Email Professor Rivera.' });
  const said = message("We just sent rivera a follow up email. what's the next highest leverage step?", { role: 'user', at: '2026-09-22T09:00:00.000Z' });
  const reconciler = createCompletionReconciler({ listMessages: async () => [{ repoId: 'harbor', messages: [said] }], readGoals: repoId => goals.read(repoId), saveGoal: (patch, options) => goals.save(patch, options) });
  const first = await reconciler.run();
  assert.deepEqual(first, { reported: [{ repoId: 'harbor', goalId: saved.id, messageId: said.id }], skipped: [], errors: [] });
  const [reported] = goals.read('harbor');
  assert.equal(reported.status, 'needs-verification');
  assert.equal(reported.revision, 2);
  assert.deepEqual(reported.completion, { kind: 'reported', summary: 'Reported from your own message: "We just sent rivera a follow up email."', reference: `Claude message at 2026-09-22T09:00:00.000Z; evidence ${heardId(said.id)}` });
  assert.equal(redact(reported.completion.reference), reported.completion.reference, 'Agent-side redaction leaves the reference readable.');
  assert.deepEqual(reported.evidence.map(row => [row.id, row.summary]), [[heardId(said.id), 'You said this was done: "We just sent rivera a follow up email."']]);
  assert.equal(reported.history.at(-1).actor, 'agent');
  assert.equal(reported.nextStep, 'Email Professor Rivera.');
  await goals.save({ id: saved.id, repoId: 'harbor', status: 'planned', expectedRevision: reported.revision });
  const second = await reconciler.run();
  assert.deepEqual(second, { reported: [], skipped: [{ repoId: 'harbor', goalId: saved.id, reason: 'already-reported' }], errors: [] });
  assert.equal(goals.read('harbor')[0].status, 'planned');
  assert.equal(goals.read('harbor')[0].revision, 3);
});

test('a revert that also removes the reported evidence row still sticks', async t => {
  const clock = { at: Date.parse('2026-09-22T08:00:00.000Z') }, goals = await store(t, clock);
  const [saved] = await goals.save({ repoId: 'harbor', title: RIVERA });
  const said = message(SENT, { at: '2026-09-22T09:00:00.000Z' });
  const reconciler = createCompletionReconciler({ listMessages: async () => [{ repoId: 'harbor', messages: [said] }], readGoals: repoId => goals.read(repoId), saveGoal: (patch, options) => goals.save(patch, options) });
  clock.at = Date.parse('2026-09-22T09:01:00.000Z');
  assert.equal((await reconciler.run()).reported.length, 1);
  const reported = goals.read('harbor')[0];
  clock.at = Date.parse('2026-09-22T10:00:00.000Z');
  await goals.save({ id: saved.id, repoId: 'harbor', status: 'blocked', completion: null, evidence: [], expectedRevision: reported.revision });
  assert.deepEqual(await reconciler.run(), { reported: [], skipped: [], errors: [] });
  assert.deepEqual([goals.read('harbor')[0].status, goals.read('harbor')[0].evidence], ['blocked', []]);
});

test('a stale revision is skipped for the pass and the next goal is still reported', async t => {
  const goals = await store(t);
  const [first] = await goals.save({ repoId: 'harbor', title: RIVERA });
  await goals.save({ repoId: 'harbor', title: 'Submit the conference abstract' });
  const stale = goals.read('harbor');
  await goals.save({ id: first.id, repoId: 'harbor', nextStep: 'Wait for a reply.', expectedRevision: 1 });
  const messages = [message(SENT, { at: '2026-09-22T09:00:00.000Z' }), message('Submitted the conference abstract', { at: '2026-09-22T10:00:00.000Z' })];
  const result = await createCompletionReconciler({ listMessages: async () => [{ repoId: 'harbor', messages }], readGoals: () => stale, saveGoal: (patch, options) => goals.save(patch, options) }).run();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skipped, [{ repoId: 'harbor', goalId: first.id, reason: 'stale-revision' }]);
  assert.deepEqual(result.reported.map(item => item.messageId), [messages[1].id]);
  assert.deepEqual(goals.read('harbor').map(item => item.status), ['planned', 'needs-verification']);
});

test('the reconciler never saves while paused', async () => {
  const saves = [];
  let paused = false, listed = 0;
  const goals = [goal(RIVERA), goal('Submit the conference abstract')];
  const reconciler = createCompletionReconciler({
    listMessages: async () => { listed++; return [{ repoId: 'harbor', messages: [message(SENT), message('Submitted the conference abstract')] }]; },
    readGoals: () => goals, saveGoal: async (patch, options) => { saves.push([patch.id, options.actor]); paused = true; }, isPaused: () => paused,
  });
  const result = await reconciler.run();
  assert.deepEqual(saves, [[goals[0].id, 'agent']]);
  assert.deepEqual(result.skipped, [{ repoId: 'harbor', goalId: goals[1].id, reason: 'paused' }]);
  assert.deepEqual(await reconciler.run(), { reported: [], skipped: [], errors: [] });
  assert.equal(listed, 1, 'A paused run reads nothing.');
});

test('a re-masked message is read again rather than from the earlier parse', async () => {
  const target = goal('Email Rivera'), saves = [];
  let text = 'I emailed [withheld]';
  const reconciler = createCompletionReconciler({ listMessages: async () => [{ repoId: 'harbor', messages: [{ ...message(text, { id: 'm-same' }) }] }], readGoals: () => [target], saveGoal: async patch => { saves.push(patch.id); } });
  assert.deepEqual((await reconciler.run()).reported, []);
  text = 'I emailed Rivera';
  assert.deepEqual((await reconciler.run()).reported.map(item => item.messageId), ['m-same']);
  assert.deepEqual(saves, [target.id]);
});

test('read failures are collected per repository and ambiguous messages are reported as skips', async () => {
  const goals = [goal(RIVERA), goal('Reply to Dana about the pilot'), goal('Submit the conference abstract'), goal('Pay the venue deposit', { repoId: 'lantern' })];
  const saves = [];
  const result = await createCompletionReconciler({
    listMessages: async () => [{ repoId: 'broken', messages: [] }, { repoId: 'harbor', messages: [message('I followed up with rivera, replied to dana and submitted the conference abstract'), message('paid the venue deposit')] }],
    readGoals: repoId => { if (repoId === 'broken') throw new Error('Unreadable.'); return goals; }, saveGoal: async patch => { saves.push(patch.id); },
  }).run();
  assert.deepEqual(result.errors, ['broken: goals could not be read. Unreadable.']);
  assert.deepEqual(result.skipped.map(item => [item.repoId, item.goalId, item.reason]), goals.slice(0, 3).map(item => ['harbor', item.id, 'ambiguous-message']));
  assert.deepEqual(saves, [], 'A goal from another repository is never matched.');
  const failed = await createCompletionReconciler({ listMessages: async () => { throw new Error('Journal closed.'); }, readGoals: () => [], saveGoal: async () => {} }).run();
  assert.deepEqual(failed, { reported: [], skipped: [], errors: ['Recovered messages could not be read. Journal closed.'] });
});

test('concurrent runs are serialized so one message reports once', async t => {
  const goals = await store(t);
  await goals.save({ repoId: 'harbor', title: RIVERA });
  const reconciler = createCompletionReconciler({ listMessages: async () => [{ repoId: 'harbor', messages: [message(SENT, { id: 'm-once', at: '2026-09-22T09:00:00.000Z' })] }], readGoals: repoId => goals.read(repoId), saveGoal: (patch, options) => goals.save(patch, options) });
  const [first, second] = await Promise.all([reconciler.run(), reconciler.run()]);
  assert.equal(first.reported.length + second.reported.length, 1);
  assert.deepEqual([...first.errors, ...second.errors], []);
  assert.equal(goals.read('harbor')[0].evidence.length, 1);
});
