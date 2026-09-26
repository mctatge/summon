import { createHash } from 'node:crypto';

// Only the user's own words can report a goal finished, and only as needs-verification; the user still confirms.
export const OPEN_STATUSES = Object.freeze(['planned', 'working', 'blocked']);
const EVIDENCE_LIMIT = 40;
const IGNORED = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'to', 'for', 'of', 'on', 'in', 'at', 'by', 'from', 'into', 'onto', 'about', 'with', 'without', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'it', 'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their', 'his', 'her', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'us', 'them', 'so', 'up', 'out', 'off', 'all', 'any', 'some', 'again', 'back', 'via', 'vs', 'per', 're', 'do', 'get', 'set',
  'follow', 'followup', 'send', 'email', 'mail', 'reply', 'message', 'update', 'fix', 'make', 'add', 'review', 'prepare', 'draft', 'finish', 'complete', 'submit', 'ship', 'write', 'professor', 'prof', 'dr', 'mr', 'ms', 'mrs', 'team', 'project', 'work', 'item', 'task', 'goal', 'new', 'first', 'second', 'next']);
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'on', 'in', 'at', 'by', 'from', 'with', 'it', 'its', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their', 'his', 'her', 'all', 'everything']);
const PERSONS = new Set(['i', 'we', 'you', 'he', 'she', 'they', 'me', 'us', 'him', 'her', 'them']);
const table = entries => new Map(Object.entries(entries).map(([key, value]) => [key, value.split(' ')]));
// A finished verb names the kinds of work it can finish; the title's leading verb decides which kinds count.
const KINDS = table({ sent: 'contact send', emailed: 'contact send', mailed: 'contact send', forwarded: 'contact send', texted: 'contact', messaged: 'contact', pinged: 'contact', nudged: 'contact', contacted: 'contact',
  'reached out': 'contact', 'followed up': 'contact', replied: 'contact', responded: 'contact', submitted: 'submit', 'turned in': 'submit', 'handed in': 'submit', filed: 'submit', uploaded: 'submit send',
  delivered: 'deliver send', shipped: 'ship', merged: 'ship', released: 'ship', launched: 'ship', published: 'ship', posted: 'ship submit', deployed: 'ship', live: 'ship', paid: 'pay', booked: 'book', scheduled: 'book',
  reserved: 'book', signed: 'sign', finished: 'generic', completed: 'generic', complete: 'generic', done: 'generic', 'wrapped up': 'generic', handled: 'generic', 'taken care of': 'generic', 'out the door': 'generic', 'went out': 'contact send' });
const FAMILIES = new Map([...table({ contact: 'follow followup email mail message text reply respond ping nudge chase contact reach', call: 'call phone ring', send: 'send forward share deliver', submit: 'submit file upload turn hand apply',
  ship: 'ship merge release launch publish deploy post push', pay: 'pay', book: 'book schedule reserve', sign: 'sign',
  generic: 'review fix make add update prepare draft write finish complete do get build read test clean implement create design plan research study organize set wrap' })].flatMap(([family, verbs]) => verbs.map(verb => [verb, family])));
const ACCEPTS = table({ contact: 'contact generic', call: 'generic', send: 'send submit deliver ship generic', submit: 'submit send deliver ship generic', ship: 'ship deliver generic', pay: 'pay generic', book: 'book generic',
  sign: 'sign generic', generic: 'generic ship submit deliver', noun: 'generic ship submit deliver pay book sign' });
