// src/backend/questions.ts
/** The user-questions answerer (spec §3.4).
 *
 * dsh 0.1.2-alpha.1 replaced the single-provider registration with the SAME
 * scoped Cordis waterfall approvals already use — `ctx.waterfall('user-
 * questions/request', request, next)` — so this now mirrors
 * `attachApprovalResponder` exactly: claim the bound agent's requests by
 * OBJECT IDENTITY, pass everything else on with `next()`, and let an
 * unclaimed request fall through to whatever the service's own fallback is.
 *
 * A request carrying NO agent is the harness asking on nobody's behalf; talon
 * answers it too, since it is the only UI in the process.
 *
 * Dismissal rejects with the exact code plan-mode narrows on (Ruling 7). */
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

export function cancelledError(): UserQuestionError {
  return new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
}

export function attachQuestionProvider(
  events: { on(event: string, fn: (req: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => unknown): () => void },
  deps: {
    isBound(agent: unknown): boolean
    present(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  },
): () => void {
  return events.on('user-questions/request', (request, next) => {
    // An agent-less request belongs to no session in particular; the one UI in
    // the process is the right answerer for it.
    if (request.agent !== undefined && !deps.isBound(request.agent)) return next()
    if (request.signal?.aborted) return next()
    return deps.present(request)
  })
}
