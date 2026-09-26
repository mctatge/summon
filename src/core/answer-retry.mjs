/**
 * The one model failure worth a second request: a Claude or Codex answer that arrived but that Summon's own output
 * check refused. Asking again can change their sampled answer. A login, quota, missing CLI, timeout or bad request
 * would fail the same way again, and the CLIs already retry dropped connections and overloaded APIs before they report
 * an error, so none of those is retried here. The local model decodes deterministically and is never asked twice. The
 * code is set where Summon refuses an answer, never guessed from CLI error text.
 */
export const UNREADABLE_ANSWER = 'UNREADABLE_ANSWER';
const RETRYABLE = new Set([UNREADABLE_ANSWER]);

export const unreadableAnswer = message => Object.assign(new Error(message), { code: UNREADABLE_ANSWER });
export const worthRetrying = error => RETRYABLE.has(error?.code);

/**
 * Asks at most twice. `ask` must include the output check, so a refused answer throws inside it. `ready` confirms the
 * request may still be sent as built; when it returns false the first failure stands and nothing is re-sent.
 */
export async function askAtMostTwice(ask, { ready = async () => true } = {}) {
  try { return await ask(); }
  catch (error) {
    if (!worthRetrying(error) || !(await ready())) throw error;
    return ask();
  }
}
