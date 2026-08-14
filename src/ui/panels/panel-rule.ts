import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'

/** Shared inline-panel title rule: `─ title ────…` exactly `width` cols (spec §4.4). */
export function panelRule(title: string, width: number, palette: Palette): string {
  const safe = Math.max(1, width)
  const label = truncateToWidth(`─ ${displayText(title)} `, safe, '…')
  return palette.dim(label + '─'.repeat(Math.max(0, safe - visibleWidth(label))))
}
