# EPIC9 - Report Store Reset & New-Shape Verify (백필 전 초기화 + backend-유래 shape 검증)

> ainspace 대화를 backend에서 orchestrator로 전량 re-mirror(A안, a2a-slack-notion EPIC35)하기 **직전에** orchestrator의 frozen(컷오버 이전) 대화·리포트 데이터를 초기화하고, backfill 이후 report 파이프라인(EPIC1~7)이 backend-유래 shape에서 정상 동작하는지 검증한다.

## 의존성
- EPIC8 (ingest 엔드포인트) — backfill이 `POST /api/ingest/conversation`으로 적재한다. 본 EPIC은 그 적재 **전(초기화)**과 **후(검증)**를 담당.
- EPIC1~7 (report 파이프라인) — 검증 대상. 본 EPIC은 파이프라인을 **수정하지 않는다**(측정만).
- 짝 EPIC: **a2a-slack-notion EPIC35** — backend Postgres의 ainspace 워크스페이스 대화를 ingest로 보내는 backfill 스크립트. 실행 순서상 35의 backfill 사이에 본 EPIC의 초기화(선행)·검증(후행)이 낀다.

## 배경

### 왜 초기화가 필요한가 (A안 = 전량 re-mirror)
컷오버 이전 대화는 **두 곳**에 있다: orchestrator Redis(frozen, **구 orchestrator thread id**)와 backend(**새 backend conversationId**). EPIC35 backfill이 backend 전량을 **backend id 기준**으로 다시 적재하면, 초기화 없이는 같은 대화가 (구 id 스레드) + (새 id 스레드) **두 벌로 중복**된다. 따라서 backfill 직전에 orchestrator의 대화·리포트 데이터를 비우고 단일 id 체계(backend uuid)로 재구성한다.

컷오버 이전 리포트 산출물은 소실되나, 재-mirror된 대화로 **재생성 가능**하고 구 thread id는 리포트 의미에 무관하다.

### Redis 키 스킴 (recon)
- 대화: `thread:{id}`, `threads:list`(set), `messages:{threadId}` — `threadManager.ts`/`world.ts`.
- 리포트: `report:job:{id}`, `report:cache:{key}` — `reportService.ts`.
- agent index: `orchestrator:agents`(set) — `agentService.ts`.
- 임베딩 캐시: `emb:msg:{hash}` — `reportPipeline/embedder.ts`. **content-hash 키라 재-mirror 시 캐시 히트 → 보존**(재임베딩 비용 절감).

orchestrator는 부팅 시 `loadThreadsFromRedis`(`threadManager.ts:77-101`)로 in-memory를 채우므로, **초기화는 orchestrator 정지 상태에서** 하고 재기동한다(빈 in-memory).

### 검증이 필요한 이유
backfill 데이터는 backend-유래 shape다: id=backend uuid, `speaker`="User"/agent displayName, `timestamp`=epoch ms, agent에 a2aUrl+backendAgentId, **`replyTo` 없음**, dropped status 없음. 파이프라인이 소비하는 필드(id/speaker/content/timestamp, agents[].a2aUrl/name)는 ingest가 채우도록 EPIC8에서 설계했으나, **실데이터로 확증**한다.

## 목표
- backfill 직전 orchestrator의 대화·리포트 Redis 데이터가 초기화된다(임베딩 캐시 보존).
- backfill 이후 report 파이프라인이 backend-유래 shape에서 크래시·유출 없이 topic/claim을 생성한다.
- human 실명이 리포트에 노출되지 않음을 실데이터로 확인한다.

### 비목표
- report 파이프라인 로직 변경(EPIC1~7 소관 — 결손 발견 시 이슈/후속).
- backfill 스크립트 자체(a2a-slack-notion EPIC35 소관).

---

## Story 9.1: frozen 리포트/대화 데이터 초기화 스크립트

**수정 파일:** `src/scripts/reset-report-store.ts`(신규), `package.json`(스크립트 엔트리, 옵션)

