# Refactoring Plan: Real-time Report Updates - SSE (TRD 08)

## Overview

Server-Sent Events(SSE) 기반의 실시간 리포트 진행 상황 스트리밍 기능을 구현합니다.
기존 폴링 방식을 대체하여 즉각적인 피드백과 리소스 효율성을 제공합니다.

## Source Documents

- `docs/trd/08-realtime-updates.md` - 실시간 리포트 업데이트

## Dependencies

- **독립적 구현 가능**: TRD 12와 병렬 구현 가능
- 기존 threads.ts의 SSE 구현 패턴 참조 가능
- ReportService의 processJob 메서드 수정 필요

**Note**: TRD 12 구현 후 파이프라인 단계명 업데이트 필요

---

## 제거된 기능 (TRD 12 점검 후)

| 기능 | 제거 이유 |
|------|----------|
| **Testing (task43-49)** | 프로젝트에 테스트 인프라 없음 |

---

## Tasks

### Phase 1: Types & Interfaces

- [ ] task1 - Create `src/types/streaming.ts` with SSEEventType definition
- [ ] task2 - Define StatusEvent interface (type, jobId, status, timestamp)
- [ ] task3 - Define ProgressEvent interface (step, totalSteps, currentStep, percentage, estimatedRemainingMs)
- [ ] task4 - Define ErrorEvent interface (error, code, retryable)
- [ ] task5 - Define CompleteEvent interface (reportId, includeReport, report)
- [ ] task6 - Define HeartbeatEvent interface (timestamp only)
- [ ] task7 - Define SSEConnectionOptions interface (includeReportOnComplete, heartbeatIntervalMs, timeoutMs)
- [ ] task8 - Create union type SSEEvent for all event types

### Phase 2: SSEManager Implementation

- [ ] task9 - Create `src/services/sseManager.ts` with singleton pattern
- [ ] task10 - Implement SSEConnection interface (res, jobId, options, lastEventId, timers)
- [ ] task11 - Implement registerConnection() method with SSE headers setup
- [ ] task12 - Implement sendEvent() method with event formatting (id, event, data)
- [ ] task13 - Implement sendProgress() convenience method
- [ ] task14 - Implement sendStatus() convenience method
- [ ] task15 - Implement sendError() convenience method
- [ ] task16 - Implement sendComplete() convenience method with report inclusion option
- [ ] task17 - Implement startHeartbeat() for connection keep-alive (30s default)
- [ ] task18 - Implement startTimeout() for connection timeout (5min default)
- [ ] task19 - Implement removeConnection() with timer cleanup
- [ ] task20 - Implement closeConnection() with graceful end
- [ ] task21 - Add getConnectionCount() for monitoring

### Phase 3: API Endpoint

- [ ] task22 - Create GET /api/reports/:jobId/stream endpoint in reports.ts
- [ ] task23 - Implement query parameter parsing (includeReport, timeout)
- [ ] task24 - Add job existence validation before SSE connection
- [ ] task25 - Handle already completed jobs (immediate complete event + end)
- [ ] task26 - Handle already failed jobs (immediate error event + end)
- [ ] task27 - Register SSE connection for pending/processing jobs
- [ ] task28 - Send current status and progress immediately on connection

### Phase 4: ReportService Integration

- [ ] task29 - Import SSEManager in ReportService
- [ ] task30 - Add sendStatus("processing") when job starts
- [ ] task31 - Modify progress callback to send SSE progress events
- [ ] task32 - Add sendComplete() on successful completion
- [ ] task33 - Add sendError() on job failure
- [ ] task34 - Ensure SSE events are sent before Redis updates (for timing)

### Phase 5: Connection Management

- [ ] task35 - Handle client disconnect detection (res.on("close"))
- [ ] task36 - Implement connection cleanup on job completion
- [ ] task37 - Add logging for connection lifecycle (register, remove, timeout)
- [ ] task38 - Test multi-client connections to same job

### Phase 6: Error Handling & Edge Cases

