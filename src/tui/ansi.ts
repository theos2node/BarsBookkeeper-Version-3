const enabled =
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb'

const code = (open: number, close: number) => (value: string): string =>
  enabled ? `\u001b[${open}m${value}\u001b[${close}m` : value

export const ansi = {
  enabled,
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  magenta: code(35, 39),
  cyan: code(36, 39),
  gray: code(90, 39),
}

