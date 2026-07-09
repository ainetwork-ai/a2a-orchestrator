# EPIC8 - Ainspace Dual-Write Ingest (ainspace 대화 인제스트로 report 파이프라인 부활)

> orchestrator 를 다시 live 서비스로 세우고, **ainspace 프론트가 dual-write 하는 대화 턴을 받는 인증된 ingest 엔드포인트**를 추가한다. ingest 는 ThreadManager/World 를 통해 기존 report 파이프라인이 읽는 것과 **정확히 동일한 shape**(thread + Message DAG)로 in-memory + Redis 에 적재한다. 이로써 EPIC1~7 의 report 파이프라인이 **ainspace 최신 대화** 위에서 다시 동작한다.

## 의존성
- EPIC1~7 (report 파이프라인 — conversation-aware 추출/클러스터링/dedup/thread-level). 본 EPIC 은 파이프라인을 **수정하지 않고** 데이터 유입 경로만 추가한다.
- 상위 제품 결정 (a2a-slack-notion 측 논의, forward-only 요약):
  - report 는 shared(ainteams) backend 가 아니라 **orchestrator 에 남긴다**. shared backend 는 report 를 전혀 모르는 상태(report-agnostic)로 유지.
  - 대화 canonical host 는 shared backend(agent·orchestration 이 거기 있음). orchestrator 는 **ainspace 대화만** 받는 다운스트림 report store.
  - **provenance 는 write(=ingest) 시점에 결정**되고 orchestrator 가 권위다. "orchestrator 에 있는 것 = ainspace 에서 발생한 것." shared backend DB 에는 어떤 provenance 마킹도 하지 않는다(사적 DM 노출 방지의 근간 — orchestrator 에는 ainteams 사적 DM 이 애초에 들어오지 않음).
  - **sovereignty 예외(의식적 waive)**: orchestrator 원본 report 파이프라인의 임베딩은 OpenAI/Azure 를 그대로 쓴다. 본 배치는 잠정(추후 backend+Notion 으로 이전 가능 — report 산출물이 markdown 이므로)이며, 그 waive 는 운영자가 명시적으로 승인했다.

## 배경

### 현재 상태 (컷오버 이후 frozen)
ainspace 데이터는 EPIC21(a2a-slack-notion) 로 shared backend Postgres 로 일회성 컷오버 이관됐고, 그 시점에 ainspace 는 orchestrator Redis 쓰기를 멈췄다. 따라서 orchestrator Redis 는 **컷오버 시점에 멈춘 stale 상태**이고, orchestrator 는 대화 경로에서 빠져 있다. 하지만 report 파이프라인·API·Redis 스키마는 그대로 살아 있다.

### 목표 아키텍처
```
[ainspace 프론트] ── 메시지 send ──▶ [shared backend] (agent 응답, canonical 저장)
       │                                    │
       └── 같은 턴을 dual-write ────────────┘ (응답 수신 후)
                   │
                   ▼
        [orchestrator] POST /api/ingest  ──▶ ThreadManager/World ──▶ Redis (thread + Message DAG)
                                                     │
                                                     ▼
                                         기존 report 파이프라인(EPIC1~7) 그대로 읽음
```
ainspace 프론트가 shared backend 와 왕복한 뒤, **그 턴(user 메시지 + agent 응답)을 orchestrator ingest 로 한 번 더 POST** 한다. shared backend 는 이 흐름을 전혀 모른다.

### 핵심 제약 (recon 으로 확인 — 설계를 지배함)
- report 파이프라인은 **in-memory `World`/`MessageDAG`** 에서 읽는다(`threadManager.getWorld(id).getHistory()` → `messageDAG.getAllMessages()`, `world.ts:545-547`). in-memory Map 은 부팅 시 `loadThreadsFromRedis`(`threadManager.ts:77-101`)로 **한 번만** 채워지고 이후 재실행되지 않는다.
  - ⇒ **Redis 를 직접 쓰면(managers 우회) 실행 중인 orchestrator 에는 재시작 전까지 안 보인다.** ingest 는 반드시 ThreadManager/World 를 거쳐 in-memory DAG 와 Redis 를 함께 갱신해야 한다.
