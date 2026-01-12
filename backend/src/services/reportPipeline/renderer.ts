import { ReportStatistics, MessageCluster, RendererResult, ReportLanguage } from "../../types/report";

// Localization strings
const i18n: Record<ReportLanguage, Record<string, string>> = {
  en: {
    title: "User Conversation Analysis Report",
    generatedAt: "Generated at",
    executiveSummary: "Executive Summary",
    totalMessagesAnalyzed: "Total Messages Analyzed",
    sampledFrom: "sampled from",
    totalThreads: "Total Threads",
    avgMessagesPerThread: "Average Messages per Thread",
    analysisPeriod: "Analysis Period",
    note: "Note",
    sampledNote: "Sampled from {0} total messages",
    filteredNote: "{0} non-substantive messages (greetings/chitchat) excluded",
    sentimentOverview: "Sentiment Overview",
    positive: "Positive",
    negative: "Negative",
    neutral: "Neutral",
    categoryDistribution: "Category Distribution",
    category: "Category",
    count: "Count",
    percentage: "Percentage",
    topTopics: "Top Topics",
    noTopicsIdentified: "No topics identified",
    messages: "messages",
    topicAnalysis: "Topic Analysis",
    keyOpinions: "Key Opinions & Insights",
    sampleMessages: "Sample Messages",
    appendix: "Appendix",
    methodology: "Methodology",
    methodologyDesc: "This report was generated using the following pipeline:",
    step1: "**Parsing**: User messages extracted from threads with PII anonymization",
    step2: "**Categorization**: LLM-based intent and sentiment classification",
    step3: "**Clustering**: Topic identification and message grouping",
    step4: "**Analysis**: Statistical aggregation and opinion summarization",
  },
  ko: {
    title: "사용자 대화 분석 리포트",
    generatedAt: "생성 일시",
    executiveSummary: "요약",
    totalMessagesAnalyzed: "분석된 총 메시지 수",
    sampledFrom: "전체 중 샘플링",
    totalThreads: "총 스레드 수",
    avgMessagesPerThread: "스레드당 평균 메시지 수",
    analysisPeriod: "분석 기간",
    note: "참고",
    sampledNote: "총 {0}개 메시지 중 샘플링됨",
    filteredNote: "{0}개의 비실질적 메시지(인사/잡담) 제외됨",
    sentimentOverview: "감정 분석 개요",
    positive: "긍정",
    negative: "부정",
    neutral: "중립",
    categoryDistribution: "카테고리 분포",
    category: "카테고리",
    count: "개수",
    percentage: "비율",
    topTopics: "주요 토픽",
    noTopicsIdentified: "식별된 토픽 없음",
    messages: "개 메시지",
    topicAnalysis: "토픽 상세 분석",
    keyOpinions: "주요 의견 및 인사이트",
    sampleMessages: "샘플 메시지",
    appendix: "부록",
    methodology: "분석 방법론",
    methodologyDesc: "이 리포트는 다음 파이프라인을 통해 생성되었습니다:",
    step1: "**파싱**: 스레드에서 사용자 메시지 추출 및 개인정보 익명화",
    step2: "**분류**: LLM 기반 의도 및 감정 분류",
    step3: "**클러스터링**: 토픽 식별 및 메시지 그룹화",
    step4: "**분석**: 통계 집계 및 의견 요약",
  },
};

// Map timezone to language
function getLanguageFromTimezone(timezone?: string): ReportLanguage {
  if (!timezone) return "en";

  const koreanTimezones = ["Asia/Seoul", "Asia/Pyongyang"];
  if (koreanTimezones.includes(timezone)) {
    return "ko";
  }

  return "en";
}

export interface RenderOptions {
  timezone?: string;
  language?: ReportLanguage;
}

/**
 * Render report data to Markdown format
 */
