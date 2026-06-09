# Ainspace → Backend Migration Guide (Redis → Postgres 일회성 이관 계약)

> ainspace(a2a-orchestrator)가 Redis에 보관한 **agent / thread(=DM) / message**를 backend Postgres로 옮기기 위해 **ainspace가 backend로 보내야 하는 데이터 형태(envelope)** 와 호출 규약을 정의한다. ainspace는 자기 Redis 구조를 노출하지 않고 본 문서의 envelope로 변환해 push한다. envelope→DB row 매핑·dedup·FK·UNIQUE·short_id 생성은 **backend(수신 측)** 가 전담한다.
>
> 설계 근거·구현 범위: [`docs/epics/yoojin/EPIC21-ainspace-redis-to-pg-migration.md`](../epics/yoojin/EPIC21-ainspace-redis-to-pg-migration.md).

## ⚠️ 상태 (읽기 전 필독)

- 본 문서는 **계약(설계 합의)** 다. 수신 엔드포인트(`/migration/ainspace/*`)는 EPIC21 Story 21.1~21.4로 **구현 예정**이며 아직 미배포다.
- ainspace는 본 계약으로 **Redis→envelope 변환기(exporter)** 를 미리 작성할 수 있다. 단 실제 push 검증은 backend 구현 + staging 리허설(EPIC21 런북) 단계에서 한다.
- 이관은 **일회성 컷오버**다(지속 동기화 아님). 컷오버 전 staging에서 **반복 리허설**하므로 같은 데이터를 여러 번 보내도 안전해야 한다(아래 멱등 계약).

---

## 1. 인증 / 호출 규약

EPIC13 JWT 체계를 재사용하되 **전용 scope `migration:write`** 로 잠근다. 일반 외부 클라이언트 토큰(`DEFAULT_EXTERNAL_SCOPES`)에는 이 scope가 없다.

- 운영자에게 **`migration:write` scope가 부여된 토큰** 발급 요청 (일반 로그인 토큰과 별개).
- 모든 호출: `Authorization: Bearer <migrationToken>`, `Content-Type: application/json`, `credentials: "omit"`.
- ainspace exporter가 호출하는 origin을 운영자가 `EXTERNAL_ORIGIN_ALLOWLIST`에 등록.

```ts
fetch(`${BACKEND_BASE}${path}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${migrationToken}`, "Content-Type": "application/json" },
  credentials: "omit",
  body: JSON.stringify(payload),
});
```

## 2. 엔드포인트

| Path | Method | scope | 용도 |
|---|---|---|---|
| `/migration/ainspace/agents` | POST | `migration:write` | agent 목록 적재(reconcile/생성) |
| `/migration/ainspace/dms`    | POST | `migration:write` | DM thread + message 적재 |

### 공통 요청 래퍼

```jsonc
{
  "dryRun": false,          // true면 쓰기 없이 검증·카운트만
  "includeDropped": false,  // dms 전용 옵션. true면 status="dropped" 메시지도 적재(기본 제외)
  "items": [ /* envelope[] */ ]
}
```

### 공통 응답 (batch 리포트)

```jsonc
{
  "processed": 120,
  "created": 90,            // 신규 생성된 row 수
  "matched": 28,            // 기존 row와 합쳐진(=재실행) 수
  "skipped": 2,             // 이미 적재됨(멱등) 또는 dropped 제외
  "errors": [
    { "sourceId": "thread:abc", "reason": "agent card fetch failed: <a2aUrl>" }
  ]
}
```

- **권장 batch 크기**: agents는 한 번에 전량 가능(수십~수백). dms는 **thread 단위로 묶어 50~200 thread/배치** 권장(message가 thread당 수천일 수 있어 payload·트랜잭션 크기 고려). 큰 thread는 단독 배치로.
- 부분 실패(특정 item)는 `errors`로 격리되고 batch 전체를 막지 않는다.

---

## 3. 데이터 형태 (envelope 스키마)

### 3.1 AgentEnvelope — `/migration/ainspace/agents`