### 배경
backfill 직전 1회, orchestrator 정지 상태에서 대화·리포트 Redis 키를 비운다. 기존 일회성 스크립트 패턴(`src/scripts/export-to-backend.ts`: dryRun 기본 + `--execute`, `initRedis`/`getRedisClient`/`closeRedis`)을 따른다.

### 참고 파일
- `src/scripts/export-to-backend.ts` — 일회성 스크립트 골격(env 요구, dryRun/--execute, redis 유틸).
- `src/utils/redis.ts` — `initRedis`/`getRedisClient`/`closeRedis`.
- `src/world/threadManager.ts`·`world.ts` — `thread:*`/`threads:list`/`messages:*` 키.
- `src/services/reportService.ts` — `report:job:*`/`report:cache:*`.
- `src/services/agentService.ts` — `orchestrator:agents`.

### 태스크
- [x] `src/scripts/reset-report-store.ts`: `initRedis` 후 `SCAN`(scanIterator)으로 다음 삭제 — `thread:*`, `threads:list`, `messages:*`, `orchestrator:agents`, `report:job:*`, `report:cache:*`.
- [x] **`emb:msg:*` 는 삭제하지 않는다**(임베딩 캐시 보존). 삭제 대상에 `emb:` 키가 섞이면 중단하는 안전 가드 추가.
- [x] dryRun 기본(각 키군 카운트만 출력 + 보존 `emb:msg:*` 카운트), `--execute`로 실제 삭제. 삭제 건수 로그.
- [x] 사용법 주석: **dual-write ON → orchestrator 정지 → 이 스크립트 실행 → 재기동 → (EPIC35) backfill** 순서 명시.

### 주의사항
- 반드시 orchestrator **정지 상태**에서 실행(실행 중이면 in-memory와 Redis가 어긋남). 실행 후 재기동해야 backfill이 채운 in-memory를 report가 읽는다.
- `emb:*` 외 키만 삭제(다른 orchestrator 영속 상태 없음 — 위 키군이 전부).
- 되돌리기: 초기화는 비가역이나, EPIC35 backfill이 멱등이라 재-mirror로 복구.

---

## Story 9.2: report 파이프라인 new-shape 검증

> **런타임 전용 — 미실행(runtime-unverified).** live orchestrator + Redis + 임베딩 + EPIC35 backfill 완료가 전제라 정적 구현으로는 검증 불가. 아래 태스크는 절차 명세로 유지하며, 초기화(9.1)·backfill(EPIC35) 이후 운영자가 실행해 결과를 본 문서에 forward-only 기록한다. (구현 현황은 문서 하단 참조.)

**수정 파일:** `docs/EPIC9-REPORT_STORE_RESET_AND_SHAPE_VERIFY.md`(검증 결과 기록)

### 배경
backfill(EPIC35) 이후 backend-유래 데이터로 리포트를 실제 생성해 파이프라인 정상성을 확인한다.

### 참고 파일
- `src/services/reportPipeline/conversationParser.ts` — `getHistory()`=`getAllMessages()` flat read(replyTo 무관), `isUser = speaker==="User"`, 날짜 필터 `msg.timestamp`(ms).
- `src/services/reportPipeline/{opinionExtractor,clusterer,analyzer}.ts` — 소비 필드.

### 태스크
- [ ] backfill 후 `POST /api/reports`(ainspace 대화 scope) → `GET /api/reports/:jobId` 완료까지 폴링 → **topic/claim 생성, 크래시 0** 확인.
- [ ] **human 실명 노출 0**: 리포트/입력에서 speaker="User"로 익명, agent만 실명 확인.
- [ ] 엣지: (a) a2aUrl 없는 agent가 있어도 agentUrls 필터만 덜 정밀·crash 없음, (b) `replyTo` 없는 flat 메시지 전량 반영(EPIC8 F4), (c) ms timestamp 날짜 필터 정상, (d) 빈/초장문 대화.
- [ ] 결과를 본 문서에 forward-only 기록(정상/결손). 결손 시 파이프라인(EPIC1~7) 이슈로 분리 — 여기서 로직 수정 안 함.

