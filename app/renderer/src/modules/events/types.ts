export interface EventCondition {
  type: "metric" | "log";
  metric?: string;
  op?: string;
  threshold?: number;
  pattern?: string;
}

export interface EventAction {
  kind: "snapshot" | "recording";
  minutes: number | null;
  duration_minutes: number | null;
  safe: boolean;
  max_keep_seconds: number | null;
}

export interface UiEvent {
  id: string;
  name: string;
  sourceIds: string[];
  conditions: EventCondition[];
  match: string;
  action: EventAction;
  enabled: boolean;
  status: string;
  armed: boolean;
  triggeredAt: number | null;
  triggerDetail: string | null;
  triggerCount?: number;
  artifactPath: string | null;
  logCursors: Record<number, Record<string, number>>;
  _pendingGatewaySessionId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GatewayEvent = any;
