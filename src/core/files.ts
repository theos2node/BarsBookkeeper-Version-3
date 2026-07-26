import { readFile, stat } from 'node:fs/promises'

export const readUtf8FileLimited = async (
  filePath: string,
  field: string,
  maximumBytes = 50 * 1024 * 1024,
): Promise<string> => {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error(`${field}_file_invalid`)
  if (info.size > maximumBytes) throw new Error(`${field}_file_too_large:${info.size}`)
  return readFile(filePath, 'utf8')
}
