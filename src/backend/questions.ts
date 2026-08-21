// src/backend/questions.ts
/** The user-questions provider (spec §3.4). Registration is single-provider;
 * DUPLICATE_PROVIDER is a composition error and propagates loudly. Dismissal
 * rejects with the exact code plan-mode narrows on (Ruling 7). */
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

export function cancelledError(): UserQuestionError {
  return new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
}

export function attachQuestionProvider(
  userQuestions: { registerProvider(p: { ask(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void },
  deps: { present(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> },
): () => void {
  return userQuestions.registerProvider({ ask: (request) => deps.present(request) })
}
