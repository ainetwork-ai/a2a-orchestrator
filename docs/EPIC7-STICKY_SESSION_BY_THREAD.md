# EPIC7 - Sticky Session by threadId (LLM 호출에 thread/agent 헤더 주입)

> nginx upstream이 thread 단위로 같은 vLLM 인스턴스로 요청을 고정 라우팅하도록, orchestrator의 모든 LLM 호출에 `X-Thread-Id` / `X-Agent-Id` 헤더를 전달한다. Prefix cache hit rate 30% → 70%+ 목표.

## 의존성
- 없음 (독립 실험)
- nginx 측 `hash $http_x_thread_id consistent` 설정 변경과 **동시에** 배포되어야 효과 발생 (이 EPIC 범위 외)

## 배경

### 현재 측정된 문제 (Phase 0)
- 4 인스턴스 × 16 thread × 5턴 워크로드에서 prefix cache hit rate **30%**
- conc=16에서 p95 94초, conc=32에서 p99 163초 (30k prompt 기준)
- `least_conn` 라우팅으로 같은 thread의 2턴차 요청이 다른 인스턴스로 분산 → KV cache miss 폭증 → prefill 시간 3초 소요

### 해결 전략
- 직접 LLM 호출 경로 (RequestManager): HTTP 헤더로 `X-Thread-Id` 전달
- A2A Agent 호출 경로 (builder 경유): `X-Thread-Id` + `X-Agent-Id` 둘 다 전달 — 같은 thread 안에서 여러 agent 가 호출돼도 agent 단위 분산이 가능하도록 보조 키 제공
- nginx가 `hash $http_x_thread_id consistent` 로 라우팅 → 같은 thread 요청은 같은 인스턴스로 고정
- 같은 thread의 2턴차부터 prefix cache hit → prefill 3초 → 0.3초 기대
- 헤더 상수 및 `sanitizeHeaderValue()` 는 `src/utils/headers.ts` 에 모여있음 (모듈 경계 분리 + CR/LF 인젝션 방어)

### Orchestrator 측 작업 범위
`RequestManager.request()` 를 사용하는 5개 호출 지점 중 **thread scope가 있는** 4개 지점에 threadId 전달:
- `src/world/world.ts:156-157` (Agent Selection)
- `src/world/world.ts:249-250` (Block Summarization)
- `src/world/verifier.ts:101-102` (Verification)
- `src/services/reportPipeline/opinionExtractor.ts:172-173` (Thread-level opinion extraction)

**의도적으로 제외하는 호출 지점** (Story 7.5 참고):
- `src/services/reportPipeline/opinionExtractor.ts:319-320` (segment-level, legacy rollback 경로)
- `src/services/reportPipeline/synthesizer.ts:62-63` (cross-thread 집계)
- `src/services/reportPipeline/clusterAnalyzer.ts:166-167` (cross-thread 집계)

### A2A Agent 호출 경로도 포함 (Story 7.6)
`Agent.respond()` 는 `A2AClient.sendMessage()` 로 builder 에 요청을 보낸다 (`src/world/agents.ts:69`). builder 도 내부적으로 vLLM 을 호출하므로, **orchestrator 가 A2A HTTP 요청 헤더에 `X-Thread-Id` 를 직접 실어보내고 builder 가 passthrough 하는 구조**가 되어야 같은 thread 의 연속 호출이 같은 인스턴스로 고정된다.

#### 왜 A2A `contextId` 로는 부족한가
A2A 프로토콜에서 `contextId` 는 task 별로 새로 발급되는 게 일반적이다 (현재 `Agent.contextId` 필드가 응답마다 덮어쓰기되는 구조, `agents.ts:96-98`). 만약 builder 가 `contextId → X-Thread-Id` 로 직접 매핑하면, **같은 orchestrator thread 의 연속 호출이라도 contextId 가 매번 달라 매번 다른 vLLM 인스턴스로 라우팅 → prefix cache miss 폭증**.

#### 해결: Passthrough 설계
- Orchestrator: A2A 요청의 HTTP 헤더에 **자기 threadId** 를 `X-Thread-Id` 로 주입 (Story 7.6)
- Builder (이 EPIC 범위 밖): 수신한 A2A 요청의 `X-Thread-Id` 헤더를 읽어서 LLM 호출에 그대로 전달. 헤더 없으면 (대시보드 직접 호출 등 standalone) `contextId` 로 fallback.

