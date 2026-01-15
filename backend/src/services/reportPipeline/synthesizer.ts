import RequestManager from "../../world/requestManager";
import {
  MessageCluster,
  ReportStatistics,
  ReportSynthesis,
  SynthesizerResult,
  ReportLanguage,
  ActionItem,
} from "../../types/report";

/**
 * Synthesize all cluster analyses into a total summary
 */
export async function synthesizeReport(
  clusters: MessageCluster[],
  statistics: ReportStatistics,
  apiUrl: string,
  model: string,
  language: ReportLanguage = "en"
): Promise<SynthesizerResult> {
  console.log(`[Synthesizer] Starting synthesis: ${clusters.length} clusters, language=${language}`);

  const defaultSynthesis: ReportSynthesis = {
    overallSentiment: "neutral",
    keyFindings: [],
    topPriorities: [],
    executiveSummary: "",
  };

  if (clusters.length === 0) {
    console.warn("[Synthesizer] No clusters to synthesize");
    return { synthesis: defaultSynthesis };
  }

  // Prepare cluster summaries for the prompt
  const clusterSummaries = clusters.map(cluster => ({
    topic: cluster.topic,
    messageCount: cluster.messages.length,
    sentiment: cluster.summary.sentiment,
    consensus: cluster.summary.consensus,
    conflicting: cluster.summary.conflicting,
    nextSteps: cluster.nextSteps,
  }));

  const langInstruction = language === "ko"
    ? "IMPORTANT: Write ALL text content in Korean."
    : "Write all text content in English.";

  const prompt = `You are analyzing user feedback for a product/service. Synthesize the following topic analyses into an executive summary.

${langInstruction}

Overall Statistics:
- Total messages analyzed: ${statistics.totalMessages}
- Total threads: ${statistics.totalThreads}
- Sentiment distribution: ${JSON.stringify(statistics.sentimentDistribution)}

Topic Analyses:
${JSON.stringify(clusterSummaries, null, 2)}

Instructions:
1. Determine the overall sentiment across all topics
2. Identify 3-5 key findings that decision makers should know
3. Prioritize the top 3-5 action items from all topics (combine similar ones, rank by impact)
4. Write a 2-3 sentence executive summary for busy stakeholders

Respond in JSON format only:
{
  "overallSentiment": "mixed",
  "keyFindings": [
    "Finding 1: ...",
    "Finding 2: ..."
  ],
  "topPriorities": [
    {
      "action": "Most important action",
      "priority": "high",
      "rationale": "Why this matters most"
    }
  ],
  "executiveSummary": "A concise 2-3 sentence summary of the overall user feedback and recommended direction."
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      2000,
      0.5
    );

    let jsonStr = response.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```\s*/g, "");
    }

    const parsed = JSON.parse(jsonStr);

    const synthesis: ReportSynthesis = {
      overallSentiment: parsed.overallSentiment || "neutral",
      keyFindings: parsed.keyFindings || [],
      topPriorities: (parsed.topPriorities || []).map((step: any) => ({
        action: step.action || "",
        priority: step.priority || "medium",
        rationale: step.rationale || "",
      })).filter((step: ActionItem) => step.action),
      executiveSummary: parsed.executiveSummary || "",
    };

    console.log("[Synthesizer] Synthesis completed");
    return { synthesis };
  } catch (error) {
    console.error("[Synthesizer] Error synthesizing report:", error);
    return { synthesis: defaultSynthesis };
  }
}
