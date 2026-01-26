import {
  Report,
  ReportStatistics,
  ValidationResult,
  MessageCluster,
} from "../types/report";

/**
 * Validate that report contains only substantive messages
 */
export function validateReportMessages(report: Report): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check each cluster
  for (const cluster of report.clusters) {
    for (const message of cluster.messages) {
      // Critical: No non-substantive messages in output
      if (message.isSubstantive === false) {
        errors.push(
          `Non-substantive message found in cluster "${cluster.topic}": "${message.content.substring(0, 50)}..."`
        );
      }

      // Warning: Very short substantive messages might be misclassified
      if (message.isSubstantive && message.content.length < 10) {
        warnings.push(
          `Suspiciously short substantive message in cluster "${cluster.topic}": "${message.content}"`
        );
      }
    }
  }

  // Verify counts
  const totalMessagesInClusters = report.clusters.reduce(
    (sum, c) => sum + c.messages.length,
    0
  );

  if (totalMessagesInClusters !== report.statistics.totalMessages) {
    warnings.push(
      `Message count mismatch: clusters have ${totalMessagesInClusters} messages, statistics show ${report.statistics.totalMessages}`
    );
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

  // Check for negative values
  if (statistics.totalMessages < 0) {
    errors.push("totalMessages cannot be negative");
  }
  if (statistics.nonSubstantiveCount < 0) {
    errors.push("nonSubstantiveCount cannot be negative");
  }

  // Check date range
  if (statistics.dateRange.start > statistics.dateRange.end) {
    warnings.push(
      `Date range is inverted: start (${statistics.dateRange.start}) is after end (${statistics.dateRange.end})`
    );
  }

  // Check sampling consistency
  if (statistics.wasSampled) {
    if (statistics.totalMessages > statistics.totalMessagesBeforeSampling) {
      errors.push(
        `Total messages after sampling (${statistics.totalMessages}) exceeds original count (${statistics.totalMessagesBeforeSampling})`
      );
    }
  }

  // Check sentiment distribution totals
  const sentimentTotal = Object.values(statistics.sentimentDistribution).reduce(
    (sum, count) => sum + count,
    0
  );
  if (sentimentTotal !== statistics.totalMessages && statistics.totalMessages > 0) {
    warnings.push(
      `Sentiment distribution total (${sentimentTotal}) doesn't match total messages (${statistics.totalMessages})`
    );
  }

  // Check category distribution totals
  const categoryTotal = Object.values(statistics.categoryDistribution).reduce(
    (sum, count) => sum + count,
    0
  );
  if (categoryTotal !== statistics.totalMessages && statistics.totalMessages > 0) {
    warnings.push(
      `Category distribution total (${categoryTotal}) doesn't match total messages (${statistics.totalMessages})`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate cluster data
 */
export function validateClusters(clusters: MessageCluster[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for empty clusters
  const emptyClusters = clusters.filter((c) => c.messages.length === 0);
  if (emptyClusters.length > 0) {
    warnings.push(
      `Found ${emptyClusters.length} empty clusters: ${emptyClusters.map((c) => c.topic).join(", ")}`
    );
  }

  // Check for duplicate cluster IDs
  const clusterIds = clusters.map((c) => c.id);
  const uniqueIds = new Set(clusterIds);
  if (uniqueIds.size !== clusterIds.length) {
    errors.push("Duplicate cluster IDs found");
  }

  // Check for duplicate message IDs across all clusters
  const messageIds: string[] = [];
  for (const cluster of clusters) {
    for (const message of cluster.messages) {
      if (messageIds.includes(message.id)) {
        errors.push(
          `Duplicate message ID "${message.id}" found in cluster "${cluster.topic}"`
        );
      }
      messageIds.push(message.id);
    }
  }

  // Check for clusters with missing required fields
  for (const cluster of clusters) {
    if (!cluster.topic || cluster.topic.trim() === "") {
      errors.push(`Cluster ${cluster.id} has no topic name`);
    }
    if (!cluster.summary) {
      warnings.push(`Cluster "${cluster.topic}" has no summary`);
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
  const clusterValidation = validateClusters(report.clusters);

  return {
    isValid:
      messageValidation.isValid &&
      statsValidation.isValid &&
      clusterValidation.isValid,
    errors: [
      ...messageValidation.errors,
      ...statsValidation.errors,
      ...clusterValidation.errors,
    ],
    warnings: [
      ...messageValidation.warnings,
      ...statsValidation.warnings,
      ...clusterValidation.warnings,
    ],
  };
}

/**
 * Log filtering breakdown for debugging
 */
export function logFilteringBreakdown(
  totalMessages: number,
  substantiveCount: number,
  nonSubstantiveCount: number,
  categoryBreakdown: Record<string, { substantive: number; nonSubstantive: number }>
): void {
  console.log(`[Validator] Filtering Breakdown:`);
  console.log(`  Total messages: ${totalMessages}`);
  console.log(`  Substantive: ${substantiveCount} (${((substantiveCount / totalMessages) * 100).toFixed(1)}%)`);
  console.log(`  Non-substantive: ${nonSubstantiveCount} (${((nonSubstantiveCount / totalMessages) * 100).toFixed(1)}%)`);

  if (Object.keys(categoryBreakdown).length > 0) {
    console.log(`  By Category:`);
    for (const [category, counts] of Object.entries(categoryBreakdown)) {
      console.log(
        `    ${category}: ${counts.substantive} substantive, ${counts.nonSubstantive} non-substantive`
      );
    }
  }
}