## 목표
- `RequestManager.request()` 가 optional `threadId` 파라미터를 받아 fetch 헤더로 주입한다
- `world.ts`, `verifier.ts`, `opinionExtractor.ts` 의 thread-scope LLM 호출이 threadId를 전달한다
- `Agent.respond()` 의 A2A HTTP 요청에는 `X-Thread-Id` + `X-Agent-Id` 헤더가 실려 builder 가 passthrough 할 수 있다
- 모든 헤더 값은 `sanitizeHeaderValue()` 로 CR/LF strip (defensive)
- threadId 없는 호출은 종전과 동일 동작 (헤더 없이 요청) — 기존 기능 무영향
- nginx 재구성 없이도 orchestrator 단독 배포 가능 (헤더가 있어도 nginx가 무시하면 종전 라우팅)

---

## Story 7.1: RequestManager에 threadId 헤더 주입 지원

**수정 파일:** `src/world/requestManager.ts`, `src/utils/headers.ts` (신규)

### 배경
`RequestManager.request()` 는 현재 `apiUrl`, `model`, `messages`, `maxTokens`, `temperature` 5개 파라미터만 받는다. nginx sticky routing을 위해 optional `threadId` 파라미터를 추가하고, 값이 전달되면 fetch 호출에 `X-Thread-Id` 헤더를 주입한다.

> **PR 리뷰 반영**: 초기 설계는 `agentId` 도 함께 받았지만 RequestManager 경로의 모든 호출자 (`world.ts`, `verifier.ts`, `opinionExtractor.ts`) 가 `threadId` 만 전달해 dead code 였음 → 제거. A2A Agent 경로의 `X-Agent-Id` 는 Story 7.6 에서 별도 주입됨.

현재 `QueuedRequest` 인터페이스 (라인 9-18) 와 `executeRequest()` (라인 148-188) 둘 다 수정 대상. 헤더 상수/새니타이저는 `src/utils/headers.ts` 에 분리한다.

### 태스크

#### 헤더 유틸 모듈 신규 생성
- [x] `src/utils/headers.ts` 생성: `HEADER_THREAD_ID`, `HEADER_AGENT_ID` 상수 + `sanitizeHeaderValue()` 함수 export (CR/LF strip)

#### QueuedRequest 타입 확장
- [x] `QueuedRequest` 인터페이스에 `threadId?: string` 필드 추가

#### request() 시그니처 확장
- [x] `request()` 메서드에 `threadId?: string` 파라미터 추가
- [x] `this.queue.push(...)` 에 전달되는 객체에 `threadId` 포함

#### executeRequest() 헤더 주입
- [x] `executeRequest()` 에서 `threadId` 를 request 에서 destructure
- [x] fetch 호출 전에 `headers: Record<string, string>` 를 `{"Content-Type": "application/json"}` 로 초기화하고, `threadId` 가 truthy 일 때 `sanitizeHeaderValue(threadId)` 를 `HEADER_THREAD_ID` 에 주입
- [x] `fetch(apiUrl, {...})` 의 `headers` 를 새로 만든 `headers` 변수로 교체

### 주의사항
- optional 파라미터이므로 기존 호출자 (Story 7.2~7.4 이전 상태) 는 그대로 동작해야 한다
- 빈 문자열(`""`) 도 falsy로 처리되어 헤더가 주입되지 않아야 한다 (`if (threadId)` 체크로 처리됨)
- 헤더 주입은 executeRequest() 내부에서만 — retry 시에도 동일 헤더로 재시도되어야 한다 (`executeWithRetry()` 는 수정 불필요, request 객체를 그대로 넘기므로 자동 보장)
- `sanitizeHeaderValue()` 는 defensive — 현재 threadId 는 내부 생성값이지만 향후 외부 입력 경로가 생겨도 인젝션 방어됨

---

## Story 7.2: World에서 threadId 전달

**수정 파일:** `src/world/world.ts`

### 배경
`World` 클래스는 생성자에서 이미 `this.threadId: string` 을 저장하고 있다 (라인 21, 38). `requestManager.request()` 를 2곳에서 호출하므로 둘 다 `this.threadId` 를 추가 인자로 전달한다.

- 라인 156-163: `selectRelevantAgents()` 내부의 Agent Selection LLM 호출
- 라인 249-256: `summarizeBlock()` 내부의 Block Summary + Next Speaker LLM 호출

### 참고 파일
- `src/world/requestManager.ts` — Story 7.1에서 확장된 시그니처

### 태스크

#### Agent Selection 호출 (라인 156-163)
- [x] `requestManager.request(this.apiUrl, this.model, [...], 400, 0.3)` 호출 끝에 `this.threadId` 인자 추가

