# Task 1: JSON API Response Structure Design

## Objective

Design a comprehensive JSON API response structure that supports T3C-style interactive reporting while maintaining compatibility with the current report generation pipeline.

## Current State

### Current Report Type Structure
```typescript
// src/types/report.ts
interface Report {
  id: string;
  title: string;
  createdAt: number;
  statistics: ReportStatistics;
  clusters: MessageCluster[];
  synthesis?: ReportSynthesis;
  markdown: string;
}

interface MessageCluster {
  id: string;
  topic: string;
  description: string;
  messages: CategorizedMessage[];
  opinions: string[];
  summary: ClusterSummary;
  nextSteps: ActionItem[];
}

interface CategorizedMessage {
  id: string;
  content: string;
  timestamp: number;
  category: string;
  subCategory?: string;
  intent?: string;
  sentiment?: "positive" | "negative" | "neutral";
  isSubstantive: boolean;
}
```

## Proposed New Structure

### 1. Enhanced Report Response

```typescript
interface T3CReport {
  // Core metadata
  id: string;
  title: string;
  createdAt: number;
  version: string; // API version (e.g., "1.0.0")

  // Summary data
  metadata: ReportMetadata;
  statistics: ReportStatistics;
  synthesis?: ReportSynthesis;

  // Core content
  topics: Topic[];

  // Visualization support
  visualization: VisualizationData;

  // Legacy support (optional)
  markdown?: string;
}

interface ReportMetadata {
  // Request parameters
  params: ReportRequestParams;

  // Processing info
  processingTime: number; // milliseconds
  pipelineVersion: string;
  wasCached: boolean;
  cachedAt?: number;

  // Data scope
  scope: {
    totalThreads: number;
    totalMessages: number;
    substantiveMessages: number;
    filteredMessages: number;
    dateRange: {
      start: number;
      end: number;
    };
  };
}

interface Topic {
  // Topic identity
  id: string;
  name: string;
  description: string;

  // Hierarchy (for future subclusters)
  parentId?: string; // null for top-level topics
  level: number; // 0 for top-level, 1 for subclusters, etc.

  // Metrics
  messageCount: number;
  percentage: number; // % of total messages

  // Analysis
  sentiment: {
    overall: "positive" | "negative" | "mixed" | "neutral";
    distribution: {
      positive: number;
      negative: number;
      neutral: number;
    };
  };

  // Content
  opinions: Opinion[];
  messages: MessageRef[];
  summary: ClusterSummary;
  nextSteps: ActionItem[];

  // Visualization metadata
  position?: {
    x: number;
    y: number;
  };
  color?: string;
}

interface Opinion {
  id: string;
  text: string;
  type: "consensus" | "conflicting" | "general";

  // Future: Grounded analysis
  // supportingMessages?: string[]; // Message IDs
  // mentionCount?: number;
}

interface MessageRef {
  id: string;
  content: string;
  timestamp: number;

  // Categorization
  category: string;
  subCategory?: string;
  intent?: string;
  sentiment: "positive" | "negative" | "neutral";

  // Metadata
  isSubstantive: boolean;

  // Context (anonymized)
  context?: {
    threadId?: string; // Optional: if metadata decision is made
    // No userId to maintain anonymization
  };
}
```

### 2. Visualization Data Structure

```typescript
interface VisualizationData {
  // For scatter plot
  scatterPlot: {
    points: ScatterPoint[];
    axes: {
      x: { label: string; min: number; max: number };
      y: { label: string; min: number; max: number };
    };
  };

  // For topic tree
  topicTree: {
    nodes: TreeNode[];
    links: TreeLink[];
  };

  // For charts
  charts: {
    sentiment: ChartData;
    categories: ChartData;
    timeline?: ChartData;
  };
}

interface ScatterPoint {
  id: string; // Message ID or Topic ID
  type: "message" | "topic" | "cluster";
  x: number;
  y: number;
  label: string;
  size?: number; // For variable-size points
  color?: string;
  metadata: {
    sentiment?: string;
    category?: string;
    messageCount?: number;
  };
}

interface TreeNode {
  id: string;
  label: string;
  type: "topic" | "subtopic" | "message";
  parentId?: string;
  value: number; // For sizing
  metadata: Record<string, any>;
}

interface TreeLink {
  source: string; // Node ID
  target: string; // Node ID
  weight?: number;
}

interface ChartData {
  type: "bar" | "pie" | "line" | "area";
  data: {
    label: string;
    value: number;
    color?: string;
    metadata?: Record<string, any>;
  }[];
}
```

## API Response Format

### Success Response