ainspace는 **a2aUrl만** 보낸다. backend가 card를 fetch해 displayName/card json을 채우고, `toAgentIdentityUrl(a2aUrl)`로 정규화해 기존 agent와 dedup한다.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `a2aUrl` | string | ✅ | agent의 A2A endpoint URL (외부 agent의 절대 well-known URL 등). dedup·정체성 키. |
| `name` | string | ✅ | card fetch 실패 시 fallback displayName. |
| `sourceId` | string | – | 안정적이면 전달(소스맵 키). 없으면 backend가 정규화 a2aUrl을 키로 사용. |

```jsonc
{
  "dryRun": false,
  "items": [
    { "a2aUrl": "https://agent.example.com/.well-known/agent.json", "name": "Researcher" },
    { "a2aUrl": "https://other.example.com/a2a", "name": "Writer" }
  ]
}
```

> dedup은 **URL 기준**이다(EPIC20). 같은 endpoint를 base/legacy/modern 어느 형태로 보내도 backend가 동일 identity로 수렴시킨다.

### 3.2 DmThreadEnvelope — `/migration/ainspace/dms`

thread 1건 = DM 1건. 멤버 = owner(지갑 유저 1명) + agents N.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `sourceId` | string | ✅ | ainspace `thread.id`. 멱등/재개 키. |
| `name` | string | ✅ | thread.name. |
| `owner` | OwnerRef | ✅ | thread owner(human). 아래 3.2.1. **exporter가 wallet/session을 구분해 명시.** |
| `agentUrls` | string[] | ✅ | thread.agents[].a2aUrl. (사전 또는 동시 적재된 agent와 매칭) |
| `createdAt` | number | ✅ | epoch **milliseconds**. |
| `updatedAt` | number | ✅ | epoch **milliseconds**. |
| `messages` | MessageEnvelope[] | ✅ | 아래 3.3. **시간순 보장 불필요**(backend가 createdAt 오름차순 정렬 후 적재). |

#### 3.2.1 OwnerRef

`thread.userId`는 **지갑 주소(로그인)** 또는 **sessionId(비로그인)** 둘 다 들어올 수 있다. exporter가 어느 쪽인지 구분해 아래 형태로 명시한다 (backend는 문자열 모양으로 추론하지 않음).

```ts
type OwnerRef =
  | { kind: "wallet"; address: string }    // 로그인 유저. users.ain_address로 reconcile/생성.
  | { kind: "session"; sessionId: string } // 비로그인 유저. displayName "unknown user", sessionId로 dedup.
```

- **wallet**: `thread.userId`가 Base 지갑 주소인 경우. 같은 주소는 기존 user와 합쳐진다.
- **session**: `thread.userId`가 sessionId인 경우(지갑 로그인 안 한 유저). `displayName="unknown user"`로 생성되고 `ain_address`는 NULL. **같은 sessionId의 여러 thread는 1 user로 수렴**(sessionId dedup).

### 3.3 MessageEnvelope

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `sourceId` | string | ✅ | ainspace `message.id`. 멱등 키. |
| `senderRef` | `"user"` \| `{ "a2aUrl": string }` | ✅ | **exporter가 해소**. user 발화면 `"user"`, agent 발화면 그 agent의 a2aUrl. (speaker 문자열 추론을 backend에 떠넘기지 않는다 — §4.3) |
| `content` | string | ✅ | message.content. |
| `createdAt` | number | ✅ | epoch **milliseconds** (message.timestamp). |
| `replyToSourceId` | string | – | message.replyTo (있으면). backend가 부모 message의 uuid로 `parent_id` 연결. |
| `status` | `"accepted"` \| `"dropped"` | – | 생략 가능. `"dropped"`는 폐기된 후보 응답 — **기본 적재 제외**(`includeDropped:true`에서만). |

```jsonc
{
  "dryRun": false,
  "includeDropped": false,
  "items": [
    {
      "sourceId": "f1e2d3...",
      "name": "리서치 논의",
      "owner": { "kind": "wallet", "address": "0xabc...def" },
      "agentUrls": ["https://agent.example.com/.well-known/agent.json"],
      "createdAt": 1716200000000,
      "updatedAt": 1716300000000,
      "messages": [
        { "sourceId": "m1", "senderRef": "user", "content": "안녕", "createdAt": 1716200000000 },
        { "sourceId": "m2", "senderRef": { "a2aUrl": "https://agent.example.com/.well-known/agent.json" },
          "content": "안녕하세요", "createdAt": 1716200005000, "replyToSourceId": "m1", "status": "accepted" }
      ]
    }
  ]
}
```