#### Block Summarization 호출 (라인 249-256)
- [x] `requestManager.request(this.apiUrl, this.model, [...], 600, 0.3)` 호출 끝에 `this.threadId` 인자 추가

### 주의사항
- 이 두 호출은 "thread에 속한 어떤 agent가 응답할지 결정"하는 메타 레벨 LLM 호출이라 `threadId` 만으로 sticky routing 키가 충분하다.

---

## Story 7.3: Verifier에 threadId 주입

**수정 파일:** `src/world/verifier.ts`

### 배경
`Verifier` 는 현재 생성자에서 `apiUrl`, `model` 2개만 받는다 (라인 15-18). `verify()` 메서드가 `RequestManager.getInstance().request()` 를 호출하는데 (라인 101-108) threadId 를 알 방법이 없다. 생성자에 `threadId` 를 추가하고 인스턴스 필드로 보관 → request 호출 시 전달한다.

Verifier 는 `src/world/world.ts:44` 에서 생성된다 — 여기서 `this.threadId` 를 넘겨야 한다.

### 참고 파일
- `src/world/world.ts:44` — `this.verifier = new Verifier(apiUrl, model);` (생성 지점 유일)
- 메모리: `check-all-entry-points` — 타입/시그니처 변경 시 모든 생성 지점 확인 필요

### 태스크

#### Verifier 생성자 확장
- [x] `Verifier` 클래스에 `private threadId: string;` 필드 추가 (라인 11-12 근처)
- [x] 생성자 시그니처를 `constructor(apiUrl: string, model: string, threadId: string)` 로 변경
- [x] 생성자 본문에 `this.threadId = threadId;` 추가 (라인 15-18)

#### verify() 에서 threadId 전달
- [x] `requestManager.request(this.apiUrl, this.model, [...], 400, 0.3)` 호출 끝에 `this.threadId` 인자 추가 (라인 102-108)

#### Verifier 생성 지점 업데이트
- [x] `src/world/world.ts:44` 의 `new Verifier(apiUrl, model)` → `new Verifier(apiUrl, model, threadId)` 로 변경 (생성자 스코프 라인 35-46 에서 `threadId` 파라미터가 이미 제공되고 있음)

### 주의사항
- `threadId` 를 optional(`threadId?: string`) 이 아닌 required 로 선언한다 — Verifier 는 반드시 특정 thread 문맥에서만 사용되므로 누락 시 컴파일 에러로 잡는 게 안전
- `grep "new Verifier("` 로 다른 생성 지점이 없는지 한 번 더 확인 (현재는 `world.ts:44` 유일)

---