- 그러나 현재 **임의로 미리 작성된 메시지(원하는 speaker/timestamp/id)를 append 하는 public 메서드가 없다**: `addUserMessage`(`world.ts:293-315`)는 `speaker:"User"` 하드코딩 + agent 처리 트리거, agent 메시지는 live 대화 중에만 내부 생성. ⇒ agent 를 트리거하지 않는 **순수 append 메서드**가 필요(Story 8.1).
- report 가 소비하는 필드 (recon):
  - Thread: `id`, `agents[].a2aUrl`, `agents[].name` 만 (`pipelineUtils.ts:19-44`). `userId`/`name`/`createdAt` 은 미사용.
  - Message: `id`, `speaker`, `content`, `timestamp`(epoch ms) 만 (`conversationParser.ts:32-73`). `isUser` 는 `speaker === "User"` 로 **파생**(저장 안 함), 날짜 필터는 `message.timestamp` 기준.
- speaker 규약: 사람 = 정확히 `"User"`, agent = agent **display name**(`thread.agents[].name` 과 일치해야 agentNames 필터 정합).

### 비목표
- report 파이프라인 로직 변경 (EPIC1~7 그대로).
- shared backend 변경 (report-agnostic 유지 — 이 EPIC 은 orchestrator 만 건드림).
- ainspace 프론트 dual-write 구현 (별도: ainspace EPIC17).
- 리포트 조회 UI (ainspace-report 레포, 본 범위 밖).
- 컷오버~ingest 개시 사이 공백의 backfill (필요 시 일회성 별건; 컷오버 이전 히스토리는 이미 Redis 에 frozen 상태로 존재).

## 목표
- orchestrator 가 live 로 기동되고, ainspace 프론트가 대화 턴을 POST 하면 report 파이프라인이 읽는 shape 로 적재된다(in-memory + Redis).
- **backend id 보존(correlation)**: shared backend 의 canonical id — 대화 **conversationId**(= thread.id), 사람의 **backend user id**(ainspace 가 auth 용으로 이미 보관 중인 그 id, = backend `users.id`), agent 의 **backend agent id + a2aUrl** — 를 orchestrator 레코드에 함께 저장한다. 목적: (1) 나중에 backend 와 상호참조(재배치·reconcile), (2) report 귀속·agentUrls/agentNames 필터·per-user 그룹핑 정확성. display name 단독 식별 금지(이름 충돌).
- ingest 는 **멱등**(같은 message id 재-POST 시 중복 생성 없음)하고, agent 처리를 트리거하지 않는다.
- ingest 엔드포인트는 **인증**된다(shared secret). 나머지 live 라우트는 기존과 동일.
- ingest 직후 `POST /api/reports` 가 그 대화를 포함한 리포트를 생성한다.

---

## Story 8.1: `World.ingestMessage` — agent 미트리거 순수 append

**수정 파일:** `src/world/world.ts`

### 배경
현재 메시지 생성 경로는 (a) `addUserMessage`(speaker 하드코딩 `"User"` + `broadcastToAgents` 트리거, `world.ts:293-315`), (b) agent 응답(live 대화 중 내부 생성, `world.ts:468-477`, `:609-618`) 뿐이다. ingest 는 **미리 확정된 턴**(ainspace 에서 이미 일어난 user + agent 메시지)을 speaker/timestamp/id 그대로 적재해야 하며, **여기서 agent 를 다시 부르면 안 된다**(대화는 이미 shared backend 에서 끝남).

### 참고 파일
- `src/world/world.ts:293-315` (`addUserMessage`) — DAG add + `saveMessagesToRedis` 패턴. 단 broadcast 트리거는 **제외**.
- `src/world/world.ts:652-661` (`saveMessagesToRedis`) — Redis wrapper `{ messages, currentBlock, nextSpeaker, messageIdCounter, initialUserMessage, currentConversationMessageCount }` 저장.
- `src/world/messageDAG.ts:11-36` (`addMessage`, Map 키=id → 같은 id 재삽입은 overwrite, `:24`).
- `src/types/index.ts:1-8` (`Message` shape).

### 태스크

#### `Message` 에 sender identity(optional) 추가
- [ ] `src/types/index.ts` `Message` 에 **optional** `senderA2aUrl?: string` 추가(agent 턴의 canonical 식별자). 사람 턴은 `speaker:"User"` + thread.userId 로 식별되므로 불필요. optional 이라 기존 DAG/파이프라인 하위호환(report 는 이 필드 안 읽음 — 식별 fidelity 보존용).

