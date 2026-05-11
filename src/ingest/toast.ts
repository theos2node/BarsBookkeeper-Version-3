import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { AppConfig } from '../config.js'
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

type ToastPullResult = {
  configured: boolean
  restaurants: number
  rowsPulled: number
  ingest: IngestResult
  source: 'file' | 'api'
}

const defaultToastConfig = (): ToastConfig => ({
  apiHost: process.env.TOAST_API_HOST || 'https://ws-api.toasttab.com',
  authPath: process.env.TOAST_AUTH_PATH || '/authentication/v1/authentication/login',
  salesPath: process.env.TOAST_SALES_PATH || '/orders/v2/ordersBulk',
  startParam: process.env.TOAST_START_PARAM || 'startDate',
  endParam: process.env.TOAST_END_PARAM || 'endDate',
  restaurantExternalIds: splitCsv(process.env.TOAST_RESTAURANT_EXTERNAL_IDS || process.env.TOAST_RESTAURANT_EXTERNAL_ID || ''),
  apiKeyHeader: process.env.TOAST_API_KEY_HEADER || 'Authorization',
  apiKeyPrefix: process.env.TOAST_API_KEY_PREFIX || 'Bearer ',
  clientId: process.env.TOAST_CLIENT_ID || undefined,
  clientSecret: process.env.TOAST_CLIENT_SECRET || undefined,
  apiKey: process.env.TOAST_API_KEY || undefined,
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

const hasFlag = (args: string[], name: string): boolean => args.includes(`--${name}`)

const configPath = (config: AppConfig): string => resolve(config.dataDir, 'toast-config.json')

const readSavedConfig = async (config: AppConfig): Promise<Partial<ToastConfig>> => {
  try {
    return JSON.parse(await readFile(configPath(config), 'utf8')) as Partial<ToastConfig>
  } catch {
    return {}
  }
}

const resolveToastConfig = async (config: AppConfig, args: string[] = []): Promise<ToastConfig> => {
  const saved = await readSavedConfig(config)
  const resolvedConfig: ToastConfig = {
    ...defaultToastConfig(),
    ...saved,
  }

  const restaurants = argValue(args, 'restaurant') || argValue(args, 'restaurants')
  if (restaurants) resolvedConfig.restaurantExternalIds = splitCsv(restaurants)

  resolvedConfig.apiHost = argValue(args, 'host') || resolvedConfig.apiHost
  resolvedConfig.authPath = argValue(args, 'auth-path') || resolvedConfig.authPath
  resolvedConfig.salesPath = argValue(args, 'sales-path') || resolvedConfig.salesPath
  resolvedConfig.clientId = argValue(args, 'client-id') || resolvedConfig.clientId
  resolvedConfig.clientSecret = argValue(args, 'client-secret') || resolvedConfig.clientSecret
  resolvedConfig.apiKey = argValue(args, 'api-key') || resolvedConfig.apiKey
  return resolvedConfig
}

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
  if (!toastConfig.apiKey && (!toastConfig.clientId || !toastConfig.clientSecret)) {
    return {
      connected: false,
      next: 'Set TOAST_CLIENT_ID and TOAST_CLIENT_SECRET, or TOAST_API_KEY for a manual token.',
      config: publicConfig(toastConfig),
    }
  }

  await mkdir(dirname(configPath(config)), { recursive: true })
  await writeFile(configPath(config), `${JSON.stringify(toastConfig, null, 2)}\n`, 'utf8')
  return {
    connected: true,
    savedTo: configPath(config),
    config: publicConfig(toastConfig),
    note: 'Credentials are stored under data/ and ignored by git.',
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

export const flattenToastOrders = (payload: unknown, restaurantExternalId = ''): ToastSalesRow[] => {
  const orders = arrayFromPayload(payload)
  const rows: ToastSalesRow[] = []

  for (const order of orders) {
    const checks = Array.isArray(order?.checks) ? order.checks : [{ selections: order?.selections || order?.items || [] }]
    const occurredAt = firstString(order?.closedDate, order?.openedDate, order?.createdDate, order?.modifiedDate, order?.paidDate)
    const businessDate = firstString(order?.businessDate, occurredAt)
    for (const check of checks) {
      const selections = Array.isArray(check?.selections) ? check.selections : Array.isArray(check?.items) ? check.items : []
      for (let index = 0; index < selections.length; index += 1) {
        const selection = selections[index]
        if (selection?.voided || selection?.deleted) continue
        const item = selection?.item || selection?.menuItem || {}
        const menuItemName = firstString(selection?.displayName, selection?.name, item?.name, item?.displayName)
        const quantitySold = firstNumber(selection?.quantity, selection?.qty, selection?.count, 1)
        if (!menuItemName || quantitySold <= 0) continue
        const selectionId = firstString(selection?.guid, selection?.id, selection?.externalId, `${order?.guid || order?.id || 'order'}-${index}`)
        rows.push({
          externalId: [restaurantExternalId, firstString(order?.guid, order?.id), firstString(check?.guid, check?.id), selectionId]
            .filter(Boolean)
            .join(':'),
          businessDate,
          occurredAt: firstString(selection?.createdDate, occurredAt, businessDate),
          menuItem: menuItemName,
          menuItemName,
          quantitySold,
        })
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
    return flattenToastOrders(parsed)
  } catch {
    return parseJsonOrCsv<ToastSalesRow>(text)
  }
}

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

  const rows: ToastSalesRow[] = []
  for (const restaurantId of toastConfig.restaurantExternalIds) {
    const payload = await fetchToastOrders(toastConfig, restaurantId, window.start, window.end)
    rows.push(...flattenToastOrders(payload, restaurantId))
  }

  return {
    configured: true,
    restaurants: toastConfig.restaurantExternalIds.length,
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