```json
{
  "success": true,
  "jobId": "uuid",
  "status": "completed",
  "report": {
    "id": "report-uuid",
    "title": "User Conversation Analysis Report",
    "createdAt": 1706227200000,
    "version": "1.0.0",

    "metadata": {
      "params": {
        "threadIds": ["thread-1", "thread-2"],
        "startDate": "2026-01-01",
        "endDate": "2026-01-26"
      },
      "processingTime": 5432,
      "pipelineVersion": "1.0.0",
      "wasCached": false,
      "scope": {
        "totalThreads": 2,
        "totalMessages": 150,
        "substantiveMessages": 120,
        "filteredMessages": 30,
        "dateRange": {
          "start": 1704067200000,
          "end": 1706227200000
        }
      }
    },

    "statistics": { /* existing structure */ },
    "synthesis": { /* existing structure */ },

    "topics": [
      {
        "id": "topic-1",
        "name": "Feature Requests",
        "description": "Messages requesting new features",
        "parentId": null,
        "level": 0,
        "messageCount": 45,
        "percentage": 37.5,

        "sentiment": {
          "overall": "mixed",
          "distribution": {
            "positive": 20,
            "negative": 15,
            "neutral": 10
          }
        },

        "opinions": [
          {
            "id": "op-1",
            "text": "Users want faster loading times",
            "type": "consensus"
          }
        ],

        "messages": [
          {
            "id": "msg-1",
            "content": "The app takes too long to load",
            "timestamp": 1706100000000,
            "category": "complaint",
            "subCategory": "performance",
            "intent": "Report slow performance",
            "sentiment": "negative",
            "isSubstantive": true
          }
        ],

        "summary": {
          "consensus": ["Fast loading is important"],
          "conflicting": [],
          "sentiment": "mixed"
        },

        "nextSteps": [
          {
            "action": "Optimize loading performance",
            "priority": "high",
            "rationale": "Multiple complaints about slow loading"
          }
        ],

        "position": { "x": 0.3, "y": 0.7 },
        "color": "#FF6B6B"
      }
    ],

    "visualization": {
      "scatterPlot": {
        "points": [
          {
            "id": "msg-1",
            "type": "message",
            "x": 0.3,
            "y": 0.7,
            "label": "The app takes too long...",
            "size": 1,
            "color": "#FF6B6B",
            "metadata": {
              "sentiment": "negative",
              "category": "complaint"
            }
          }
        ],
        "axes": {
          "x": { "label": "Sentiment", "min": -1, "max": 1 },
          "y": { "label": "Priority", "min": 0, "max": 1 }
        }
      },

      "topicTree": {
        "nodes": [
          {
            "id": "topic-1",
            "label": "Feature Requests",
            "type": "topic",
            "value": 45,
            "metadata": { "sentiment": "mixed" }
          }
        ],
        "links": []
      },

      "charts": {
        "sentiment": {
          "type": "pie",
          "data": [
            { "label": "Positive", "value": 20, "color": "#4CAF50" },
            { "label": "Negative", "value": 15, "color": "#F44336" },
            { "label": "Neutral", "value": 10, "color": "#9E9E9E" }
          ]
        },
        "categories": {
          "type": "bar",
          "data": [
            { "label": "Complaint", "value": 45, "color": "#FF6B6B" },
            { "label": "Request", "value": 35, "color": "#4ECDC4" }
          ]
        }
      }
    },

    "markdown": "# Report\n\n..." // Optional legacy format
  }
}
```

## Implementation Plan

### Phase 1: Type Definitions
1. Create new types in `src/types/report.ts`
2. Keep existing types for backward compatibility
3. Add version field to distinguish formats

### Phase 2: Data Transformation
1. Create transformer utility to convert current Report → T3CReport
2. Add visualization data generation logic
3. Ensure all substantive messages are included in output

### Phase 3: API Integration
1. Update `reportService.ts` to support new format
2. Add format parameter to API requests
3. Maintain both formats during transition period

## Backward Compatibility

The new structure maintains backward compatibility by:
1. Keeping `markdown` field as optional
2. Preserving existing `statistics` and `synthesis` structures
3. Adding new fields without removing old ones
4. Using version field to indicate format

## Testing Requirements

1. **Unit Tests**
   - Type validation for all new interfaces
   - Data transformation correctness
   - Visualization data generation

2. **Integration Tests**
   - API returns correct format
   - Both old and new formats work
   - Performance remains acceptable

3. **Data Validation**
   - All messages are substantive
   - Topic hierarchy is valid
   - Visualization data is complete

## Acceptance Criteria

- ✅ New TypeScript interfaces defined and documented
- ✅ JSON response includes all required fields
- ✅ Visualization data is properly structured
- ✅ All substantive messages are included
- ✅ Backward compatibility maintained
- ✅ API response validates against schema
- ✅ Performance impact is minimal (<10% increase in response time)

## References

- [Current Report Types](../../src/types/report.ts)
- [Talk to the City Report Example](https://talktothe.city/report/HAcEAQ3bTfXlWhtCXHa7)
- JSON Schema for validation (to be created)
