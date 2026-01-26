# Task 2: Visualization Data in Report Pipeline

## Objective

Enhance the report generation pipeline to produce visualization-ready data structures that enable interactive T3C-style UI components including scatter plots, topic trees, and statistical charts.

## Current State

### Current Pipeline Flow
```
Parser → Categorizer → Clusterer → Analyzer → Synthesizer → Renderer
```

Current output:
- Text-based markdown report
- Statistical aggregations
- No visualization metadata

## Required Visualizations

### 1. Scatter Plot
**Purpose**: Display messages/topics as points in 2D space

**Use Cases**:
- Sentiment vs. Time
- Topic distribution
- Message clustering visualization

**Data Requirements**:
- X/Y coordinates for each point
- Point size (message count, importance)
- Point color (sentiment, category)
- Labels and metadata

### 2. Topic Tree
**Purpose**: Hierarchical view of topics and messages

**Use Cases**:
- Navigate topic hierarchy
- Drill down into subtopics
- Explore message relationships

**Data Requirements**:
- Tree nodes (topics, subtopics, messages)
- Parent-child relationships
- Node sizes (message count)
- Node metadata

### 3. Statistical Charts
**Purpose**: Visual summaries of distributions

**Types**:
- Sentiment distribution (pie/donut chart)
- Category distribution (bar chart)
- Timeline (line/area chart)
- Topic comparison (bar chart)

**Data Requirements**:
- Chart type specification
- Data points with labels and values
- Color coding
- Metadata for interactivity

## Implementation Approach

### New Pipeline Step: Visualization Data Generator

Add a new step between Synthesizer and Renderer:

```
Parser → Categorizer → Clusterer → Analyzer → Synthesizer → **VisualizationGenerator** → Renderer
```

### File Structure
```
src/services/reportPipeline/
├── visualizer.ts          # New file
├── index.ts               # Update to include visualizer
└── ...
```

## Detailed Design

### 1. Scatter Plot Generation