### 주의사항
- 검증은 측정 — 파이프라인 미수정.
- 임베딩(OpenAI/Azure) 필요(sovereignty waive — EPIC8 의존성 절).
- 런타임 검증이라 live orchestrator + Redis + 임베딩 + backfill 완료가 전제(정적 불가).

---

## 구현 규칙

### 순서 (EPIC35와 맞물림)
- 정지 → **9.1 초기화** → 기동 → **EPIC35 backfill** → **9.2 검증**. 초기화는 backfill 직전 1회.

### 금지사항
- `emb:msg:*` 삭제 금지(캐시 보존).
- report 파이프라인(EPIC1~7) 로직 수정 금지(본 EPIC은 초기화+검증만).
- orchestrator 실행 중 초기화 금지(in-memory/Redis 불일치).

## 완료 조건
- [ ] 초기화 스크립트가 dryRun에서 삭제 대상 키군 수를 보고하고 `--execute`로 `emb:*`를 제외한 대화·리포트 키를 비운다.
- [ ] 초기화+재기동 후 orchestrator in-memory가 비어 있다(중복 재-mirror 방지 확인).
- [ ] backfill(EPIC35) 후 `POST /api/reports`가 backend-유래 데이터로 topic/claim을 정상 생성하고, human 실명이 노출되지 않는다.
- [ ] 파이프라인 크래시/결손 없음(있으면 forward-only 기록 + 후속 이슈).

> 완료 조건 4건은 **런타임 검증 항목**이라 코드 구현만으로는 체크하지 않는다. 초기화 스크립트(9.1)는 코드 완료·정적 검증됐으나(아래), dryRun/`--execute` **실행**과 in-memory·리포트·실명 확인은 live Redis/orchestrator + backfill 완료 이후 운영자가 수행한다.

---

## 구현 현황 (Story 9.1 구현 시점 — forward-only)

- **Story 9.1 코드 완료.** `src/scripts/reset-report-store.ts` 신규. `export-to-backend.ts` 일회성 스크립트 패턴 준수(dotenv, `initRedis`/`getRedisClient`/`closeRedis`, dryRun 기본 + `--execute`, `requireEnv`, `void main()` + finally `closeRedis`).
  - 삭제: `thread:*`·`messages:*`·`report:job:*`·`report:cache:*`(SCAN scanIterator, dedupe) + `threads:list`·`orchestrator:agents`(단일 Set 키, `exists`/`sCard` 카운트). `del` 500개 배치.
  - 보존: `emb:msg:*` 미삭제 + 삭제 대상에 `emb:` 혼입 시 중단 가드. `REDIS_URL` 필수(오삭제 방지) + password 마스킹 로그.
- **정적 검증 완료 / 런타임 미검증 구분(정직 기록):**
  - ✅ `tsc --noEmit` green(baseline 대비 무회귀). redis 4.7.1 타입 정의 대비 `scanIterator`(AsyncIterable<string>)·`del(string[])→number`·`exists`·`sCard` 호출 시그니처 by-construction 검증.
  - ✅ password 마스킹 정규식 단위 검증(auth 유/무·`rediss://`·IP 케이스, host:port 오탐 없음).
  - ⚠ **live Redis 대상 실행(dryRun/`--execute`)은 미실행** — 구현 환경에 Redis 부재(redis-server 미설치 + docker 데몬 정지 + 6379/6380 미기동). 실제 초기화는 운영자가 header 주석 순서대로 수행하는 **파괴적 one-off**라 여기서 실행하지 않는 것이 맞다.
- **`package.json` 엔트리 미추가(의도적):** 선례 `export-to-backend.ts`도 npm script 없이 `npx ts-node`로 실행하며, 본 파일의 "수정 파일" 라벨에도 "옵션"으로 표기됨. 일관성을 위해 미추가. 실행은 `REDIS_URL=... npx ts-node src/scripts/reset-report-store.ts [--execute]`.
- **Story 9.2 전체 런타임 미검증** — 위 Story 9.2 blockquote 참조.
