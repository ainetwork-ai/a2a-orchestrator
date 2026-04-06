import {
  Report,
  ReportStatistics,
  ValidationResult,
  Topic,
} from "../types/report";

/**
 * Validate report topics have valid claims
 */
export function validateReportMessages(report: Report): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const topic of report.topics) {
    if (topic.claims.length === 0) {
      warnings.push(
        `Topic "${topic.title}" has no claims`
      );
    }

    for (const claim of topic.claims) {
      if (!claim.title || claim.title.trim() === "") {
        errors.push(
          `Claim "${claim.id}" in topic "${topic.title}" has empty title`
        );
      }

      if (claim.quotes.length === 0) {
        warnings.push(
          `Claim "${claim.id}" in topic "${topic.title}" has no quotes (no source reference)`
        );
      }

      for (const quote of claim.quotes) {
        if (!quote.reference.segmentId) {
          warnings.push(
            `Quote "${quote.id}" in claim "${claim.id}" has no segment reference`
          );
        }
      }

      if (claim.confidence < 0 || claim.confidence > 1) {
        warnings.push(
          `Claim "${claim.id}" has invalid confidence value (${claim.confidence}), expected 0-1`
        );
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate statistics consistency
 */
export function validateStatistics(statistics: ReportStatistics): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (statistics.totalOpinions < 0) {
    errors.push("totalOpinions cannot be negative");
  }

  if (statistics.dateRange.start > statistics.dateRange.end) {
    warnings.push(
      `Date range is inverted: start (${statistics.dateRange.start}) is after end (${statistics.dateRange.end})`
    );
  }

  // Check stance distribution totals
  const stanceTotal = Object.values(statistics.stanceDistribution).reduce(
    (sum: number, count: number) => sum + count,
    0
  );
  if (stanceTotal !== statistics.totalOpinions && statistics.totalOpinions > 0) {
    warnings.push(
      `Stance distribution total (${stanceTotal}) doesn't match total opinions (${statistics.totalOpinions})`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate topic data
 */
export function validateTopics(topics: Topic[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (topics.length === 0) {
    warnings.push("Report has no topics");
  }

  const topicIds = topics.map((t) => t.id);
  const uniqueIds = new Set(topicIds);
  if (uniqueIds.size !== topicIds.length) {
    errors.push("Duplicate topic IDs found");
  }

  for (const topic of topics) {
    if (!topic.title || topic.title.trim() === "") {
      errors.push(`Topic ${topic.id} has no title`);
    }
    if (!topic.summary) {
      warnings.push(`Topic "${topic.title}" has no summary`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Comprehensive report validation
 */
export function validateReport(report: Report): ValidationResult {
  const messageValidation = validateReportMessages(report);
  const statsValidation = validateStatistics(report.statistics);
  const topicValidation = validateTopics(report.topics);

  return {
    isValid:
      messageValidation.isValid &&
      statsValidation.isValid &&
      topicValidation.isValid,
    errors: [
      ...messageValidation.errors,
      ...statsValidation.errors,
      ...topicValidation.errors,
    ],
    warnings: [
      ...messageValidation.warnings,
      ...statsValidation.warnings,
      ...topicValidation.warnings,
    ],
  };
}