```typescript
// src/services/reportPipeline/visualizer.ts

interface ScatterPlotConfig {
  xAxis: "sentiment" | "time" | "priority" | "custom";
  yAxis: "sentiment" | "time" | "priority" | "custom";
  pointType: "message" | "topic" | "both";
}

/**
 * Generate scatter plot data for messages and topics
 */
function generateScatterPlot(
  clusters: MessageCluster[],
  statistics: ReportStatistics,
  config: ScatterPlotConfig = { xAxis: "sentiment", yAxis: "priority", pointType: "both" }
): ScatterPlotData {
  const points: ScatterPoint[] = [];

  // Add topic points
  for (const cluster of clusters) {
    const topicPoint = createTopicPoint(cluster, config);
    points.push(topicPoint);

    // Add message points if requested
    if (config.pointType === "message" || config.pointType === "both") {
      for (const message of cluster.messages) {
        const messagePoint = createMessagePoint(message, cluster, config);
        points.push(messagePoint);
      }
    }
  }

  return {
    points,
    axes: {
      x: getAxisConfig(config.xAxis),
      y: getAxisConfig(config.yAxis),
    },
  };
}

/**
 * Create a scatter point for a topic
 */
function createTopicPoint(
  cluster: MessageCluster,
  config: ScatterPlotConfig
): ScatterPoint {
  // Calculate coordinates based on axis configuration
  const x = calculateCoordinate(cluster, config.xAxis, "topic");
  const y = calculateCoordinate(cluster, config.yAxis, "topic");

  // Calculate size based on message count
  const maxMessages = 100; // Could be dynamic
  const size = Math.min(cluster.messages.length / maxMessages, 1);

  // Determine color based on sentiment
  const color = getSentimentColor(cluster.summary.sentiment);

  return {
    id: cluster.id,
    type: "topic",
    x,
    y,
    label: cluster.topic,
    size,
    color,
    metadata: {
      sentiment: cluster.summary.sentiment,
      messageCount: cluster.messages.length,
    },
  };
}

/**
 * Create a scatter point for a message
 */
function createMessagePoint(
  message: CategorizedMessage,
  cluster: MessageCluster,
  config: ScatterPlotConfig
): ScatterPoint {
  const x = calculateCoordinate(message, config.xAxis, "message");
  const y = calculateCoordinate(message, config.yAxis, "message");
  const color = getSentimentColor(message.sentiment || "neutral");

  return {
    id: message.id,
    type: "message",
    x,
    y,
    label: message.content.substring(0, 50) + "...",
    size: 0.5, // Messages are smaller than topics
    color,
    metadata: {
      sentiment: message.sentiment,
      category: message.category,
      topicId: cluster.id,
    },
  };
}

/**
 * Calculate coordinate value based on axis type
 */
function calculateCoordinate(
  item: MessageCluster | CategorizedMessage,
  axis: "sentiment" | "time" | "priority" | "custom",
  itemType: "topic" | "message"
): number {
  switch (axis) {
    case "sentiment":
      return calculateSentimentScore(item);

    case "time":
      return calculateTimePosition(item);

    case "priority":
      return calculatePriorityScore(item);

    case "custom":
      // For future custom dimensions
      return Math.random();

    default:
      return 0;
  }
}

/**
 * Convert sentiment to numerical score
 * Positive: 0.5 to 1.0
 * Neutral: -0.2 to 0.5
 * Negative: -1.0 to -0.2
 */
function calculateSentimentScore(
  item: MessageCluster | CategorizedMessage
): number {
  let sentiment: string;

  if ("summary" in item) {
    // MessageCluster
    sentiment = item.summary.sentiment;
  } else {
    // CategorizedMessage
    sentiment = item.sentiment || "neutral";
  }

  // Add jitter for visual separation
  const jitter = (Math.random() - 0.5) * 0.1;

  switch (sentiment) {
    case "positive":
      return 0.75 + jitter;
    case "negative":
      return -0.6 + jitter;
    case "neutral":
      return 0.15 + jitter;
    case "mixed":
      return 0.0 + jitter;
    default:
      return 0.0;
  }
}

/**
 * Calculate time-based position (0 to 1)
 */
function calculateTimePosition(
  item: MessageCluster | CategorizedMessage
): number {
  if ("messages" in item) {
    // MessageCluster - use average timestamp
    const timestamps = item.messages.map((m) => m.timestamp);
    const avgTimestamp =
      timestamps.reduce((a, b) => a + b, 0) / timestamps.length;
    return normalizeTimestamp(avgTimestamp);
  } else {
    // CategorizedMessage
    return normalizeTimestamp(item.timestamp);
  }
}

/**
 * Calculate priority score based on action items
 */
function calculatePriorityScore(
  item: MessageCluster | CategorizedMessage
): number {
  if ("nextSteps" in item) {
    // MessageCluster - use highest priority
    const priorities = item.nextSteps.map((step) => step.priority);
    if (priorities.includes("high")) return 0.8;
    if (priorities.includes("medium")) return 0.5;
    if (priorities.includes("low")) return 0.2;
    return 0.0;
  } else {
    // CategorizedMessage - use sentiment as proxy
    return calculateSentimentScore(item);
  }
}

// Helper functions
function normalizeTimestamp(timestamp: number): number {
  // Normalize to 0-1 range based on report date range
  // Implementation depends on statistics.dateRange
  return 0.5; // Placeholder
}

function getSentimentColor(sentiment: string): string {
  const colors = {
    positive: "#4CAF50",
    negative: "#F44336",
    neutral: "#9E9E9E",
    mixed: "#FFC107",
  };
  return colors[sentiment as keyof typeof colors] || colors.neutral;
}

function getAxisConfig(axis: string) {
  const configs = {
    sentiment: { label: "Sentiment", min: -1, max: 1 },
    time: { label: "Time", min: 0, max: 1 },
    priority: { label: "Priority", min: 0, max: 1 },
  };
  return configs[axis as keyof typeof configs] || configs.sentiment;
}
```