export function renderMarkdown(
  statistics: ReportStatistics,
  clusters: MessageCluster[],
  options: RenderOptions = {}
): RendererResult {
  const lang = options.language || getLanguageFromTimezone(options.timezone);
  const t = i18n[lang];
  const lines: string[] = [];

  // Format date with timezone
  const formatDateTime = (date: Date) => {
    if (options.timezone) {
      try {
        return date.toLocaleString(lang === "ko" ? "ko-KR" : "en-US", {
          timeZone: options.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch {
        return date.toISOString();
      }
    }
    return date.toISOString();
  };

  // Title
  lines.push(`# ${t.title}`);
  lines.push("");
  lines.push(`> ${t.generatedAt}: ${formatDateTime(new Date())}`);
  lines.push("");

  // Executive Summary
  lines.push(`## ${t.executiveSummary}`);
  lines.push("");
  if (statistics.wasSampled) {
    lines.push(`- **${t.totalMessagesAnalyzed}**: ${statistics.totalMessages} (${t.sampledFrom} ${statistics.totalMessagesBeforeSampling})`);
  } else {
    lines.push(`- **${t.totalMessagesAnalyzed}**: ${statistics.totalMessages}`);
  }
  lines.push(`- **${t.totalThreads}**: ${statistics.totalThreads}`);
  lines.push(`- **${t.avgMessagesPerThread}**: ${statistics.averageMessagesPerThread.toFixed(1)}`);
  lines.push(`- **${t.analysisPeriod}**: ${formatDateRange(statistics.dateRange, options.timezone, lang)}`);
  if (statistics.wasSampled || statistics.nonSubstantiveCount > 0) {
    lines.push("");
    const notes: string[] = [];
    if (statistics.wasSampled) {
      notes.push(t.sampledNote.replace("{0}", statistics.totalMessagesBeforeSampling.toString()));
    }
    if (statistics.nonSubstantiveCount > 0) {
      notes.push(t.filteredNote.replace("{0}", statistics.nonSubstantiveCount.toString()));
    }
    lines.push(`> **${t.note}**: ${notes.join(". ")}.`);
  }
  lines.push("");

  // Sentiment Overview
  lines.push(`## ${t.sentimentOverview}`);
  lines.push("");
  const totalSentiment = Object.values(statistics.sentimentDistribution).reduce((a, b) => a + b, 0);
  if (totalSentiment > 0) {
    const sentimentLabels: Record<string, string> = {
      positive: t.positive,
      negative: t.negative,
      neutral: t.neutral,
    };
    for (const [sentiment, count] of Object.entries(statistics.sentimentDistribution)) {
      const percentage = ((count / totalSentiment) * 100).toFixed(1);
      const emoji = sentiment === "positive" ? "+" : sentiment === "negative" ? "-" : "~";
      const label = sentimentLabels[sentiment] || capitalize(sentiment);
      lines.push(`- ${emoji} **${label}**: ${count} (${percentage}%)`);
    }
  }
  lines.push("");

  // Category Distribution
  lines.push(`## ${t.categoryDistribution}`);
  lines.push("");
  lines.push(`| ${t.category} | ${t.count} | ${t.percentage} |`);
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
  lines.push(`## ${t.topTopics}`);
  lines.push("");
  if (statistics.topTopics.length > 0) {
    for (let i = 0; i < statistics.topTopics.length; i++) {
      const topic = statistics.topTopics[i];
      lines.push(`${i + 1}. **${topic.topic}** - ${topic.count} ${t.messages} (${topic.percentage}%)`);
    }
  } else {
    lines.push(`_${t.noTopicsIdentified}_`);
  }
  lines.push("");

  // Topic Details with Opinions
  lines.push(`## ${t.topicAnalysis}`);
  lines.push("");
  for (const cluster of clusters) {
    lines.push(`### ${cluster.topic}`);
    lines.push("");
    lines.push(`_${cluster.messages.length} ${t.messages}_`);
    lines.push("");

    if (cluster.opinions.length > 0) {
      lines.push(`**${t.keyOpinions}:**`);
      lines.push("");
      for (const opinion of cluster.opinions) {
        lines.push(`- ${opinion}`);
      }
    }
    lines.push("");

    // Sample messages (up to 3)
    const sampleMessages = cluster.messages.slice(0, 3);
    if (sampleMessages.length > 0) {
      lines.push(`**${t.sampleMessages}:**`);
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
  lines.push(`## ${t.appendix}`);
  lines.push("");
  lines.push(`### ${t.methodology}`);
  lines.push("");
  lines.push(t.methodologyDesc);
  lines.push(`1. ${t.step1}`);
  lines.push(`2. ${t.step2}`);
  lines.push(`3. ${t.step3}`);
  lines.push(`4. ${t.step4}`);
  lines.push("");

  return { markdown: lines.join("\n") };
}

function formatDateRange(
  dateRange: { start: number; end: number },
  timezone?: string,
  lang: ReportLanguage = "en"
): string {
  const start = new Date(dateRange.start);
  const end = new Date(dateRange.end);

  const formatDate = (d: Date) => {
    if (timezone) {
      try {
        return d.toLocaleDateString(lang === "ko" ? "ko-KR" : "en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
      } catch {
        // Fallback if timezone is invalid
      }
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const startStr = formatDate(start);
  const endStr = formatDate(end);

  if (startStr === endStr) {
    return startStr;
  }
  return `${startStr} ~ ${endStr}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
