# TRD: T3C-Style Report Format Migration

## Overview

This Technical Requirements Document outlines the migration of A2A Orchestrator's report generation system from a Markdown-based format to a Talk to the City (T3C) inspired JSON API format with visualization support.

## Project Goals

1. **JSON API Output**: Provide structured JSON data instead of Markdown for frontend consumption
2. **Visualization Support**: Include data structures necessary for interactive visualizations
3. **Message Inclusion**: Expose individual substantive messages while filtering non-valuable content
4. **Maintain Current Pipeline**: Keep existing clustering and analysis logic intact
5. **Frontend-Ready**: Enable frontend to implement interactive features (filtering, navigation, search)

## Decisions Made

| # | Decision Point | Choice |
|---|----------------|--------|
| 1 | UI Implementation | **Option B**: JSON API only (frontend handles rendering) |
| 2 | Visualization | **Required** - Include visualization-ready data |
| 3 | Hierarchy Structure | **Evaluate** - Check if current 1-level structure works for T3C style |
| 4 | Subclusters | **Evaluate** - Check if needed or current structure sufficient |
| 5 | Individual Messages | **Include** - But filter non-substantive messages (greetings, chitchat) |
| 6 | Grounded Analysis | **Phase 1** - Moved from deferred (CRITICAL) 🔴 |
| 7 | Message Count per Opinion | **Phase 1** - Part of grounded analysis |
| 8 | Interactive Features | **Frontend** - Filtering, search, sorting implemented in frontend |
| 9 | URL Routing | **Frontend** - Deep linking handled by frontend |
| 10+ | Other decisions | **Deferred** - To be decided later |

## Scope

### In Scope
- Design and implement new JSON API response structure
- Add visualization metadata to report generation pipeline
- Update API endpoints to serve new format
- Maintain backward compatibility with Markdown endpoint
- Ensure substantive message filtering in output

### Out of Scope (Future Phases)
- Grounded analysis (opinion → quote mapping)
- Message count tracking per opinion
- Frontend implementation (separate project)
- Real-time WebSocket/SSE updates
- Public sharing links
- Cloud storage integration

## Document Structure

This TRD is split into the following task documents:

**Phase 1 (Core MVP):**
- [Task 1: JSON API Response Structure Design](./01-json-api-structure.md)
- [Task 4: Substantive Message Filtering](./04-message-filtering.md)
- [Task 5: Grounded Analysis](./05-grounded-analysis.md) 🔴 **CRITICAL - Moved to Phase 1**

**Phase 2 (Visualization & API):**
- [Task 2: Visualization Data in Report Pipeline](./02-visualization-data.md)
- [Task 3: API Endpoint Updates](./03-api-endpoints.md)

**Future Planning:**
- [Future Decisions & Deferred Features](./99-future-decisions.md)

## Success Criteria

1. ✅ JSON API returns structured data suitable for T3C-style UI
2. ✅ Frontend can render interactive topic explorer
3. ✅ All substantive messages are included and accessible
4. ✅ Non-substantive messages are properly filtered
5. ✅ Visualization metadata enables scatter plots, tree views, etc.
6. ✅ Backward compatibility maintained (Markdown endpoint still works)
7. ✅ API response time remains under 2 seconds for cached reports

## Timeline Considerations

This document focuses on **what** needs to be done and **how** to implement it, not **when**. Task prioritization and scheduling will be determined separately.

## Related Resources

- [Current Report Service](../../src/services/reportService.ts)
- [Report Pipeline](../../src/services/reportPipeline/)
- [Report Types](../../src/types/report.ts)
- [Report API Routes](../../src/routes/reports.ts)
- [Talk to the City](https://talktothe.city/)
- [T3C GitHub Repository](https://github.com/AIObjectives/tttc-light-js)

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-01-26 | Initial | Document created |
