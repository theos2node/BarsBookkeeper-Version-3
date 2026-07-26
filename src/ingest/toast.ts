import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { AppConfig } from '../config.js'
import { boundedText } from '../core/validation.js'
import { openDatabase, type Db } from '../db/database.js'
import { migrateDatabase } from '../db/migrations.js'
import { ingestToastSales, type IngestResult, type ToastSalesRow } from './index.js'
import { parseJsonOrCsv } from './csv.js'

type ToastConfig = {
  apiHost: string
  authPath: string
  salesPath: string
  startParam: string
  endParam: string
  restaurantExternalIds: string[]
  apiKeyHeader: string
  apiKeyPrefix: string
  clientId?: string
  clientSecret?: string
  apiKey?: string
}

type SavedToastConfig = Omit<ToastConfig, 'clientSecret' | 'apiKey'>

export type ToastPullResult = {
  configured: boolean
  restaurants: number
  failedRestaurants: number
  failures: Array<{ restaurantExternalId: string; error: string }>
  rowsPulled: number
  ingest: IngestResult
  source: 'file' | 'api'
}

type ToastPullOptions = {
  maxRetries: number
  retryDelayMs: number
}

const baseToastConfig = (): SavedToastConfig => ({
  apiHost: 'https://ws-api.toasttab.com',
  authPath: '/authentication/v1/authentication/login',
  salesPath: '/orders/v2/ordersBulk',
  startParam: 'startDate',
  endParam: 'endDate',
  restaurantExternalIds: [],
  apiKeyHeader: 'Authorization',
  apiKeyPrefix: 'Bearer ',
})

const splitCsv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const argValue = (args: string[], name: string): string | undefined => {
  const flag = `--${name}`
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return undefined
}

