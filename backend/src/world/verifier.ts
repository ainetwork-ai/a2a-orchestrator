import RequestManager from "./requestManager";
import { parseJsonResponse } from "../utils/llm";

export interface VerificationResult {
  should_stop: boolean;
  stop_reason: string;
  user_intent: string;
}

export class Verifier {
  private apiUrl: string;
  private model: string;
  private userIntent: string = "";

  constructor(apiUrl: string, model: string) {
    this.apiUrl = apiUrl;
    this.model = model;
  }

  /**
   * Reset verifier for new user message
   */
  reset() {
    this.userIntent = "";
  }

  /**
   * Verify if conversation should stop based on user's initial intent
   */
  async verify(
    initialUserMessage: string,
    currentBlock: string,
    latestMessage: string,
    latestSpeaker: string,
    messageCount: number = 0
  ): Promise<VerificationResult> {
    // Determine evaluation strictness based on conversation length
    let evaluationLevel = "";
    let evaluationGuidance = "";

    if (messageCount <= 3) {
      evaluationLevel = "LENIENT";
      evaluationGuidance = "The conversation is still in early stages. Allow more discussion unless the user's intent is clearly and completely satisfied.";
    } else if (messageCount <= 7) {
      evaluationLevel = "MODERATE";
      evaluationGuidance = "The conversation has progressed moderately. Evaluate whether the user's intent has been reasonably addressed.";
    } else if (messageCount <= 12) {
      evaluationLevel = "STRICT";
      evaluationGuidance = "The conversation is becoming lengthy. Be more critical about repetition, lack of progress, or topic deviation.";
    } else {
      evaluationLevel = "VERY_STRICT";
      evaluationGuidance = "The conversation is very long. Strongly favor stopping unless there is clear, substantial progress being made toward the user's intent.";
    }

    const prompt = `Here is the user's initial message and the current conversation status.

Initial User Message:
${initialUserMessage}

Conversation Summary So Far:
${currentBlock || "(none)"}

Recent Message:
${latestSpeaker}: ${latestMessage}

Conversation Length: ${messageCount} messages
Evaluation Level: ${evaluationLevel}
Guidance: ${evaluationGuidance}

Please perform the following tasks:
1. Identify the purpose (intent) of the initial user message ${this.userIntent ? `(existing: ${this.userIntent})` : ''}
2. Determine if the current conversation has sufficiently satisfied the user's purpose
3. Or determine if the conversation is no longer making progress toward the user's purpose
4. **Apply the evaluation level based on conversation length** - longer conversations should be judged more strictly

Cases when the conversation should stop:
- Sufficient answers have been provided to the user's questions
- Information/recommendations/opinions requested by the user have been provided
- The conversation is repetitive or cycling without new insights
- The topic has completely deviated
- **For long conversations (${evaluationLevel}): Even minor repetition or lack of clear progress should trigger stopping**

Cases when the conversation should continue:
- The user's questions still lack sufficient answers
- The discussion is actively progressing with new ideas emerging
- More discussion is needed to achieve the user's purpose
- **For short conversations: Allow more exploration and discussion**

Respond in JSON format only:
{
  "user_intent": "User's message purpose (concise)",
  "should_stop": true,
  "stop_reason": "Explanation of conversation ending reason"
}

If should_stop is false, set stop_reason to an empty string.`;

    try {
      console.log(`\n[Verifier] Checking if conversation should stop...`);

      const requestManager = RequestManager.getInstance();
      const response = await requestManager.request(
        this.apiUrl,
        this.model,
        [{ role: "user", content: prompt }],
        400,
        0.3
      );

      // Parse JSON response
      const parsed = parseJsonResponse<{
        user_intent?: string;
        should_stop?: boolean;
        stop_reason?: string;
      }>(response);

      // Update user intent if this is the first time or if it changed
      if (parsed.user_intent && !this.userIntent) {
        this.userIntent = parsed.user_intent;
        console.log(`[Verifier] User intent identified: ${this.userIntent}`);
      }

      const result: VerificationResult = {
        should_stop: parsed.should_stop === true,
        stop_reason: parsed.stop_reason || "",
        user_intent: this.userIntent
      };

      if (result.should_stop) {
        console.log(`[Verifier] STOP recommended: ${result.stop_reason}`);
      } else {
        console.log(`[Verifier] Continue conversation`);
      }

      return result;
    } catch (error) {
      console.error("Error in verification:", error);
      // On error, don't stop the conversation
      return {
        should_stop: false,
        stop_reason: "",
        user_intent: this.userIntent
      };
    }
  }
}