#### `ingestMessage` 추가
- [ ] `World.ingestMessage(msg: { id: string; speaker: string; content: string; timestamp: number; replyTo?: string; status?: "accepted" | "dropped"; senderA2aUrl?: string }): { ingested: boolean }` 추가.
- [ ] 이미 존재하는 id(`messageDAG` 에 있음)면 **skip**(멱등) → `{ ingested: false }`. 아니면 `messageDAG.addMessage(msg)` 후 `saveMessagesToRedis()` → `{ ingested: true }`.
- [ ] **agent 처리 트리거 금지** — `broadcastToAgents`/`processAgentResponsesQueue` 호출하지 않는다.
- [ ] `status` 미지정 시 `"accepted"` 기본(DAG main-history 재구성 정합).
- [ ] `messageIdCounter` 는 ingest 가 자체 id 를 쓰므로 건드리지 않되, wrapper 저장 시 기존 값 보존.

### 주의사항
- report 날짜 필터가 `message.timestamp`(epoch ms) 기준이므로, 프론트가 보낸 실제 timestamp 를 그대로 저장한다(재작성 금지).
- `replyTo` 는 DAG 부모 링크. user 턴은 보통 없음, agent 응답은 직전 user 메시지 id 를 가리키게 프론트가 채울 수 있음(없어도 report 는 무관 — report 는 flat list + speaker 만 봄).

---

## Story 8.2: `ThreadManager.getOrCreateThread` — thread upsert + agent 등록

**수정 파일:** `src/world/threadManager.ts`

### 배경
ingest 대상 thread 가 없으면 만들고, 있으면 재사용해야 한다(멱등). 또 report 의 agent 필터(`orchestrator:agents` set + `thread.agents`)가 동작하려면 ingest 시 agent 를 등록해야 한다. 현재 `createThread`(`threadManager.ts:106-127`)는 항상 새 uuid 를 만들어 upsert 가 안 되고, agent 추가는 별도 라우트(`threads.ts:191-237`)에 있다.

### 참고 파일
- `src/world/threadManager.ts:106-127` (`createThread`), `:38-39` (`saveThreadToRedis` = `thread:{id}` + `sAdd threads:list`), `:183` (agent dedup by `a2aUrl`).
- `src/services/agentService.ts` (`registerAgents` → `orchestrator:agents` set; report 의 agentUrls/agentNames 필터 소스).
- `src/routes/threads.ts:191-237` (agent 추가 시 `color` 기본값 `"bg-gray-100 border-gray-400"`, `a2aUrl` dedup).
- `src/types/index.ts:10-24` (`AgentPersona`, `Thread`).

### 태스크

#### `AgentPersona` 에 backend id(optional) 추가
- [ ] `src/types/index.ts` `AgentPersona` 에 optional `backendAgentId?: string`(agent 의 shared backend `users.id`) 추가. a2aUrl(A2A 프로토콜 식별자, report 필터가 사용)은 유지하고 backend row id 를 **함께** 보존. optional 이라 하위호환.

#### `getOrCreateThread` 추가
- [ ] `ThreadManager.getOrCreateThread(input: { id: string; name?: string; userId: string; agents: Array<{ name: string; a2aUrl: string; backendAgentId?: string; role?: string; color?: string }> }): World` 추가. `id` = backend conversationId, `userId` = **backend user id**(필수).
- [ ] `id` 로 in-memory Map 조회 → 있으면 그 `World` 반환(단 신규 agent 는 병합), 없으면 **주어진 id 그대로** Thread 생성(uuid 재발급 금지 — 프론트가 준 id 가 곧 thread id)·`userId` 저장·`World` 구성·in-memory Map 등록·`saveThreadToRedis`.
- [ ] agent 병합: `a2aUrl` 로 dedup, 신규만 `thread.agents` 에 추가(`backendAgentId` 보존, `role` 기본 `""`, `color` 기본값). 변경 시 `saveThreadToRedis` + `agentService.registerAgents(agents)`.
- [ ] `createdAt`/`updatedAt` 은 최초 생성 시 `Date.now()`(report 미사용이라 값 자체는 무관하나 스키마 충족).