### 2. Topic Tree Generation

```typescript
/**
 * Generate hierarchical tree structure
 */
function generateTopicTree(
  clusters: MessageCluster[],
  includeMessages: boolean = false
): TopicTreeData {
  const nodes: TreeNode[] = [];
  const links: TreeLink[] = [];

  // Root node
  const rootNode: TreeNode = {
    id: "root",
    label: "All Topics",
    type: "topic",
    value: clusters.reduce((sum, c) => sum + c.messages.length, 0),
    metadata: {},
  };
  nodes.push(rootNode);

  // Topic nodes
  for (const cluster of clusters) {
    const topicNode: TreeNode = {
      id: cluster.id,
      label: cluster.topic,
      type: "topic",
      parentId: "root",
      value: cluster.messages.length,
      metadata: {
        sentiment: cluster.summary.sentiment,
        opinionCount: cluster.opinions.length,
      },
    };
    nodes.push(topicNode);

    // Link to root
    links.push({
      source: "root",
      target: cluster.id,
      weight: cluster.messages.length,
    });

    // Message nodes (optional)
    if (includeMessages) {
      for (const message of cluster.messages.slice(0, 10)) {
        // Limit to 10 per topic for performance
        const messageNode: TreeNode = {
          id: message.id,
          label: message.content.substring(0, 30) + "...",
          type: "message",
          parentId: cluster.id,
          value: 1,
          metadata: {
            sentiment: message.sentiment,
            category: message.category,
            timestamp: message.timestamp,
          },
        };
        nodes.push(messageNode);

        links.push({
          source: cluster.id,
          target: message.id,
          weight: 1,
        });
      }
    }
  }

  return { nodes, links };
}
```

### 3. Chart Data Generation

```typescript
/**
 * Generate chart data for various visualizations
 */
function generateChartData(
  statistics: ReportStatistics,
  clusters: MessageCluster[]
): Record<string, ChartData> {
  return {
    sentiment: generateSentimentChart(statistics),
    categories: generateCategoryChart(statistics),
    topics: generateTopicChart(clusters),
    timeline: generateTimelineChart(clusters),
  };
}

function generateSentimentChart(statistics: ReportStatistics): ChartData {
  const { sentimentDistribution } = statistics;

  return {
    type: "pie",
    data: [
      {
        label: "Positive",
        value: sentimentDistribution.positive || 0,
        color: "#4CAF50",
      },
      {
        label: "Negative",
        value: sentimentDistribution.negative || 0,
        color: "#F44336",
      },
      {
        label: "Neutral",
        value: sentimentDistribution.neutral || 0,
        color: "#9E9E9E",
      },
    ].filter((d) => d.value > 0),
  };
}

function generateCategoryChart(statistics: ReportStatistics): ChartData {
  const { categoryDistribution } = statistics;

  return {
    type: "bar",
    data: Object.entries(categoryDistribution)
      .map(([label, value]) => ({
        label: capitalize(label),
        value,
        color: getCategoryColor(label),
      }))
      .sort((a, b) => b.value - a.value),
  };
}

function generateTopicChart(clusters: MessageCluster[]): ChartData {
  return {
    type: "bar",
    data: clusters
      .map((cluster) => ({
        label: cluster.topic,
        value: cluster.messages.length,
        color: getSentimentColor(cluster.summary.sentiment),
        metadata: {
          topicId: cluster.id,
          sentiment: cluster.summary.sentiment,
        },
      }))
      .sort((a, b) => b.value - a.value),
  };
}

function generateTimelineChart(clusters: MessageCluster[]): ChartData {
  // Group messages by time period
  const timeGroups = new Map<string, number>();

  for (const cluster of clusters) {
    for (const message of cluster.messages) {
      const date = new Date(message.timestamp);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      timeGroups.set(key, (timeGroups.get(key) || 0) + 1);
    }
  }

  return {
    type: "line",
    data: Array.from(timeGroups.entries())
      .map(([label, value]) => ({ label, value, color: "#2196F3" }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    question: "#2196F3",
    request: "#4ECDC4",
    feedback: "#95E1D3",
    complaint: "#FF6B6B",
    information: "#FFA07A",
    other: "#9E9E9E",
  };
  return colors[category.toLowerCase()] || colors.other;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
```