const ADVERB = '(?:just|already|finally|also|actually|now|officially|successfully|then|both|all|literally|went ahead and)';
const FILLER = '(?:ok|okay|so|well|yes|yeah|yep|yup|alright|all right|and|fyi|btw|update|good news|great|cool|hey|oh|today|yesterday|this morning|this afternoon|this evening|last night|earlier)';
const LABEL = '(?:done|update|updates|fyi|btw|news|good news|ok|okay|progress)';
const PAST = '(?<verb>sent|e-?mailed|mailed|forwarded|texted|messaged|pinged|nudged|contacted|reached out|followed up|replied|responded|submitted|turned in|handed in|filed(?! away\\b)|uploaded|delivered|shipped|merged(?! pull request\\b)|released|launched|published(?! (?:works?|papers?|research|articles?|by)\\b)|posted|deployed|paid(?! attention\\b)|booked|scheduled|reserved|signed(?! (?:up|off|out|in|on)\\b)|wrapped up|(?:finished|completed|done)(?! \\w{2,}ing\\b)(?! (?:with|of|for)\\b))';
// Quantifiers stay bounded so a repeated filler word cannot make matching exponential.
const FIRST = new RegExp(`\\b(?:i|we)(?:'ve|ve| have| had)?(?: ${ADVERB}){0,3} ${PAST}\\b`, 'g');
const LEAD = new RegExp(`^(?:[-*\\u2022\\u2713\\u2714\\u2705\\u2611] ?){0,3}(?:\\[x\\] ?)?(?:${LABEL} ?(?::|[\\u2013\\u2014]|-) ?)?(?:${FILLER}\\b[ ,!]*){0,4}(?:${ADVERB} ){0,3}${PAST}\\b(?! ?[:,])`);
const AND = new RegExp(`(?:, ?(?:and |then |and then )?| (?:and|then|and then) )(?:${ADVERB} ){0,3}${PAST}\\b(?! ?[:,])`, 'g');
const HINT = /\b(?:sent|e-?mailed|mailed|forwarded|texted|messaged|pinged|nudged|contacted|reached|followed|replied|responded|submitted|turned|handed|filed|uploaded|delivered|shipped|merged|released|launched|published|posted|deployed|paid|booked|scheduled|reserved|signed|wrapped|finished|completed|complete|done|live|handled|taken|out)\b/;
const STATE = new RegExp(`\\b(?:is|are|was|were|has been|have been|had been|got)(?: ${ADVERB}){0,3} (?<state>sent|submitted|shipped|merged|published|posted|filed|delivered|uploaded|signed|paid|booked|scheduled|released|launched|deployed|live|handled|taken care of|wrapped up|out the door|done|finished|complete|completed)\\b(?! (?:with|of|for|by)\\b)(?! \\w{2,}ing\\b)|\\b(?:went|has gone|have gone|had gone) out\\b(?! (?:of|for|with|sick|to (?:lunch|dinner|eat))\\b)`, 'g');
const HEDGES = ['might', 'may', 'maybe', 'will', 'would', 'should', 'could', 'can', 'cannot', 'shall', 'must', 'going to', 'gonna', 'gotta', 'wanna', 'plan to', 'plans to', 'planning to', 'planned to', 'want to', 'wants to', 'wanted to',
  'need to', 'needs to', 'needed to', 'have to', 'has to', 'had to', 'got to', 'about to', 'try to', 'trying to', 'tried to', 'hope', 'hoping', 'hoped', 'wish', 'if', 'whether', 'unless', 'until', 'once', 'when', 'remind me', 'remind us', 'reminder to',
  'not', 'never', 'nothing', 'none', 'nobody', 'neither', 'nor', 'without', 'almost', 'nearly', 'partially', 'partly', 'mostly', 'half', 'think', 'thinks', 'thought', 'guess', 'believe', 'probably', 'perhaps', 'possibly',
  'suppose', 'supposed', 'assume', 'assuming', 'imagine', 'pretend', 'hypothetically', 'forgot', 'forget', 'please', "let's", 'lets', 'let me', 'tomorrow', 'tonight', 'soon', 'didnt', 'dont', 'doesnt', 'havent', 'hasnt', 'hadnt',
  'isnt', 'arent', 'wasnt', 'werent', 'wont', 'cant', 'couldnt', 'shouldnt', 'wouldnt', 'aint', 'say', 'said', 'says', 'saying', 'claim', 'claims', 'claimed', 'claiming', 'tell', 'told', 'telling', 'write', 'wrote', 'writes',
  'every', 'each', 'usually', 'always', 'often', 'sometimes', 'weekly', 'daily', 'monthly', 'next', 'later', 'still', 'todo', 'to do', 'to-do', 'pending', 'remaining', 'waiting', 'jk', 'lol', 'lmao', 'kidding', 'zero', 'nvm', 'wait', 'unsure',
  'yeah right', 'oh sure', 'as if', 'in my dreams', 'ago', 'last time', 'last week', 'last month', 'last year', 'last semester', 'last term', 'back in', 'used to', 'every time', 'the other day', 'earlier this week', 'earlier this month',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const HEDGE = new RegExp(`\\b(?:${HEDGES.join('|')})\\b|\\byet\\b(?! again\\b)|\\bon the \\d{1,2}(?:st|nd|rd|th)\\b|\\bno\\b(?![,!]| (?:reply|response|answer|word) )|n't\\b|'ll\\b|\\b(?:i|we|you|he|she|they|it|that)'d\\b`, 'g');
const QUESTION = /^(?:(?:ok|okay|so|and|but|also|hey|btw)\b[ ,]*){0,3}(?:why|what|when|where|who|whom|whose|which|how|did|do|does|is|are|was|were|has|have|had|can|could|should|would|will|shall|am)\b/;
const ASK_TAIL = /, ?(?=(?:what|whats|why|how|when|where|who|which|can you|could you|would you|will you|should i|should we|do you|is there|is it|any (?:ideas?|thoughts|suggestions|advice)|thoughts|now what|so what|then what)\b)/;
const RETRACT = /^(?:not|nope|jk|j\/k|just kidding|kidding|nvm|never mind|in my dreams|yeah right|as if|wait|actually no|scratch that|lol no)\b/;
const CODE = /[{}]|=>|==|<\/|\/>|\(\)/;
// A request to write a message, or a pasted letter, is drafting text rather than reporting what happened.
const WRITING = /\bhelp me (?:write|draft|word|phrase|reply|respond|compose|polish|reword)\b|\b(?:polish|reword|rephrase|proofread)\b|\b(?:write|draft|compose|rewrite|revise) (?:(?:a|an|the|my|our|this|that|me|him|her|them|up|back) ){0,3}(?:[\p{L}-]+ )?(?:email|e-mail|message|reply|response|note|letter|follow[- ]?up|followup|text|dm|draft)\b|\bwhat (?:should|do|would|could) (?:i|we|it|(?:the|my) [\p{L}-]+) say\b|\bhow (?:should|do|would) i (?:word|phrase|say|reply|respond)\b/u;
const GREETING = /(?:^|[.!?] )(?:dear|hi|hello) (?:(?:prof|professor|dr|mr|mrs|ms)\.? )?[\p{L}'-]+(?: [\p{L}'-]+)? ?,/u;
const SIGN_OFF = /(?:^|[\s.!?,])(?:[Bb]est|[Rr]egards|[Ss]incerely|[Cc]heers|[Ww]armly|[Tt]hanks)\s*,\s*(?!I\b)\p{Lu}\p{Ll}+(?:\s*[.!]?\s*$|\s*[.!]\s)/u;
const SPLIT = / ?; ?| (?=(?:todo|to do|to-do|next|next up|up next|later|pending|remaining|left|tomorrow|blocked|waiting|done|update|fyi|btw) ?:)| (?:[-*\u2022\u2013\u2014]|\d{1,2}[.)]) /g;
const LATER = /^(?:todo|to do|to-do|next|next up|up next|later|pending|remaining|left|tomorrow|blocked|waiting) ?:/;
const DONE_LABEL = /^(?:done|update|updates|fyi|btw|news|progress) ?:/;
const LABEL_ONLY = /^(?:(?:ok|okay|so|well|yes|yeah|yep|yup|alright|all right|and|fyi|btw|update|updates|good news|news|great|cool|hey|oh|today|yesterday|this morning|this afternoon|this evening|last night|earlier|done|progress)\b[ ,!:]*){1,6}$/;
const TO_VERBS = 'schedule|reschedule|send|email|ask|set|get|make|see|check|confirm|discuss|share|book|submit|review|follow|request|remind|invite|let|tell|say|update|finish|plan|talk|meet|arrange|explain|find|introduce|propose|thank|clarify|reply|respond|pay|sign|file|fix|merge|ship|help|give|show|start|keep|move|cancel|change|add|write|prepare|draft|call|apply|register|order|buy';
const CUT = new RegExp(`[,;:()\\[\\]{}]| [-\\u2013\\u2014] |\\b(?:and|but|or|so|then|now|while|because|since|after|before|until|from|for|on|with|by|that|which|who|whose|where|when|though|although|unless|except|plus|about|regarding|concerning|re|asking|mentioning|in order to|to (?:${TO_VERBS}))\\b`);
const NP_CUT = /^.*(?:[,;:()[\]{}]| [-\u2013\u2014] |\b(?:and|but|or|so|then|now|because|since|while|after|before|though|although|when|once)\b)/;
const TOPIC = /\b(?:about|regarding|concerning|re|asking|mentioning)\b/;
const TITLE_CUT = /\b(?:about|regarding|concerning|re|by|before|until|due|asap|tomorrow|today|tonight)\b/;
const AUX = /\b(?:is|are|was|were|am|be|been|being|has|have|had|does|did|shows?|says?|seems?|looks?|means?|needs?|wants?|remains?|exceeds?|fails?|failed|goes|gets)\b/;
const MARKER = /\bfollow(?:ed)?[- ]?ups?\b|\bfollowups?\b|\bagain\b|\brepl(?:ied|y)\b|\brespon(?:ded|se)\b|\bnudge[ds]?\b|\bping(?:ed)?\b|\breminder\b|\bchased\b/;
const PURPOSE = /^ ?(?:to|as) (?:a )?(?:follow[- ]?up|followup|reminder|nudge)\b/;
const DETERMINER = /^(?:the|my|our|your|his|her|their|its|this|that|these|those)\b|\b(?:the|my|our|your|his|her|their|its|these|those)\b/;
const ABBREVIATION = /(?:^|[\s(])(?:dr|mr|mrs|ms|prof|st|vs|etc|e\.g|i\.e|\p{L})$/iu;
const display = value => value.normalize('NFC').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
const normal = value => value.toLowerCase().replace(/\s+/g, ' ').trim();
const clip = (value, max) => { if (value.length <= max) return value; const cut = value.slice(0, max - 1); return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}…`; };
const stem = word => word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y` : /(?:x|z|ch|sh|ss)es$/.test(word) ? word.slice(0, -2)
  : word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
const evidenceIdFor = messageId => `heard-${createHash('sha256').update(messageId).digest('hex').slice(0, 16)}`;

// Hyphenated compounds stay one word; a possessor ("rivera's lecture") is kept apart from what was acted on.
function words(value) {
  const text = normal(value).replace(/([\p{L}\p{N}])[-\u2010\u2011](?=[\p{L}\p{N}])/gu, '$1');
  const owners = new Set([...text.matchAll(/([\p{L}\p{N}]+)'s\b/gu)].map(match => stem(match[1])));
  const plain = new Set(text.replace(/[\p{L}\p{N}]+'s\b/gu, ' ').replace(/'/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem));
  return { plain, owners };
}

function shapeOf(title) {
  if (typeof title !== 'string') return null;
  const shown = display(title), lower = normal(shown);
  const first = (lower.match(/^[\p{L}-]+/u)?.[0] ?? '').replace(/-/g, ''), family = FAMILIES.get(first) ?? null;
  const followUp = /\bfollow[- ]?up\b|\bfollowup\b|^(?:reply|respond|ping|nudge|chase)\b/.test(lower);
  const useful = word => !IGNORED.has(word) && !(family && word === first) && (word.length > 1 || /\d/.test(word));
  const pick = text => { const { plain, owners } = words(text); return { plain: [...plain].filter(useful), owners: [...owners].filter(useful) }; };
  const cut = lower.search(TITLE_CUT);
  let parts = pick(cut > 0 ? lower.slice(0, cut) : lower);
  if (!parts.plain.length && !parts.owners.length) parts = pick(lower);
  const all = new Set([...parts.plain, ...parts.owners]);
  if (!all.size) return null;
  const names = new Set(shown.split(/\s+/).slice(1).filter(word => /^\p{Lu}\p{Ll}/u.test(word)).flatMap(word => { const { plain, owners } = words(word); return [...plain, ...owners]; }).filter(word => all.has(word)));
  const others = [...all].filter(word => !/\d/.test(word));
  return { all, owners: new Set(parts.owners), names, followUp, numbers: [...all].filter(word => /\d/.test(word)), others, need: others.length >= 3 ? 2 : others.length,
    accepts: new Set([...ACCEPTS.get(family ?? 'noun'), ...(followUp ? ['contact'] : [])]) };
}

function reopenedAt(goal) {
  const history = Array.isArray(goal.history) ? goal.history : [];
  let at = -Infinity;
  // The user's own reopening (a revert from a report, or from done or deferred) outranks anything said before it.
  for (let index = 1; index < history.length; index++) {
    const entry = history[index];
    if (entry?.actor === 'user' && OPEN_STATUSES.includes(entry.status) && history[index - 1] && !OPEN_STATUSES.includes(history[index - 1].status)) at = Math.max(at, Date.parse(entry.at) || -Infinity);
  }
  return at;
}

function sentences(text) {
  const found = [];
  let start = 0;
  const push = end => { const slice = text.slice(start, end); if (slice.trim()) found.push({ text: slice.replace(/\s+/g, ' ').trim(), start, end }); start = end; };
  for (const mark of text.matchAll(/[.!?\u2026]+(?=[\s"')\]]|$)|[\r\n]+/g)) {
    if (mark[0] === '.' && ABBREVIATION.test(text.slice(start, mark.index))) continue;
    push(mark.index + mark[0].length);
  }
  push(text.length);
  return found;
}

function quotedRanges(text) {
  const ranges = [...text.matchAll(/"[^"]*"?|`[^`]*`?/g)].map(match => [match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])'(?=\p{L})/gu)) {
    const close = text.slice(match.index + 1).search(/'(?![\p{L}\p{N}])/u);
    ranges.push([match.index, close < 0 ? text.length : match.index + close + 2]);
  }
  return ranges;
}

// The words an action names end at the next clause joiner, preposition or purpose ("to schedule"), except a preposition right after the verb.
function objectSpan(rest) {
  const lead = rest.match(/^ (?:with|on|for)\b/)?.[0].length ?? 0, cut = rest.slice(lead).search(CUT);
  return cut < 0 ? rest : rest.slice(0, lead + cut);
}

function nounPhrase(before) {
  let text = before.replace(NP_CUT, '').trim();
  const topic = text.search(TOPIC);
  if (topic >= 0) text = text.slice(0, topic).trim();
  if (!text || PERSONS.has(text.split(' ').pop()) || / (?:that|which|who|whom)\b/.test(text)) return null;
  const { plain, owners } = words(text);
  return { text, plain, owners, det: DETERMINER.test(text), content: [...plain].filter(word => !STOP.has(word)) };
}

function actionsOf(clause, subjectless) {
  const found = [], led = [];
  const act = (verb, rest) => {
    const span = objectSpan(rest);
    if (AUX.test(span)) return;
    const purpose = rest.slice(span.length).match(PURPOSE)?.[0] ?? '';
    found.push({ kinds: KINDS.get(verb.replace('e-mailed', 'emailed')) ?? [], marker: MARKER.test(`${verb} ${span}${purpose}`), np: null, ...words(span) });
  };
  for (const match of clause.matchAll(FIRST)) { led.push(match.index); act(match.groups.verb, clause.slice(match.index + match[0].length)); }
  const start = subjectless ? clause.match(LEAD) : null;
  if (start) { led.push(0); act(start.groups.verb, clause.slice(start[0].length)); }
  // "I emailed Rivera and replied to Dana": a verb joined to the user's own action shares its subject.
  for (const match of clause.matchAll(AND)) if (led.some(index => index < match.index)) act(match.groups.verb, clause.slice(match.index + match[0].length));
  for (const match of clause.matchAll(STATE)) {
    const np = nounPhrase(clause.slice(0, match.index));
    if (!np) continue;
    const rest = clause.slice(match.index + match[0].length), after = !match.groups.state && rest.startsWith(' to ') ? objectSpan(rest) : '';
    const tail = words(after);
    found.push({ kinds: KINDS.get(match.groups.state ?? 'went out'), marker: MARKER.test(`${np.text} ${after}`), np,
      plain: new Set([...np.plain, ...tail.plain]), owners: new Set([...np.owners, ...tail.owners]) });
  }
  return { actions: found, led: led.length > 0 };
}

// Each clause keeps the sentence it came from; a question, quote, to-do section, code or retraction removes it.
function statements(message) {
  const text = display(message.text), lower = normal(text);
  if (!HINT.test(lower) || WRITING.test(lower) || GREETING.test(lower) || SIGN_OFF.test(text)) return { terms: new Set(), pieces: [] };
  const quoted = quotedRanges(text), all = sentences(text), pieces = [];
  if (message.truncated || message.text.length >= 999) all.pop();
  for (const sentence of all) {
    const blocked = quoted.some(([from, to]) => from < sentence.end && to > sentence.start);
    const clause = normal(sentence.text), tail = clause.search(ASK_TAIL);
    const head = tail >= 0 ? clause.slice(0, tail) : /\?[\s"')\]]*$/.test(clause) ? '' : clause;
    let from = 0, separator = 'start', previous = null, later = false;
    // A list item may drop its subject only after a label ("Done:"), another of the user's own items, or at the start.
    for (const cut of head ? [...head.matchAll(SPLIT), null] : []) {
      const part = head.slice(from, cut ? cut.index : head.length).trim();
      const subjectless = separator !== 'list' || !previous || previous.text.endsWith(':') || LABEL_ONLY.test(previous.text) || (previous.led && !previous.vetoed);
      const vetoed = !part || QUESTION.test(part) || CODE.test(part), hedges = vetoed ? [] : [...part.matchAll(HEDGE)].map(match => match[0]);
      const { actions, led } = vetoed ? { actions: [], led: false } : actionsOf(part, subjectless);
      later = LATER.test(part) || (!DONE_LABEL.test(part) && (part.endsWith(':') ? hedges.length > 0 : later));
      previous = { text: part, quote: clip(sentence.text, 300), hedges, actions, led, vetoed: vetoed || blocked || later || hedges.some(hedge => !/^\p{L}+$/u.test(hedge)) };
      pieces.push(previous);
      if (cut) { from = cut.index + cut[0].length; separator = cut[0].includes(';') || !cut[0].trim() ? 'start' : 'list'; }
    }
    if (head !== clause) pieces.push({ text: clause.slice(Math.max(tail, 0)), vetoed: true, actions: [] });
  }
  const kept = pieces.filter((piece, index) => !piece.vetoed && piece.actions.length && !RETRACT.test(pieces[index + 1]?.text ?? ''))
    .map(({ quote, hedges, actions }) => ({ quote, hedges, actions }));
  return { terms: new Set(kept.flatMap(piece => piece.actions.flatMap(action => [...action.plain, ...action.owners]))), pieces: kept };
}

function heardIn(action, shape) {
  if (!action.kinds.some(kind => shape.accepts.has(kind)) || (shape.followUp && !action.marker)) return false;
  const has = word => action.plain.has(word) || (shape.owners.has(word) && action.owners.has(word));
  if (!shape.numbers.every(has) || shape.others.filter(has).length < shape.need) return false;
  // A finished state needs a thing as its subject: "the follow-up went out", never a bare name ("Rivera is done").
  return !action.np || action.np.det || (action.np.content.length >= 2 && !action.np.content.every(word => shape.names.has(word)));
}

function reconcile({ goals, messages }, parse = statements) {
  const wanted = (Array.isArray(goals) ? goals : []).filter(goal => goal && OPEN_STATUSES.includes(goal.status) && Number.isFinite(Date.parse(goal.createdAt)))
    .map(goal => ({ goal, shape: shapeOf(goal.title), after: Math.max(Date.parse(goal.createdAt), reopenedAt(goal)) })).filter(item => item.shape);
  const heard = (Array.isArray(messages) ? messages : []).map((message, index) => ({ message, index, at: Date.parse(message?.at) }))
    .filter(({ message, at }) => message && (message.role === undefined || message.role === 'user') && typeof message.id === 'string' && message.id && typeof message.text === 'string' && Number.isFinite(at))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  const matches = [], skipped = [], reported = new Set();
  const skip = (goalId, reason) => { if (!skipped.some(item => item.goalId === goalId && item.reason === reason)) skipped.push({ goalId, reason }); };
  for (const { message, at } of heard) {
    const candidates = wanted.filter(item => at > item.after);
    if (!candidates.length) continue;
    const { terms, pieces } = parse(message);
    const hits = candidates.flatMap(({ goal, shape }) => {
      if (!shape.numbers.every(word => terms.has(word)) || shape.others.filter(word => terms.has(word)).length < shape.need) return [];
      const piece = pieces.find(item => item.hedges.every(hedge => shape.all.has(hedge)) && item.actions.some(action => heardIn(action, shape)));
      return piece ? [{ goal, piece }] : [];
    });
    if (hits.length >= 3) { for (const { goal } of hits) skip(goal.id, 'ambiguous-message'); continue; }
    const evidenceId = evidenceIdFor(message.id);
    for (const { goal, piece } of hits) {
      if (reported.has(goal.id)) continue;
      if ((goal.evidence ?? []).some(row => row?.id === evidenceId)) { skip(goal.id, 'already-reported'); continue; }
      reported.add(goal.id);
      matches.push({ goalId: goal.id, repoId: goal.repoId, expectedRevision: goal.revision, evidenceId, messageId: message.id, quote: piece.quote, at: message.at, provider: message.provider, sessionKey: message.sessionKey });
    }
  }
  return { matches, skipped: skipped.filter(item => !reported.has(item.goalId)) };
}

export function findReportedCompletions({ goals, messages } = {}) {
  return reconcile({ goals, messages }).matches;
}

export function completionPatch(goal, match) {
  const evidence = goal?.evidence ?? [];
  if (!goal || !match || !OPEN_STATUSES.includes(goal.status) || evidence.length >= EVIDENCE_LIMIT || evidence.some(row => row?.id === match.evidenceId)) return null;
  // Session and message ids would be redacted for agents; time plus evidence id survives masking.
  const source = { claude: 'Claude', codex: 'Codex' }[match.provider] ?? 'Recovered';
  const reference = clip(`${source} message at ${match.at}; evidence ${match.evidenceId}`, 1000);
  return { id: goal.id, repoId: goal.repoId, expectedRevision: match.expectedRevision, status: 'needs-verification',
    completion: { kind: 'reported', summary: `Reported from your own message: "${match.quote}"`, reference },
    evidence: [...evidence, { id: match.evidenceId, summary: `You said this was done: "${match.quote}"`, reference }] };
}

export function createCompletionReconciler({ listMessages, readGoals, saveGoal, isPaused = () => false } = {}) {
  if (typeof listMessages !== 'function' || typeof readGoals !== 'function' || typeof saveGoal !== 'function') throw new Error('Completion reports need recovered messages and the goal store.');
  const paused = () => { try { return Boolean(isPaused()); } catch { return true; } };
  const failure = error => error?.message ?? String(error);
  // Parsed clauses are kept per message while the journal still holds it, so each pass reparses only new or re-masked text.
  const parsed = new Map();
  let queue = Promise.resolve();
  async function pass() {
    const result = { reported: [], skipped: [], errors: [] }, seen = new Set();
    if (paused()) return result;
    const parse = message => {
      seen.add(message.id);
      const known = parsed.get(message.id), truncated = Boolean(message.truncated);
      if (known?.text === message.text && known.truncated === truncated) return known.statements;
      const found = statements(message);
      parsed.set(message.id, { text: message.text, truncated, statements: found });
      return found;
    };
    let projects;
    try { projects = await listMessages(); } catch (error) { result.errors.push(`Recovered messages could not be read. ${failure(error)}`); return result; }
    for (const project of Array.isArray(projects) ? projects : []) {
      const repoId = project?.repoId;
      let goals;
      try { goals = await readGoals(repoId); } catch (error) { result.errors.push(`${repoId}: goals could not be read. ${failure(error)}`); continue; }
      const own = (Array.isArray(goals) ? goals : []).filter(goal => goal?.repoId === repoId);
      const { matches, skipped } = reconcile({ goals: own, messages: project?.messages }, parse);
      result.skipped.push(...skipped.map(item => ({ repoId, ...item })));
      for (const match of matches) {
        const patch = completionPatch(own.find(goal => goal.id === match.goalId), match);
        if (!patch) { result.skipped.push({ repoId, goalId: match.goalId, reason: 'evidence-full' }); continue; }
        if (paused()) { result.skipped.push({ repoId, goalId: match.goalId, reason: 'paused' }); continue; }
        try { await saveGoal(patch, { actor: 'agent' }); result.reported.push({ repoId, goalId: match.goalId, messageId: match.messageId }); }
        catch (error) {
          // A goal edited between the read and the save is simply reconsidered on the next pass.
          if (/changed since you read it/.test(failure(error))) result.skipped.push({ repoId, goalId: match.goalId, reason: 'stale-revision' });
          else result.errors.push(`${repoId}/${match.goalId}: ${failure(error)}`);
        }
      }
    }
    for (const id of parsed.keys()) if (!seen.has(id)) parsed.delete(id);
    return result;
  }
  function run() { const result = queue.then(pass); queue = result.catch(() => {}); return result; }
  return { run };
}
