import RequestManager from "../../world/requestManager";
import {
  ReportStatistics,
  ReportSynthesis,
  SynthesizerResult,
  ReportLanguage,
} from "../../types/report";
import { PipelineTopic } from "./clusterer";
import { parseJsonResponse } from "../../utils/llm";

/**
 * Synthesize all cluster analyses into an executive summary
 */
export async function synthesizeReport(
  clusters: PipelineTopic[],
  statistics: ReportStatistics,
  apiUrl: string,
  model: string,
  language: ReportLanguage = "en"
): Promise<SynthesizerResult> {
  console.log(`[Synthesizer] Starting synthesis: ${clusters.length} clusters, language=${language}`);

  const defaultSynthesis: ReportSynthesis = {
    executiveSummary: "",
  };

  if (clusters.length === 0) {
    console.warn("[Synthesizer] No clusters to synthesize");
    return { synthesis: defaultSynthesis };
  }

  const topicSummaries = clusters.map(cluster => ({
    topic: cluster.title,
    claimCount: cluster.claims.length,
    summary: cluster.summary.text,
  }));

  const langInstruction = language === "ko"
    ? "CRITICAL: You MUST write ALL text content in Korean (한국어). Even if the input is in English, your output MUST be in Korean. Do NOT write any text in English."
    : "Write all text content in English.";

  const prompt = `You are analyzing user feedback for a product/service. Synthesize the following topic summaries into an executive summary.

${langInstruction}

Overall Statistics:
- Total opinions extracted: ${statistics.totalOpinions}
- Total threads: ${statistics.totalThreads}

Topic Summaries:
${topicSummaries.map(t => `### ${t.topic} (${t.claimCount} claims)\n${t.summary}`).join("\n\n")}

Instructions:
Write a concise 2-3 sentence executive summary for busy stakeholders that captures the overall themes and key takeaways across all topics.

Respond in JSON format only:
{
  "executiveSummary": "A concise 2-3 sentence summary."
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      1000,
      0.5
    );

    const parsed = parseJsonResponse<{
      executiveSummary?: string;
    }>(response);

    const synthesis: ReportSynthesis = {
      executiveSummary: parsed.executiveSummary || "",
    };

    console.log("[Synthesizer] Synthesis completed");
    return { synthesis };
  } catch (error) {
    console.error("[Synthesizer] Error synthesizing report:", error);
    return { synthesis: defaultSynthesis };
  }
}