## Story 7.4: Thread-level Opinion Extraction에 threadId 전달

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts`

### 배경
`extractFromThread()` 함수 (라인 162-223) 는 이미 `threadId: string` 을 인자로 받고 있다 (라인 164). 내부에서 `requestManager.request()` 호출 시 이 `threadId` 를 그대로 전달하면 된다 (라인 172-179).

같은 파일의 `extractFromSegment()` (라인 310-370) 는 segment 단위 legacy 경로 — EPIC5.1 에서 thread-level로 전환되어 실제 파이프라인에서는 사용되지 않으므로 수정 범위에서 제외 (Story 7.5 참고).

### 참고 파일
- `src/world/requestManager.ts` — Story 7.1에서 확장된 시그니처
- `docs/EPIC5.1-THREAD_LEVEL_TOPIC_EXTRACTION.md` — thread-level 추출 도입 배경

### 태스크

#### extractFromThread() request 호출 수정
- [x] 라인 173-179 의 `requestManager.request(apiUrl, model, [...], THREAD_EXTRACTOR_CONFIG.maxTokens, THREAD_EXTRACTOR_CONFIG.temperature)` 끝에 `threadId` 인자 추가

### 주의사항
- segment-level (`extractFromSegment`) 은 수정하지 않는다 — Story 7.5에서 명시적으로 제외 처리

---

## Story 7.5: Cross-thread LLM 호출 제외 결정 문서화

**수정 파일:** 없음 (이 EPIC 문서 내에만 기록)

### 배경
`RequestManager.request()` 를 호출하는 지점 중 **의도적으로 threadId를 전달하지 않는** 위치를 명시한다. 향후 코드 리뷰/유지보수 시 "왜 이 경로는 안 넣었지?" 혼란 방지 목적.

### 제외 지점 및 사유

| 파일:라인 | 호출 용도 | 제외 사유 |
|---|---|---|
| `opinionExtractor.ts:319-320` | segment-level opinion 추출 (legacy) | EPIC5.1에서 thread-level로 전환 완료. rollback 경로로만 존재하며 실 운영 파이프라인에서 호출되지 않음. |
| `synthesizer.ts:62-63` | 전체 topic summary 를 합쳐 executive summary 생성 | **Cross-thread 집계** — 이 호출은 전체 report 단위이지 특정 thread 단위가 아님. thread 고정 의미 없음. |
| `clusterAnalyzer.ts:166-167` | topic cluster 분석 | **Cross-thread 집계** — 여러 thread 의 opinion 을 묶어 분석. thread 고정 의미 없음. |

### 기대 동작
- 위 호출들은 헤더 없이 요청 → nginx 측 `map` 에서 `$request_id` fallback 으로 랜덤 분산됨 (PHASE2_CHANGES.md 참고)
- 이들은 큰 prompt 이지만 **빈도가 낮고** (report 생성 시에만 발동), cross-thread 특성상 캐시 히트 가능성 자체가 낮아 sticky routing 이득이 없음

### 태스크
- [x] 이 Story는 문서화 전용 — 코드 변경 없음. 수정 완료 후 완료 조건 체크 시 함께 확인.

---

## Story 7.6: Agent A2A 호출에 X-Thread-Id HTTP 헤더 주입

**수정 파일:** `src/world/agents.ts`, `src/world/world.ts`

### 배경
`Agent.respond()` → `A2AClient.sendMessage()` 경로로 builder 에 요청이 나간다 (`agents.ts:48, 69`). 이 HTTP 요청의 헤더에 **orchestrator 의 threadId** 를 실어야, builder 가 이를 읽어서 vLLM 호출로 passthrough 할 수 있다. A2A 프로토콜의 JSON-RPC body 안에 있는 `contextId` 는 task 별로 바뀌므로 sticky routing 키로 쓰면 같은 thread 의 연속 호출이 분산되어 cache miss 유발.

현재 `Agent` 클래스 (`agents.ts:8-15`) 는 threadId 를 모른다. `World` (`world.ts:42`) 가 Agent 를 생성하므로 생성자 주입이 적절. 동시성 측면에서 안전: `World` 인스턴스는 단일 threadId 에 고정되므로 그 하위 Agent 들도 단일 threadId.

`@a2a-js/sdk` 의 `A2AClientOptions` 는 `fetchImpl?: typeof fetch` 를 받는다 (`node_modules/@a2a-js/sdk/dist/client/index.d.ts:7`). 이 `fetchImpl` 에 기본 `fetch` 를 감싼 래퍼를 주입하여 모든 A2A 요청에 헤더 추가 가능.

### 참고 파일
- `src/world/agents.ts:25-31` — `getClient()` 의 A2AClient 초기화 지점 (`A2AClient.fromCardUrl(this.persona.a2aUrl)` — 현재 options 미전달)
- `src/world/world.ts:35-46` — World 생성자에서 Agent 생성 (`this.agents = personas.map((persona) => new Agent(persona))`)
- `node_modules/@a2a-js/sdk/dist/client/index.d.ts` — A2AClientOptions 타입: `{ fetchImpl?: typeof fetch; authenticationHandler?: ... }`

### 태스크

#### Agent 생성자 확장
- [x] `Agent` 클래스에 `private threadId: string;` 필드 추가 (라인 9-11 근처)
- [x] 생성자 시그니처를 `constructor(persona: AgentPersona, threadId: string)` 로 변경
- [x] 생성자 본문에 `this.threadId = threadId;` 추가

#### A2A Client 초기화 시 custom fetchImpl 주입
- [x] `getClient()` (라인 28-40) 에서 `A2AClient.fromCardUrl(this.persona.a2aUrl)` 호출을 `A2AClient.fromCardUrl(this.persona.a2aUrl, { fetchImpl: customFetch })` 로 변경
- [x] `customFetch` 는 기본 `fetch` 를 호출하되, 두 번째 인자의 `headers` 에 sanitized `X-Thread-Id`, `X-Agent-Id` 를 추가하는 wrapper 함수. 상수/새니타이저는 `src/utils/headers.ts` 에서 import
  ```ts
  const customFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(HEADER_THREAD_ID, sanitizeHeaderValue(this.threadId));
    headers.set(HEADER_AGENT_ID, sanitizeHeaderValue(this.persona.name));
    return fetch(input, { ...init, headers });
  };
  ```

#### World 에서 Agent 생성 시 threadId 전달
- [x] `world.ts:42` 의 `new Agent(persona)` → `new Agent(persona, this.threadId)` 로 변경
- [x] `world.ts:52` 의 `updateAgents()` 내부 `new Agent(persona)` 호출도 동일하게 수정 (grep 으로 추가 지점 없는지 재확인)

### 주의사항
- Agent 인스턴스 1개가 여러 threadId 를 섞어 처리하는 경로는 현재 코드에 없다 (World 는 threadId 당 1 인스턴스, Agent 는 World 당 N 인스턴스). 이 불변식이 깨지면 Story 7.6 설계가 무효화되므로, 향후 Agent 를 thread 간 공유하는 리팩토링을 할 때 주의.
- `customFetch` 는 arrow function 으로 `this` 를 capture 해야 함 (일반 `function` 사용 시 this 바인딩 꼬임)
- `AuthenticationHandler.headers()` 콜백 경로는 **사용하지 않는다** — 그건 auth 전용 세맨틱이고, sticky routing 용 헤더는 fetchImpl 쪽이 레이어상 맞음
- Builder 측이 `X-Thread-Id` 헤더를 vLLM 호출로 passthrough 하지 않으면 이 Story 의 효과는 0 — cross-component 계약이므로 builder 측 작업(`PHASE2_CHANGES.md` 변경 2) 이 같이 배포되어야 한다

---

## 구현 규칙

### 호출 순서
- Story 7.1 (requestManager 시그니처 확장) 이 **가장 먼저** 완료되어야 Story 7.2~7.4 가 컴파일됨
- Story 7.2, 7.3, 7.4 는 서로 독립적이므로 병렬 진행 가능
- Story 7.6 (Agent A2A 헤더) 은 Story 7.1~7.5 와 독립적 — 별도 병렬 진행 가능

### 헤더 이름 규칙
- `X-Thread-Id` — snake_case가 아닌 대문자 시작 케밥케이스
- `X-Agent-Id` — 동일
- nginx 측 `$http_x_thread_id` / `$http_x_agent_id` 와 매칭되어야 함 (nginx 는 헤더 이름을 lowercase + underscore 로 변환)

### 타입 시그니처
- `threadId` 는 `string | undefined` — null 사용 금지
- Verifier/Agent 생성자의 threadId 는 required (Story 7.3, 7.6), RequestManager 의 그것은 optional (Story 7.1)
- 헤더에 주입되는 모든 값은 `sanitizeHeaderValue()` 를 거친다 (CR/LF strip)

### 금지사항
- **다른 LLM 관련 코드를 리팩토링하지 말 것** — 이 EPIC은 헤더 전달 단일 목적
- `RequestManager.MAX_CONCURRENT_REQUESTS`, retry 로직 등 기존 동작 건드리지 말 것
- Report pipeline 의 cross-thread 호출 (synthesizer, clusterAnalyzer) 에 threadId 전달하지 말 것 (Story 7.5 참고)
- nginx 설정 변경은 이 EPIC 범위 밖 (PHASE2_CHANGES.md 변경 3 참고)

---

## 완료 조건

- [x] `RequestManager.request()` 가 optional `threadId` 를 받는다
- [x] `src/utils/headers.ts` 가 헤더 상수 + `sanitizeHeaderValue()` 를 제공하고, requestManager/agents 가 이를 사용한다
- [x] `World` 의 2개 requestManager 호출이 `this.threadId` 를 전달한다
- [x] `Verifier` 생성자가 `threadId` 를 받고, `verify()` 내부 requestManager 호출이 전달한다
- [x] `extractFromThread()` 내부 requestManager 호출이 `threadId` 를 전달한다
- [x] `Agent` 생성자가 `threadId` 를 받고, A2A 요청에 `X-Thread-Id` HTTP 헤더가 실려 나간다
- [x] `tsc --noEmit` 컴파일 에러 없음
- [ ] 로컬 단위 검증 1 (Orchestrator → vLLM): 에이전트 대화 1턴 수행 후 vLLM 로그/tcpdump 로 `X-Thread-Id` 헤더 확인
- [ ] 로컬 단위 검증 2 (Orchestrator → Builder): builder access log 또는 tcpdump 로 A2A 요청에 `X-Thread-Id` 헤더가 실려 들어오는지 확인
- [ ] 기존 기능 무영향: nginx 설정 변경 전 배포해도 에이전트 응답이 정상 (nginx 는 `hash` 설정 전까지 헤더 무시)
- [x] Story 7.5 의 3개 제외 지점에 threadId가 전달되지 않음을 grep으로 확인
- [ ] Builder 측 passthrough 구현과 동시 배포되어야 **end-to-end sticky routing** 발효 — 이 조건은 orchestrator 단독으로 만족 불가, cross-component 체크리스트로 분리
