import { describe, expect, it } from 'vitest'
import { ApprovalPanel } from '../src/ui/panels/approval-panel.ts'
import { createPalette } from '../src/theme/palette.ts'

function mount(prompt = {}) {
  const outcomes: string[] = []
  const panel = new ApprovalPanel(
    { toolName: 'bash', preview: 'rm -rf node_modules && pnpm install', reason: 'sandbox escalation', cwd: '/workspace', ...prompt },
    (o) => outcomes.push(o),
    createPalette(false),
  )
  return { panel, outcomes }
}

describe('ApprovalPanel', () => {
  it('renders rule, tool head, meta, and options within width', () => {
    const { panel } = mount()
    const rows = panel.render(44)
    const text = rows.join('\n')
    expect(rows[0]).toBe('')
    expect(text).toContain('─ approval ')
    expect(text).toContain('◇ bash · rm -rf node_modules && pnpm install')
    expect(text).toContain('/workspace · sandbox escalation')
    expect(text).toContain('[1] allow once')
    expect(text).toContain('[2] reject')
    expect(text).toContain('esc cancel')
    for (const row of rows) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(44)
  })
  it('neutralizes hostile tool text at the display boundary (D7.8)', () => {
    const { panel } = mount({ toolName: 'bash\x1b]0;evil\x07', preview: 'echo \x1b[31mred' })
    const text = panel.render(60).join('\n')
    expect(text).toContain('\\x1b]0;evil\\x07')
    expect(text).toContain('echo \\x1b[31mred')
  })
  it('digit keys decide directly', () => {
    const a = mount(); a.panel.handleInput!('1'); expect(a.outcomes).toEqual(['allowed-once'])
    const b = mount(); b.panel.handleInput!('2'); expect(b.outcomes).toEqual(['rejected'])
  })
  it('arrows move the highlight; enter confirms; finish fires once', () => {
    const { panel, outcomes } = mount()
    panel.handleInput!('\x1b[C')   // right → highlight "reject"
    panel.handleInput!('\r')
    panel.handleInput!('\r')
    expect(outcomes).toEqual(['rejected'])
  })
  it('escape cancels', () => {
    const { panel, outcomes } = mount()
    panel.handleInput!('\x1b')
    expect(outcomes).toEqual(['cancelled'])
  })
  it('renders without preview/reason (callId-less requests still prompt)', () => {
    const { panel } = mount({ preview: undefined, reason: undefined })
    const text = panel.render(44).join('\n')
    expect(text).toContain('◇ bash')
    expect(text).toContain('/workspace')
  })
  it('left/up wraps the highlight backward from the first option', () => {
    const { panel, outcomes } = mount()
    panel.handleInput!('\x1b[D')   // left → wraps 0 -> "reject" (last option)
    panel.handleInput!('\r')
    expect(outcomes).toEqual(['rejected'])
  })
  it('down moves the highlight forward; an unrecognized key is a no-op', () => {
    const { panel, outcomes } = mount()
    panel.handleInput!('x')        // unrecognized: no match anywhere, highlight unchanged
    panel.handleInput!('\x1b[B')   // down → highlight "reject"
    panel.handleInput!('\r')
    expect(outcomes).toEqual(['rejected'])
  })
  it('invalidate is a safe no-op (no cached render state)', () => {
    const { panel } = mount()
    expect(() => panel.invalidate()).not.toThrow()
  })
})