---

## 4. Redis → envelope 변환 가이드 (exporter 작성용)

a2a-orchestrator Redis 모델 기준. (`src/services/agentService.ts`, `src/world/threadManager.ts`, `src/world/world.ts`, `src/types/index.ts`)

### 4.1 Agents — `orchestrator:agents` (Set)
각 member = `{ name, a2aUrl }` (JSON). → `AgentEnvelope { a2aUrl, name }` 그대로.

### 4.2 Threads — `threads:list`(Set) → `thread:{id}`
`Thread { id, name, agents: {name,role,a2aUrl,color}[], userId, createdAt, updatedAt }` →
- `sourceId = thread.id`
- `name = thread.name`
- `owner` = `thread.userId`가 지갑 주소면 `{ kind:"wallet", address: thread.userId }`, sessionId면 `{ kind:"session", sessionId: thread.userId }`. **exporter가 자기 세션 스토어 기준으로 둘을 구분**한다.
- `agentUrls = thread.agents.map(a => a.a2aUrl)`
- `createdAt/updatedAt` 그대로(ms)
- `messages`: `messages:{thread.id}`의 `.messages[]` 변환(§4.3)

### 4.3 Messages — `messages:{threadId}` 의 `.messages[]`
`Message { id, speaker, content, timestamp, replyTo?, status? }` →
- `sourceId = message.id`, `content`, `createdAt = message.timestamp`, `replyToSourceId = message.replyTo`, `status`
- **`senderRef` 해소 (exporter 책임)**:
  - `speaker`가 user 발화를 나타내면 → `"user"`
  - `speaker`가 agent 발화면 → `thread.agents`에서 `speaker`(=agent name)와 매칭되는 항목의 `a2aUrl`을 찾아 `{ a2aUrl }`
  - 매칭 안 되는 speaker는 envelope에 담지 말고 exporter 로그로 남긴다(데이터 정합 점검).
- exporter는 thread context(agents의 name↔a2aUrl)를 알고 있으므로 이 해소를 **보내기 전에** 끝낸다.

---

## 5. 멱등 / 재개 계약

- **sourceId 안정성**: 같은 Redis 엔티티는 항상 같은 `sourceId`(thread.id/message.id)로 보낸다. backend는 `migration_source_map`에 (sourceSystem, type, sourceId)→targetId를 기록해 재push 시 중복을 만들지 않는다.
- **재전송 안전**: 네트워크/타임아웃으로 끊기면 **같은 batch를 그대로 다시** 보내도 된다(이미 적재된 item은 `skipped`).
- **agent dedup**: agent는 sourceId가 없어도 `a2aUrl`(정규화) UNIQUE로 수렴 — 같은 url 재전송은 항상 같은 user.
- **dryRun**: 컷오버 전 `dryRun:true`로 전량 1회 보내 `created/matched/skipped/errors` 리포트로 영향 규모·오류(특히 agent card fetch 실패, 미매칭 speaker)를 먼저 확인한다.

## 6. backend가 하는 일 (참고 — exporter는 신경 쓸 필요 없음)

- agent: `toAgentIdentityUrl(a2aUrl)`로 `users.a2a_url` 매칭/생성(+card fetch로 `agent_card_json`).
- owner: wallet이면 `ain_address` 매칭/생성, session이면 `displayName="unknown user"` + sessionId dedup 생성.
- thread: `dm_conversations`(workspace = ainspace clientId workspace, `short_id` 자동 생성) + `dm_members`(owner+agents) + 필요 시 `workspace_members` join 보강.
- message: `senderRef`→`user_id` 해소, `createdAt`(ms) 보존, `replyToSourceId`→`parent_id`, dropped 기본 제외, createdAt 오름차순 적재(부모 먼저).
