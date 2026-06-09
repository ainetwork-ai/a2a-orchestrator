// ainspace → backend Redis→Postgres 이관 계약 타입 (수신측 backend DTO 미러).
// 단일 진실은 backend `src/migration/dto/ainspace-envelope.dto.ts` + 계약 문서
// `docs/integration/ainspace-migration-guide.md`. 여기 정의는 그 계약을 그대로
// 옮긴 것 — 두 레포가 분리돼 있어 import 대신 미러로 둔다. 계약이 바뀌면 양쪽 동기.

export type OwnerRef =
  | { kind: "wallet"; address: string } // 로그인 유저. users.ain_address로 reconcile/생성.
  | { kind: "session"; sessionId: string } // 비로그인. displayName "unknown user", sessionId dedup.
  | { kind: "unknown" }; // owner 없는 레거시 thread. 전체가 단일 "unknown user (legacy)" 공유.

export interface AgentEnvelope {
  /** 소스맵 키(선택). 없으면 backend가 정규화 a2aUrl을 키로 사용. */
  sourceId?: string;
  /** card fetch 실패 시 fallback displayName. */
  name: string;
  /** agent A2A endpoint URL. dedup·정체성 키(backend가 toAgentIdentityUrl로 정규화). */
  a2aUrl: string;
}

export interface MessageEnvelope {
  sourceId: string;
  /** exporter가 해소: "user"=owner 발화, { a2aUrl }=agent 발화. */
  senderRef: "user" | { a2aUrl: string };
  content: string;
  /** epoch milliseconds. */
  createdAt: number;
  replyToSourceId?: string;
  status?: "accepted" | "dropped";
}

export interface DmThreadEnvelope {
  sourceId: string;
  name: string;
  owner: OwnerRef;
  agentUrls: string[];
  createdAt: number;
  updatedAt: number;
  messages: MessageEnvelope[];
}

export interface MigrationBatchRequest<T> {
  dryRun?: boolean;
  includeDropped?: boolean;
  items: T[];
}

export interface MigrationBatchError {
  sourceId: string;
  reason: string;
}

export interface MigrationBatchReport {
  processed: number;
  created: number;
  matched: number;
  skipped: number;
  errors: MigrationBatchError[];
}