const numberArg = (args: string[], name: string, fallback: number): number => {
  const value = argValue(args, name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const configPath = (config: AppConfig): string => resolve(config.dataDir, 'toast-config.json')

const readSavedConfig = async (config: AppConfig): Promise<Partial<SavedToastConfig>> => {
  try {
    const parsed = JSON.parse(await readFile(configPath(config), 'utf8')) as Record<string, unknown>
    return {
      apiHost: typeof parsed.apiHost === 'string' ? parsed.apiHost : undefined,
      authPath: typeof parsed.authPath === 'string' ? parsed.authPath : undefined,
      salesPath: typeof parsed.salesPath === 'string' ? parsed.salesPath : undefined,
      startParam: typeof parsed.startParam === 'string' ? parsed.startParam : undefined,
      endParam: typeof parsed.endParam === 'string' ? parsed.endParam : undefined,
      restaurantExternalIds: Array.isArray(parsed.restaurantExternalIds)
        ? parsed.restaurantExternalIds.filter((item): item is string => typeof item === 'string')
        : undefined,
      apiKeyHeader: typeof parsed.apiKeyHeader === 'string' ? parsed.apiKeyHeader : undefined,
      apiKeyPrefix: typeof parsed.apiKeyPrefix === 'string' ? parsed.apiKeyPrefix : undefined,
      clientId: typeof parsed.clientId === 'string' ? parsed.clientId : undefined,
    }
  } catch {
    return {}
  }
}

const secretFromFile = async (pathValue: string | undefined, field: string): Promise<string | undefined> => {
  if (!pathValue) return undefined
  const path = isAbsolute(pathValue) ? pathValue : resolve(pathValue)
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${field}_file_invalid`)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(`${field}_file_permissions_must_be_0600`)
  }
  return boundedText((await readFile(path, 'utf8')).trim(), field, { required: true, maxLength: 16_384 })
}

const environmentSecret = async (value: string | undefined, file: string | undefined, field: string): Promise<string | undefined> =>
  value ? boundedText(value, field, { required: true, maxLength: 16_384 }) : secretFromFile(file, field)

const assertNoSecretFlags = (args: string[]): void => {
  const blocked = args.find((arg) =>
    ['--api-key', '--client-secret'].some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  )
  if (blocked) {
    throw new Error(
      `toast_secret_cli_flag_disabled:${blocked.split('=')[0]}:use_environment_or_secret_file`,
    )
  }
}

const resolveToastConfig = async (config: AppConfig, args: string[] = []): Promise<ToastConfig> => {
  assertNoSecretFlags(args)
  const saved = await readSavedConfig(config)
  const resolvedConfig: ToastConfig = {
    ...baseToastConfig(),
    ...saved,
    apiHost: process.env.TOAST_API_HOST || saved.apiHost || baseToastConfig().apiHost,
    authPath: process.env.TOAST_AUTH_PATH || saved.authPath || baseToastConfig().authPath,
    salesPath: process.env.TOAST_SALES_PATH || saved.salesPath || baseToastConfig().salesPath,
    startParam: process.env.TOAST_START_PARAM || saved.startParam || baseToastConfig().startParam,
    endParam: process.env.TOAST_END_PARAM || saved.endParam || baseToastConfig().endParam,
    restaurantExternalIds: splitCsv(
      process.env.TOAST_RESTAURANT_EXTERNAL_IDS ||
        process.env.TOAST_RESTAURANT_EXTERNAL_ID ||
        saved.restaurantExternalIds?.join(',') ||
        '',
    ),
    apiKeyHeader: process.env.TOAST_API_KEY_HEADER || saved.apiKeyHeader || baseToastConfig().apiKeyHeader,
    apiKeyPrefix: process.env.TOAST_API_KEY_PREFIX ?? saved.apiKeyPrefix ?? baseToastConfig().apiKeyPrefix,
    clientId: process.env.TOAST_CLIENT_ID || saved.clientId || undefined,
    clientSecret: await environmentSecret(
      process.env.TOAST_CLIENT_SECRET,
      process.env.TOAST_CLIENT_SECRET_FILE,
      'toast_client_secret',
    ),
    apiKey: await environmentSecret(process.env.TOAST_API_KEY, process.env.TOAST_API_KEY_FILE, 'toast_api_key'),
  }

  const restaurants = argValue(args, 'restaurant') || argValue(args, 'restaurants')
  if (restaurants) resolvedConfig.restaurantExternalIds = splitCsv(restaurants)

  resolvedConfig.apiHost = argValue(args, 'host') || resolvedConfig.apiHost
  resolvedConfig.authPath = argValue(args, 'auth-path') || resolvedConfig.authPath
  resolvedConfig.salesPath = argValue(args, 'sales-path') || resolvedConfig.salesPath
  resolvedConfig.clientId = argValue(args, 'client-id') || resolvedConfig.clientId
  validateToastConfig(resolvedConfig)
  return resolvedConfig
}

const validateToastConfig = (toastConfig: ToastConfig): void => {
  const url = new URL(toastConfig.apiHost)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('toast_api_host_must_use_https')
  }
  if (!/^[A-Za-z0-9-]+$/.test(toastConfig.apiKeyHeader)) throw new Error('toast_api_key_header_invalid')
  for (const [field, value] of [
    ['toast_auth_path', toastConfig.authPath],
    ['toast_sales_path', toastConfig.salesPath],
    ['toast_start_param', toastConfig.startParam],
    ['toast_end_param', toastConfig.endParam],
  ] as const) {
    boundedText(value, field, { required: true, maxLength: 2_048 })
  }
}

const savedConfig = (toastConfig: ToastConfig): SavedToastConfig => ({
  apiHost: toastConfig.apiHost,
  authPath: toastConfig.authPath,
  salesPath: toastConfig.salesPath,
  startParam: toastConfig.startParam,
  endParam: toastConfig.endParam,
  restaurantExternalIds: toastConfig.restaurantExternalIds,
  apiKeyHeader: toastConfig.apiKeyHeader,
  apiKeyPrefix: toastConfig.apiKeyPrefix,
  clientId: toastConfig.clientId,
})

const publicConfig = (toastConfig: ToastConfig) => ({
  apiHost: toastConfig.apiHost,
  authPath: toastConfig.authPath,
  salesPath: toastConfig.salesPath,
  restaurantExternalIds: toastConfig.restaurantExternalIds,
  auth: toastConfig.clientId && toastConfig.clientSecret ? 'client_credentials' : toastConfig.apiKey ? 'api_key' : 'missing',
})

export const connectToast = async (config: AppConfig, args: string[] = []) => {
  const toastConfig = await resolveToastConfig(config, args)
  if (toastConfig.restaurantExternalIds.length === 0) {
    return {
      connected: false,
      next: 'Set TOAST_RESTAURANT_EXTERNAL_IDS or pass --restaurants <id,id>.',
      config: publicConfig(toastConfig),
    }
  }
  await mkdir(dirname(configPath(config)), { recursive: true })
  await writeFile(configPath(config), `${JSON.stringify(savedConfig(toastConfig), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(configPath(config), 0o600)
  if (!toastConfig.apiKey && (!toastConfig.clientId || !toastConfig.clientSecret)) {
    return {
      connected: false,
      savedTo: configPath(config),
      next: 'Set TOAST_CLIENT_ID and TOAST_CLIENT_SECRET, TOAST_CLIENT_SECRET_FILE, TOAST_API_KEY, or TOAST_API_KEY_FILE.',
      config: publicConfig(toastConfig),
      note: 'Only non-secret connection settings were saved.',
    }
  }
  return {
    connected: true,
    savedTo: configPath(config),
    config: publicConfig(toastConfig),
    note: 'Only non-secret connection settings were saved; credentials remain outside Bars Bookkeeper.',
  }
}

const joinUrl = (host: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) return path
  return `${host.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

const resolveToastToken = async (toastConfig: ToastConfig): Promise<string | null> => {
  if (toastConfig.apiKey) return toastConfig.apiKey
  if (!toastConfig.clientId || !toastConfig.clientSecret) return null

  const response = await fetch(joinUrl(toastConfig.apiHost, toastConfig.authPath), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: toastConfig.clientId,
      clientSecret: toastConfig.clientSecret,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  })
  if (!response.ok) throw new Error(`toast_auth_failed:${response.status}`)

  const payload = (await response.json()) as Record<string, any>
  return (
    payload?.token?.accessToken ||
    payload?.token?.token ||
    payload?.accessToken ||
    payload?.access_token ||
    null
  )
}

const fetchToastOrders = async (toastConfig: ToastConfig, restaurantId: string, start: string, end: string): Promise<unknown> => {
  const token = await resolveToastToken(toastConfig)
  if (!token) throw new Error('toast_credentials_missing')

  const url = new URL(joinUrl(toastConfig.apiHost, toastConfig.salesPath))
  url.searchParams.set(toastConfig.startParam, start)
  url.searchParams.set(toastConfig.endParam, end)

  const headers: Record<string, string> = {
    accept: 'application/json',
    'Toast-Restaurant-External-ID': restaurantId,
  }
  headers[toastConfig.apiKeyHeader] = `${toastConfig.apiKeyPrefix}${token}`.trim()

  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`toast_pull_failed:${restaurantId}:${response.status}`)
  return response.json()
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

const isRetriableToastError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'toast_credentials_missing' || message.startsWith('toast_auth_failed:')) return false
  const status = Number(message.match(/toast_pull_failed:[^:]+:(\d+)/)?.[1])
  if (!Number.isFinite(status)) return true
  return status === 408 || status === 429 || status >= 500
}

const fetchToastOrdersWithRetry = async (
  toastConfig: ToastConfig,
  restaurantId: string,
  start: string,
  end: string,
  options: ToastPullOptions,
): Promise<unknown> => {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await fetchToastOrders(toastConfig, restaurantId, start, end)
    } catch (error) {
      lastError = error
      if (attempt >= options.maxRetries || !isRetriableToastError(error)) break
      await sleep(options.retryDelayMs)
    }
  }
  throw lastError
}

const arrayFromPayload = (payload: unknown): any[] => {
  if (Array.isArray(payload)) return payload
  if (typeof payload !== 'object' || payload === null) return []
  const record = payload as Record<string, unknown>
  if (typeof record.data === 'object' && record.data !== null) {
    const nestedRows = arrayFromPayload(record.data)
    if (nestedRows.length > 0) return nestedRows
  }
  for (const key of ['orders', 'items', 'results', 'records', 'data']) {
    if (Array.isArray(record[key])) return record[key] as any[]
  }
  return [record]
}

const firstString = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

const firstNumber = (...values: unknown[]): number => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

const selectionChildren = (selection: any): any[] => {
  const children: any[] = []
  for (const key of ['modifiers', 'modifierSelections', 'childSelections', 'children']) {
    if (Array.isArray(selection?.[key])) children.push(...selection[key])
  }
  return children
}

export const flattenToastOrders = (payload: unknown, restaurantExternalId = ''): ToastSalesRow[] => {
  const orders = arrayFromPayload(payload)
  const rows: ToastSalesRow[] = []

  for (const order of orders) {
    const checks = Array.isArray(order?.checks) ? order.checks : [{ selections: order?.selections || order?.items || [] }]
    const occurredAt = firstString(order?.closedDate, order?.openedDate, order?.createdDate, order?.modifiedDate, order?.paidDate)
    const businessDate = firstString(order?.businessDate, occurredAt)
    for (const check of checks) {
      const selections = Array.isArray(check?.selections) ? check.selections : Array.isArray(check?.items) ? check.items : []
      const collectSelection = (
        selection: any,
        indexPath: string[],
        parentMultiplier: number,
        parentMenuItemName = '',
      ): void => {
        if (selection?.voided || selection?.deleted) return
        const item = selection?.item || selection?.menuItem || {}
        const menuItemName = firstString(selection?.displayName, selection?.name, item?.name, item?.displayName)
        const ownQuantity = firstNumber(selection?.quantity, selection?.qty, selection?.count, 1)
        const quantitySold = parentMultiplier * ownQuantity
        const selectionId = firstString(selection?.guid, selection?.id, selection?.externalId, indexPath[indexPath.length - 1])
        const externalIdParts = [
          restaurantExternalId,
          firstString(order?.guid, order?.id),
          firstString(check?.guid, check?.id),
          ...indexPath.slice(0, -1),
          selectionId,
        ]
        if (menuItemName && quantitySold > 0) {
          const row: ToastSalesRow = {
            externalId: externalIdParts.filter(Boolean).join(':'),
            businessDate,
            occurredAt: firstString(selection?.createdDate, occurredAt, businessDate),
            menuItem: menuItemName,
            menuItemName,
            selectionRole: parentMenuItemName ? 'modifier' : 'selection',
            quantitySold,
          }
          if (parentMenuItemName) row.parentMenuItemName = parentMenuItemName
          rows.push(row)
        }

        const children = selectionChildren(selection)
        for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
          collectSelection(
            children[childIndex],
            [...indexPath, firstString(children[childIndex]?.guid, children[childIndex]?.id, `modifier-${childIndex}`)],
            Math.max(0, quantitySold),
            menuItemName || parentMenuItemName,
          )
        }
      }

      for (let index = 0; index < selections.length; index += 1) {
        collectSelection(selections[index], [firstString(selections[index]?.guid, selections[index]?.id, selections[index]?.externalId, `${order?.guid || order?.id || 'order'}-${index}`)], 1)
      }
    }
  }

  return rows
}

const readRowsFromFile = async (path: string, cwd = process.cwd()): Promise<ToastSalesRow[]> => {
  const filePath = isAbsolute(path) ? path : resolve(cwd, path)
  const text = await readFile(filePath, 'utf8')
  try {
    const parsed = JSON.parse(text) as unknown
    if (isToastSalesRows(parsed)) return parsed
    return flattenToastOrders(parsed)
  } catch {
    return parseJsonOrCsv<ToastSalesRow>(text)
  }
}

const isToastSalesRows = (payload: unknown): payload is ToastSalesRow[] =>
  Array.isArray(payload) &&
  payload.every((row) => {
    if (typeof row !== 'object' || row === null) return false
    const record = row as Record<string, unknown>
    return (
      typeof (record.menuItem ?? record.menuItemName) === 'string' &&
      (typeof (record.quantitySold ?? record.quantity) === 'number' || typeof (record.quantitySold ?? record.quantity) === 'string')
    )
  })

const defaultWindow = () => {
  const end = new Date()
  const start = new Date(end.getTime() - 48 * 60 * 60 * 1000)
  return { start: start.toISOString(), end: end.toISOString() }
}

export const pullToast = async (db: Db, config: AppConfig, args: string[] = []): Promise<ToastPullResult> => {
  const file = argValue(args, 'file')
  if (file) {
    const rows = await readRowsFromFile(file)
    return {
      configured: true,
      restaurants: 0,
      failedRestaurants: 0,
      failures: [],
      rowsPulled: rows.length,
      ingest: ingestToastSales(db, rows, 'Toast file import'),
      source: 'file',
    }
  }

  const toastConfig = await resolveToastConfig(config, args)
  if (toastConfig.restaurantExternalIds.length === 0) throw new Error('toast_restaurant_ids_missing')
  const window = {
    start: argValue(args, 'start') || defaultWindow().start,
    end: argValue(args, 'end') || defaultWindow().end,
  }
  const pullOptions: ToastPullOptions = {
    maxRetries: numberArg(args, 'max-retries', 2),
    retryDelayMs: numberArg(args, 'retry-delay-ms', 250),
  }

  const rows: ToastSalesRow[] = []
  const failures: ToastPullResult['failures'] = []
  for (const restaurantId of toastConfig.restaurantExternalIds) {
    try {
      const payload = await fetchToastOrdersWithRetry(toastConfig, restaurantId, window.start, window.end, pullOptions)
      rows.push(...flattenToastOrders(payload, restaurantId))
    } catch (error) {
      failures.push({
        restaurantExternalId: restaurantId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (failures.length === toastConfig.restaurantExternalIds.length) {
    throw new Error(`toast_pull_failed_all:${failures.map((failure) => `${failure.restaurantExternalId}:${failure.error}`).join('|')}`)
  }

  return {
    configured: true,
    restaurants: toastConfig.restaurantExternalIds.length,
    failedRestaurants: failures.length,
    failures,
    rowsPulled: rows.length,
    ingest: ingestToastSales(db, rows, 'Toast API'),
    source: 'api',
  }
}

export const syncToastSales = pullToast

export const toastPull = async (config: AppConfig, args: string[] = []) => {
  const db = openDatabase(config.dbPath)
  migrateDatabase(db)
  try {
    return await pullToast(db, config, args)
  } finally {
    db.close()
  }
}
