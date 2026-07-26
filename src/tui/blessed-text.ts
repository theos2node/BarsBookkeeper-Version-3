import blessed from 'blessed'
import { stripVTControlCharacters } from 'node:util'

export const escapeBlessedText = (value: unknown): string =>
  blessed.escape(
    Array.from(stripVTControlCharacters(String(value ?? '')))
      .filter((character) => {
        const code = character.charCodeAt(0)
        return character === '\n' || character === '\t' || (code >= 32 && (code < 127 || code > 159))
      })
      .join(''),
  )
