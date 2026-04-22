/**
 * Utility functions for the report pipeline
 */

/**
 * Parse JSON response from LLM, handling markdown code fences
 * LLMs often wrap JSON in ```json or ``` blocks, this function strips those
 */
export function parseJsonResponse<T = unknown>(response: string): T {
  let jsonStr = response.trim();

  // Remove markdown code fences
  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/```\s*/g, "");
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch (error) {
    console.error("[LLM Utils] Failed to parse JSON response:", {
      originalResponse: response.substring(0, 200),
      cleanedJson: jsonStr.substring(0, 200),
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Error(`Failed to parse LLM response as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}