### 주의사항
- `id` 는 **ainspace 프론트가 소유한 안정적 대화 id**(shared backend conversationId 등)를 쓴다. 이 매핑(backend conversationId ↔ orchestrator threadId)은 프론트/ainspace 측 상태이며 shared backend 에는 저장하지 않는다.
- ingest-only thread 는 live orchestration 을 돈 적이 없으므로 `messages:{threadId}` wrapper 의 orchestration 상태 필드(currentBlock 등)는 기본값으로 충분(`loadMessagesFromRedis` 는 `parsed.messages` 만 authoritative).

---

## Story 8.3: Ingest 라우트 + 인증

**수정 파일:** `src/routes/ingest.ts`(신규), `src/server.ts`, `src/middleware/ingestAuth.ts`(신규), `.env.example`

### 배경
ainspace 프론트가 턴을 POST 할 엔드포인트. live 라우트엔 인증이 없으므로(`server.ts` — CORS 만), **이 쓰기 엔드포인트에만** shared-secret 인증을 붙인다.

### 참고 파일
- `src/server.ts:16-39`(initialize), `:76-79`(라우트 mount 패턴), CORS(`:49-62`).
- `src/routes/threads.ts:336-404`(메시지 append 라우트 — 에러 응답 형식 참고).
- `src/migration/client.ts:54-73`(Bearer 토큰 검사 형식 참고 — 스크립트 측이지만 규약 동일).

### 태스크

#### 인증 미들웨어
- [ ] `ingestAuth.ts`: `Authorization: Bearer <INGEST_TOKEN>` 검사, 불일치 시 401. `INGEST_TOKEN` 미설정이면 부팅 시 경고 + 엔드포인트 비활성(503) — 실수로 무인증 쓰기 방지.
- [ ] `.env.example` 에 `INGEST_TOKEN` 추가.

#### Ingest 라우트
- [ ] `POST /api/ingest/conversation` (미들웨어 게이트). Body (== **ainspace EPIC17 이 구현할 inter-repo 계약**):
  ```
  {
    thread: {
      id: string;                 // = backend conversationId (ainspace 소유 안정적 id, = orchestrator thread id)
      name?: string;
      userId: string;             // ✅ backend user id (= backend users.id, ainspace 가 auth용으로 보관 중) — 필수
      agents: Array<{ name: string; a2aUrl: string;   // ✅ a2aUrl 필수 (report 필터)
                      backendAgentId?: string;         // agent 의 backend users.id (correlation) — 권장
                      role?: string; color?: string }>
    },
    messages: Array<{
      id: string;
      speaker: string;            // "User" | <agentName>   (report isUser/name 필터용)
      content: string;
      timestamp: number;          // epoch ms
      senderA2aUrl?: string;      // agent 턴의 canonical 식별자(권장) — speaker(name) 보강
      replyTo?: string; status?: "accepted"|"dropped"
    }>
  }
  ```
  (사람 턴의 backend id 는 thread.userId, agent 턴의 backend id 는 speaker→thread.agents[].backendAgentId 로 복원되므로 message 에 별도 backend id 필드는 두지 않음.)
- [ ] 처리: `getOrCreateThread(thread)` → 각 message 를 시간순 정렬 후 `world.ingestMessage(m)`. 응답 `{ ok: true, threadId, ingested: N, skipped: M }`.
- [ ] 검증(**identity fidelity 포함**):
  - `thread.id` 필수(= backend conversationId), `thread.userId` **필수**(backend user id — 빈 값 400), `thread.agents[].a2aUrl` **필수**(canonical). `backendAgentId` 는 있으면 보존.
  - `messages[].{id,speaker,content,timestamp}` 필수, `timestamp` 숫자(ms).
  - speaker 는 `"User"` 또는 `thread.agents[].name` 중 하나(불일치 400 — 필터/`isUser` 정합).
  - **thread.agents 의 display name 은 thread 내 유일**해야 함(중복 400) — 그래야 `speaker(name) → a2aUrl` 매핑이 모호하지 않음. agent 턴 메시지는 `senderA2aUrl` 을 채우도록 권장(이름 충돌 완전 차단).
- [ ] **멱등**: 같은 message id 재-POST 는 skip 카운트로. 배치 재전송 안전.
- [ ] `server.ts` 에 `/api/ingest` mount.

