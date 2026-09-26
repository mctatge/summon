// A bounded, local description of the user's request. This makes no network call and does not execute or obey
// instructions found in the text. Unknown requests get standard effort; length by itself is never complexity.
const MAX_TASK_CHARS=12000;
const KIND_RULES=[
  ['coding',/\b(?:debug|debugging|refactor|implement|implementation|code|codebase|repository|pull request|unit tests?|integration tests?|stack trace|compiler|typescript|javascript|python|sql|api endpoint|function|bug|coding|race condition|deadlock|distributed[- ]systems?)\b/, 'The request includes a code or debugging task.'],
  ['writing',/\b(?:write|draft|rewrite|proofread|copyedit|edit|email|essay|blog|article|wording|tone|grammar|translate|translation|summari[sz]e|summary)\b/, 'The request includes writing or editing.'],
  ['research',/\b(?:research|investigate|look up|find sources|check sources|fact.check|literature review|compare|comparison|latest|evidence|citations?)\b/, 'The request includes research or comparison.'],
  ['reasoning',/\b(?:prove|proof|derive|derivation|solve|equation|calculate|reason through|trade.?offs?|optimi[sz]e|plan|planning|analy[sz]e|analysis|explain)\b/, 'The request includes analysis or explanation.'],
];
const COMPLEX=/\b(?:complex|complicated|comprehensive|in.depth|rigorous|multi.step|architecture|architectural|migration|root cause|race condition|deadlock|distributed[- ]systems?|end.to.end|across (?:multiple|several)|multiple (?:systems|services|repositories)|formal proof)\b/;
const QUICK=/\b(?:quick (?:question|answer|fix|edit)|brief(?:ly)?|concise|short answer|one (?:sentence|line)|single (?:sentence|line)|simple|small (?:fix|change|edit)|typo|spelling|define)\b/;
const EFFORT={quick:'low',standard:'medium',complex:'high'};

function instructionText(value){
  if(typeof value!=='string')return '';
  return value.slice(0,MAX_TASK_CHARS).normalize('NFKC').toLowerCase()
    // Quoted examples and source excerpts do not get to declare the request's task type or effort.
    .replace(/```[\s\S]*?(?:```|$)/g,' ')
    .replace(/^\s*>.*$/gm,' ')
    .replace(/`[^`]*`/g,' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g,' ')
    .replace(/(^|[\s(])'[^'\n]*'(?=$|[\s.,!?;)])/g,'$1 ')
    .replace(/\b(?:not|isn't|isn’t|is not)\s+(?:a\s+)?(?:complex|complicated|simple)\b/g,' ');
}

export function classifyTask(text){
  const request=instructionText(text);
  const matched=KIND_RULES.find(([,pattern])=>pattern.test(request));
  const kind=matched?.[0]??'general';
  const complexity=COMPLEX.test(request)?'complex':QUICK.test(request)?'quick':'standard';
  const reason=matched?.[2]??'The request has no clear task category.';
  const effortReason=complexity==='complex'?'Explicit scope calls for deeper work.':complexity==='quick'?'The request explicitly asks for a small or brief task.':'There is no clear signal to raise or lower effort.';
  return {kind,complexity,effort:EFFORT[complexity],reason:`${reason} ${effortReason}`};
}
