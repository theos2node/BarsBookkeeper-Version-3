import { createRequire } from 'node:module'

type PackageMetadata = {
  version: string
}

const require = createRequire(import.meta.url)
const metadata = require('../package.json') as PackageMetadata

export const version = metadata.version