### 4. Main Visualization Generator

```typescript
// src/services/reportPipeline/visualizer.ts

import { MessageCluster, ReportStatistics, VisualizationData } from "../../types/report";

export interface VisualizerResult {
  visualization: VisualizationData;
}

/**
 * Generate all visualization data
 */
export async function generateVisualizationData(
  clusters: MessageCluster[],
  statistics: ReportStatistics
): Promise<VisualizerResult> {
  console.log(`[Visualizer] Generating visualization data for ${clusters.length} clusters`);

  const visualization: VisualizationData = {
    scatterPlot: generateScatterPlot(clusters, statistics),
    topicTree: generateTopicTree(clusters, false), // Don't include individual messages for performance
    charts: generateChartData(statistics, clusters),
  };

  console.log(`[Visualizer] Generated ${visualization.scatterPlot.points.length} scatter points`);
  console.log(`[Visualizer] Generated ${visualization.topicTree.nodes.length} tree nodes`);

  return { visualization };
}
```

## Integration into Pipeline

Update `src/services/reportPipeline/index.ts`:

```typescript
import { generateVisualizationData } from "./visualizer";

export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  // ... existing steps 1-5 ...

  // Step 6: Generate visualization data (NEW)
  updateProgress(6);
  console.log(`[ReportPipeline] Step 6: Generating visualization data`);
  const visualizerResult = await generateVisualizationData(
    clustererResult.clusters,
    analyzerResult.statistics
  );

  // Step 7: Render report (was step 6)
  updateProgress(7);
  console.log(`[ReportPipeline] Step 7: ${STEPS[6]}`);
  const rendererResult = renderMarkdown(/* ... */);

  return {
    id: reportId,
    title,
    createdAt: Date.now(),
    statistics: analyzerResult.statistics,
    clusters: clustererResult.clusters,
    synthesis: synthesizerResult.synthesis,
    visualization: visualizerResult.visualization, // NEW
    markdown: rendererResult.markdown,
  };
}
```

## Performance Considerations

### Optimization Strategies

1. **Message Limiting**: Limit messages in scatter plot (e.g., max 1000 points)
2. **Tree Depth**: Limit tree depth for large datasets
3. **Caching**: Cache visualization data separately
4. **Lazy Loading**: Frontend can request detailed data on-demand

### Performance Targets

- Visualization generation: < 500ms
- Scatter plot: Max 1000 points
- Tree nodes: Max 500 nodes initially
- Total pipeline increase: < 10%

## Testing Requirements

1. **Unit Tests**
   - Coordinate calculation accuracy
   - Color assignment correctness
   - Data structure validation

2. **Integration Tests**
   - Pipeline includes visualization step
   - Output format matches specification
   - Performance within targets

3. **Visual Tests**
   - Scatter plot renders correctly
   - Tree hierarchy is valid
   - Charts display proper data

## Acceptance Criteria

- ✅ Scatter plot data generated with correct coordinates
- ✅ Topic tree includes all topics and relationships
- ✅ Chart data includes all required visualizations
- ✅ Visualization generation completes in < 500ms
- ✅ All visualization data validates against schema
- ✅ Integration tests pass
- ✅ No regression in existing functionality

## References

- [Visualization Types](https://observablehq.com/@d3/gallery)
- [D3.js Force Layout](https://d3js.org/d3-force)
- [Scatter Plot Best Practices](https://www.data-to-viz.com/graph/scatter.html)
