import type { PrismaClient } from "@assessment/database";
import type { NotificationSender } from "./notification-provider.js";

export const MAX_NOTIFICATION_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1_000;

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface BatchResult {
  found: number;
  delivered: number;
  failed: number;
}

export async function processNotificationBatch(
  database: PrismaClient,
  sender: NotificationSender,
  logger: WorkerLogger = console,
): Promise<BatchResult> {
  const now = new Date();
  const jobs = await database.notificationJob.findMany({
    where: {
      processedAt: null,
      deadLetteredAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  let delivered = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const application = await database.loanApplication.findUnique({
        where: { id: job.applicationId },
        include: { customer: true },
      });

      if (!application) {
        throw new Error(`application ${job.applicationId} no longer exists`);
      }

      const payload = JSON.parse(job.payload) as { status: string };
      await sender.sendStatusUpdate({
        idempotencyKey: job.sourceEventId,
        recipient: application.customer.email,
        customerName: application.customer.name,
        applicationId: application.id,
        status: payload.status,
      });

      delivered += 1;
      await database.notificationJob.update({
        where: { id: job.id },
        data: {
          attemptCount: { increment: 1 },
          lastError: null,
          nextAttemptAt: null,
          processedAt: now,
        },
      });
      logger.info(`notification job ${job.id} delivered`);
    } catch (error) {
      failed += 1;
      const lastError =
        error instanceof Error ? error.message : "unknown error";
      const attemptCount = job.attemptCount + 1;
      const exhausted = attemptCount >= MAX_NOTIFICATION_ATTEMPTS;
      const nextAttemptAt = exhausted
        ? null
        : new Date(
            now.getTime() +
              RETRY_BASE_DELAY_MS * Math.pow(2, attemptCount - 1),
          );

      await database.notificationJob.update({
        where: { id: job.id },
        data: {
          attemptCount,
          lastError,
          nextAttemptAt,
          processedAt: null,
          deadLetteredAt: exhausted ? now : null,
        },
      });
      logger.error(`notification job ${job.id} failed: ${lastError}`);
    }
  }

  return { found: jobs.length, delivered, failed };
}
