/** The approval/request waterfall responder (spec D9): claim only the bound
 * agent's requests by OBJECT IDENTITY (the ACP attribution pattern); pass
 * everything else with next(). Pre-aborted requests answer 'cancelled'
 * before any UI mounts. Presentation rejection is fine: the service
 * normalizes throws to 'unavailable' (fail-closed, verified). */
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

export interface ApprovalRequestLike { agent: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }

export function attachApprovalResponder(
  events: { on(event: string, fn: (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => unknown): () => void },
  deps: {
    isBound(agent: unknown): boolean
    present(req: ApprovalRequestLike): Promise<ApprovalOutcome>
  },
): () => void {
  return events.on('approval/request', (req, next) => {
    if (!deps.isBound(req.agent)) return next()
    if (req.signal?.aborted) return 'cancelled'
    return deps.present(req)
  })
}