- [ ] task39 - Handle write errors to closed connections gracefully
- [ ] task40 - Implement Last-Event-ID based reconnection support
- [ ] task41 - Add CORS headers for cross-origin SSE connections
- [ ] task42 - Handle proxy buffering (X-Accel-Buffering: no)

---

## Build Verification

- [ ] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

---

## Implementation Order

### Recommended Sequence:

1. **Tasks 1-8**: Type definitions
2. **Tasks 9-21**: SSEManager core implementation
3. **Tasks 22-28**: API endpoint
4. **Tasks 29-34**: ReportService integration
5. **Tasks 35-38**: Connection management
6. **Tasks 39-42**: Error handling & edge cases

### Critical Path:

```
Types (1-8) -> SSEManager (9-21) -> API (22-28) -> Integration (29-34)
```

### Parallel Work Opportunities:

- Tasks 17-21 (heartbeat, timeout, cleanup) can be developed in parallel
- Tasks 35-42 can be developed after API endpoint is complete

---

## TRD 12 파이프라인 단계 (업데이트 필요)

TRD 12 구현 후 progress 이벤트의 step 정보 업데이트:

```typescript
// TRD 12 이후 파이프라인 단계 (10단계)
const PIPELINE_STEPS = [
  "Parsing messages",
  "Generating embeddings",      // NEW
  "Categorizing",
  "Clustering",
  "Analyzing clusters",         // 변경 (Label + Opinions 통합)
  "Grounding opinions",
  "Calculating statistics",
  "Synthesizing insights",
  "Generating visualization",
  "Rendering report",
];

// totalSteps: 10
```

---

## Notes

### Technical Considerations

1. **Singleton Pattern**:
   - SSEManager uses singleton to maintain connection registry across the app
   - Ensures progress events reach all connected clients

2. **Event ID for Reconnection**:
   - Each event gets incremental ID per connection
   - Clients can reconnect with Last-Event-ID header

3. **Heartbeat**:
   - 30-second interval prevents proxy/firewall timeouts
   - Heartbeat event is lightweight (just timestamp)

4. **Timeout**:
   - Default 5 minutes, max 10 minutes
   - Prevents zombie connections

5. **Report Inclusion**:
   - `includeReport=true` sends full report in complete event
   - Useful for single-call flow

### SSE Event Format

```
id: 1
event: progress
data: {"type":"progress","jobId":"abc","step":2,"totalSteps":10,"currentStep":"Generating embeddings","percentage":20}

```

Note: Double newline (`\n\n`) terminates each event.

### Existing SSE Reference

The project already has SSE implementation in `src/routes/threads.ts`:
```typescript
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
res.setHeader("X-Accel-Buffering", "no");
```

### Client Usage Example

```typescript
const es = new EventSource(`/api/reports/${jobId}/stream?includeReport=true`);

es.addEventListener("progress", (e) => {
  const data = JSON.parse(e.data);
  updateProgressBar(data.percentage);
  updateStepLabel(data.currentStep);
});

es.addEventListener("complete", (e) => {
  const data = JSON.parse(e.data);
  displayReport(data.report);
  es.close();
});

es.addEventListener("error", (e) => {
  console.error("Stream error");
  es.close();
});
```

### Backward Compatibility

- Existing polling via `GET /api/reports/:jobId` continues to work
- SSE is an **additional** option, not a replacement
- Clients can choose polling or streaming based on browser support

---

## Estimated Timeline

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| Types | 1-8 | 1h |
| SSEManager | 9-21 | 5h |
| API Endpoint | 22-28 | 2h |
| ReportService Integration | 29-34 | 2h |
| Connection Management | 35-38 | 2h |
| Error Handling | 39-42 | 2h |
| **Total** | | **14h (~2 days)** |

---

## 변경 이력

| 날짜 | 변경 내용 |
|------|----------|
| 2026-01-27 | 초안 작성 |
| 2026-01-27 | TRD 12 점검 후 수정: Testing 제거, 파이프라인 단계 업데이트 |
