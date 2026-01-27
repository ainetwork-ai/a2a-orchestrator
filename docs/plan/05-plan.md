# Refactoring Plan: TRD 05 - Grounded Analysis (Opinion-Quote Linking)

## Overview

Implement "grounded analysis" - linking each AI-generated opinion/summary back to the specific messages that support it. This is T3C's defining feature that enables users to verify claims, build trust in AI-generated insights, and explore the diversity of perspectives.

## Source Document

- `05-grounded-analysis.md` - Grounded Analysis (Opinion-Quote Linking)

## Tasks

### Phase 1: Type Definitions Update

[x] task1 - Update Opinion interface in src/types/report.ts to add grounding fields (supportingMessages, mentionCount, representativeQuote, confidence)
[x] task2 - Update MessageCluster interface to change opinions from string[] to Opinion[]
[x] task3 - Add GroundingResult interface to src/types/report.ts

### Phase 2: Grounding Service Implementation

[x] task4 - Create src/services/reportPipeline/grounding.ts with groundOpinions function
[x] task5 - Implement groundClusterOpinions helper function for processing individual clusters
[x] task6 - Add LLM prompt for linking opinions to supporting messages

### Phase 3: Pipeline Integration

[x] task7 - Integrate grounding step into report pipeline (between clustering and synthesizing)
[x] task8 - Update STEPS constant to include "Grounding opinions" step
[x] task9 - Export grounding functions from pipeline index.ts

### Phase 4: Clusterer Update

[x] task10 - Update clusterer.ts to return Opinion objects instead of string[]
[x] task11 - Update ClusterAnalysisResult interface to use Opinion[]

### Phase 5: Downstream Component Updates

[x] task12 - Update visualizer.ts to handle Opinion[] instead of string[] (no change needed - only uses length)
[x] task13 - Update renderer.ts to display Opinion objects with grounding info
[x] task14 - Update reportTransformer.ts to handle backward compatibility for old string[] format

### Phase 6: Validation and Testing

[x] task15 - Update reportValidator.ts to validate grounded opinions (supportingMessages exist in cluster)

## Build Verification

[x] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

## Notes

- Maintain backward compatibility: API transformer should handle both old string[] and new Opinion[] formats
- Performance target: Grounding step should complete in < 2 seconds per cluster
- LLM-based matching approach is preferred for MVP (simpler and more interpretable)
- supportingMessages should contain 1-3 representative message IDs
- mentionCount should reflect total messages that support the opinion
- confidence should be 0-1 indicating how well supported the opinion is