### 주의사항
- speaker 계약: 사람=정확히 `"User"`, agent=agent display name(=`thread.agents[].name`). 이게 안 맞으면 report 의 `isUser` 파생과 agentNames 필터가 어긋난다.
- 배치 크기: 한 턴(user+agent 1~N)이 일반적. 대량 backfill 도 같은 엔드포인트로 가능하나 body 한계 고려(필요 시 프론트가 분할).
- provenance: 이 엔드포인트를 **ainspace 프론트만** 호출한다는 것이 "orchestrator=ainspace 대화" 불변의 근간. 토큰을 ainspace 프론트(BFF)에만 배포한다.

---

## Story 8.4: 서비스 부활 + end-to-end 검증

**수정 파일:** `docs/EPIC8-AINSPACE_DUALWRITE_INGEST.md`(본 문서), `.env.example`, `README.md`(실행 노트)

### 배경
orchestrator 를 다시 기동하고, ingest→report 경로가 실제로 동작하는지 확인한다.

### 참고 파일
- `src/server.ts:16-39`(부팅 필수 env: `LLM_API_URL`/`LLM_MODEL`), 임베딩 env(`src/services/reportPipeline/index.ts:61-85`).

### 태스크
- [ ] 기동 확인: `REDIS_URL`/`LLM_API_URL`/`LLM_MODEL`/`INGEST_TOKEN`(+임베딩 키) 세팅 후 `npm run dev`/`start`, `/api/health` 200.
- [ ] ingest 스모크: `POST /api/ingest/conversation` 로 1 human ↔ 1 agent 턴 2~3개 적재 → `GET /api/threads/:id/messages`(또는 report 입력)로 보이는지 확인.
- [ ] report 스모크: `POST /api/reports` (해당 thread scope) → `GET /api/reports/:jobId` 완료 시 그 대화가 topic/claim 으로 반영되는지 확인.
- [ ] 재-POST 멱등 확인: 같은 배치 재전송 시 `skipped` 증가, 중복 미생성.
- [ ] `README.md` 에 ingest 계약 + 실행 방법 1문단 기록.

### 주의사항
- 임베딩은 OpenAI/Azure(원본) 그대로 — sovereignty waive 는 의식적 결정(의존성 절 참조). 배포 환경에 해당 키 필요.

---

## 구현 규칙

### 데이터 경로
- ingest 는 **반드시 ThreadManager/World 경유**(in-memory + Redis 동시 갱신). Redis 직접 쓰기 금지(실행 중 프로세스에 안 보임).
- report 파이프라인이 읽는 shape(Thread/Message 필드·speaker 규약)를 절대 바꾸지 않는다. ingest 는 그 shape 를 **생성**하는 쪽.

### 금지사항
- ingest 에서 agent 호출/orchestration 트리거 금지(대화는 이미 끝난 것).
- report 파이프라인(EPIC1~7) 로직 수정 금지 — 본 EPIC 은 유입 경로만.
- shared backend(a2a-slack-notion) 나 그 DB 에 어떤 것도 쓰지 않는다(report-agnostic 유지).
- 무인증 ingest 금지(`INGEST_TOKEN` 없으면 엔드포인트 비활성).

## 완료 조건
- [ ] `POST /api/ingest/conversation` 가 인증되며, ainspace 계약 body 를 받아 thread upsert + 메시지 적재(멱등)한다.
- [ ] 적재된 대화가 **실행 중** orchestrator 의 report 파이프라인에 즉시 보인다(재시작 불필요 — in-memory 갱신 확인).
- [ ] ingest 후 `POST /api/reports` 가 그 대화를 포함한 리포트를 생성한다.
- [ ] 같은 배치 재-POST 시 중복 생성 없음(skipped 로 집계).
- [ ] agent 처리는 ingest 중 한 번도 트리거되지 않는다.
- [ ] **backend id 보존**: 적재된 thread 가 backend conversationId(=thread.id) + backend user id(=userId) + agent 의 a2aUrl·backendAgentId 를 보존한다 → backend 와 상호참조 가능. 동명 agent 가 있어도 귀속이 모호하지 않다(senderA2aUrl/backendAgentId).
- [ ] shared backend 코드/DB 무변경(orchestrator 리포지토리 안에서만 완결).
- [ ] (계약) ainspace EPIC17 이 이 body 스펙에 맞춰 dual-write 하면 end-to-end 동작.
