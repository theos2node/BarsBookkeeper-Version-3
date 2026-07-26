import { describe, expect, it } from 'vitest'
import { escapeBlessedText } from '../src/tui/blessed-text.js'

describe('blessed text rendering', () => {
  it('renders imported markup and terminal controls as inert text', () => {
    const escaped = escapeBlessedText('{red-fg}owned{/red-fg}\u001b[2J')

    expect(escaped).toContain('owned')
    expect(escaped).not.toContain('{red-fg}')
    expect(escaped).not.toContain('\u001b')
  })
})
