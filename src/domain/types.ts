export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type DecisionState = 'proposed' | 'auto_applied' | 'needs_review' | 'suppressed' | 'reversed'
export type InventoryEventType = 'purchase' | 'sale' | 'adjustment' | 'shrink' | 'correction'

export type EvidenceRef = {
  kind: 'toast' | 'invoice' | 'count' | 'decision' | 'manual'
  id: string
  label: string
}

export type OpenClawDecisionPayload = {
  eventType?: InventoryEventType
  skuName?: string
  vendorName?: string
  quantity?: number
  unit?: string
  occurredAt?: string
  reason?: string
}

export type InventoryPosition = {
  skuId: number
  name: string
  unit: string
  category: string | null
  onHand: number
  parLevel: number | null
  avgDailyUsage: number
  daysRemaining: number | null
  confidence: number
  warningState: 'ok' | 'watch' | 'low' | 'critical'
}

export type OrderRecommendation = {
  vendorName: string
  skuName: string
  quantity: number
  unit: string
  reason: string
  confidence: number
}
