import { ReportStatistics, MessageCluster, RendererResult } from "../../types/report";

/**
 * Render report data to Markdown format
 */
export function renderMarkdown(
  statistics: ReportStatistics,
  clusters: MessageCluster[],
  title: string
): RendererResult {
  const lines: string[] = [];

  // Title
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Generated at: ${new Date().toISOString()}`);
  lines.push("");

  // Executive Summary
  lines.push("## Executive Summary");
  lines.push("");
  if (statistics.wasSampled) {
    lines.push(`- **Total Messages Analyzed**: ${statistics.totalMessages} (sampled from ${statistics.totalMessagesBeforeSampling})`);
  } else {
    lines.push(`- **Total Messages Analyzed**: ${statistics.totalMessages}`);
  }
  lines.push(`- **Total Threads**: ${statistics.totalThreads}`);
  lines.push(`- **Average Messages per Thread**: ${statistics.averageMessagesPerThread.toFixed(1)}`);
  lines.push(`- **Analysis Period**: ${formatDateRange(statistics.dateRange)}`);
  if (statistics.wasSampled || statistics.nonSubstantiveCount > 0) {
    lines.push("");
    const notes: string[] = [];
    if (statistics.wasSampled) {
      notes.push(`Sampled from ${statistics.totalMessagesBeforeSampling} total messages`);
    }
    if (statistics.nonSubstantiveCount > 0) {
      notes.push(`${statistics.nonSubstantiveCount} non-substantive messages (greetings/chitchat) excluded`);
    }
    lines.push(`> **Note**: ${notes.join(". ")}.`);
  }
  lines.push("");

  // Sentiment Overview
  lines.push("## Sentiment Overview");
  lines.push("");
  const totalSentiment = Object.values(statistics.sentimentDistribution).reduce((a, b) => a + b, 0);
  if (totalSentiment > 0) {
    for (const [sentiment, count] of Object.entries(statistics.sentimentDistribution)) {
      const percentage = ((count / totalSentiment) * 100).toFixed(1);
      const emoji = sentiment === "positive" ? "+" : sentiment === "negative" ? "-" : "~";
      lines.push(`- ${emoji} **${capitalize(sentiment)}**: ${count} (${percentage}%)`);
    }
  }
  lines.push("");

  // Category Distribution
  lines.push("## Category Distribution");
  lines.push("");
  lines.push("| Category | Count | Percentage |");
  lines.push("|----------|-------|------------|");
  const totalMessages = statistics.totalMessages;
  const sortedCategories = Object.entries(statistics.categoryDistribution)
    .sort((a, b) => b[1] - a[1]);
  for (const [category, count] of sortedCategories) {
    const percentage = totalMessages > 0 ? ((count / totalMessages) * 100).toFixed(1) : "0.0";
    lines.push(`| ${capitalize(category)} | ${count} | ${percentage}% |`);
  }
  lines.push("");

  // Top Topics
  lines.push("## Top Topics");
  lines.push("");
  if (statistics.topTopics.length > 0) {
    for (let i = 0; i < statistics.topTopics.length; i++) {
      const topic = statistics.topTopics[i];
      lines.push(`${i + 1}. **${topic.topic}** - ${topic.count} messages (${topic.percentage}%)`);
    }
  } else {
    lines.push("_No topics identified_");
  }
  lines.push("");

  // Topic Details with Opinions
  lines.push("## Topic Analysis");
  lines.push("");
  for (const cluster of clusters) {
    lines.push(`### ${cluster.topic}`);
    lines.push("");
    lines.push(`_${cluster.messages.length} messages_`);
    lines.push("");

    if (cluster.opinions.length > 0) {
      lines.push("**Key Opinions & Insights:**");
      lines.push("");
      for (const opinion of cluster.opinions) {
        lines.push(`- ${opinion}`);
      }
    }
    lines.push("");

    // Sample messages (up to 3)
    const sampleMessages = cluster.messages.slice(0, 3);
    if (sampleMessages.length > 0) {
      lines.push("**Sample Messages:**");
      lines.push("");
      for (const msg of sampleMessages) {
        const truncated = msg.content.length > 200
          ? msg.content.substring(0, 200) + "..."
          : msg.content;
        lines.push(`> ${truncated.replace(/\n/g, " ")}`);
        lines.push("");
      }
    }
    lines.push("---");
    lines.push("");
  }

  // Footer
  lines.push("## Appendix");
  lines.push("");
  lines.push("### Methodology");
  lines.push("");
  lines.push("This report was generated using the following pipeline:");
  lines.push("1. **Parsing**: User messages extracted from threads with PII anonymization");
  lines.push("2. **Categorization**: LLM-based intent and sentiment classification");
  lines.push("3. **Clustering**: Topic identification and message grouping");
  lines.push("4. **Analysis**: Statistical aggregation and opinion summarization");
  lines.push("");

  return { markdown: lines.join("\n") };
}

function formatDateRange(dateRange: { start: number; end: number }): string {
  const start = new Date(dateRange.start);
  const end = new Date(dateRange.end);

  const formatDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  if (formatDate(start) === formatDate(end)) {
    return formatDate(start);
  }
  return `${formatDate(start)} ~ ${formatDate(end)}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
