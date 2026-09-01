import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSender } from "../notification-provider.js";
import {
  MAX_NOTIFICATION_ATTEMPTS,
  processNotificationBatch,
} from "../process-notifications.js";

async function resetJobs() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-worker",
      name: "Worker Test",
      email: "worker@example.test",
      phone: "+201222222222",
      applications: {
        create: {
          id: "application-worker",
          status: "IN_REVIEW",
          requestedAmountCents: 50_000_00,
          notificationJobs: {
            create: {
              id: randomUUID(),
              sourceEventId: "worker-event-1",
              type: "APPLICATION_STATUS_CHANGED",
              payload: JSON.stringify({ status: "IN_REVIEW" }),
            },
          },
        },
      },
    },
  });
}

describe("notification worker", () => {
  beforeEach(resetJobs);

  it("delivers a pending status notification", async () => {
    const sender: NotificationSender = {
      sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const result = await processNotificationBatch(prisma, sender, {
      info: vi.fn(),
      error: vi.fn(),
    });

    expect(result).toEqual({ found: 1, delivered: 1, failed: 0 });
    expect(sender.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "worker-event-1",
        recipient: "worker@example.test",
      }),
    );

    const storedJob = await prisma.notificationJob.findFirstOrThrow();
    expect(storedJob.processedAt).toBeInstanceOf(Date);
    expect(storedJob.attemptCount).toBe(1);
  });

  it("keeps a failed notification eligible for retry", async () => {
    const sender: NotificationSender = {
      sendStatusUpdate: vi
        .fn()
        .mockRejectedValue(new Error("provider unavailable")),
    };

    const result = await processNotificationBatch(prisma, sender, {
      info: vi.fn(),
      error: vi.fn(),
    });

    expect(result).toEqual({ found: 1, delivered: 0, failed: 1 });

    const storedJob = await prisma.notificationJob.findFirstOrThrow();
    expect(storedJob.processedAt).toBeNull();
    expect(storedJob.deadLetteredAt).toBeNull();
    expect(storedJob.attemptCount).toBe(1);
    expect(storedJob.nextAttemptAt).toBeInstanceOf(Date);
    expect(storedJob.lastError).toBe("provider unavailable");
  });

  it("dead-letters a notification after the retry limit", async () => {
    const job = await prisma.notificationJob.findFirstOrThrow();
    await prisma.notificationJob.update({
      where: { id: job.id },
      data: {
        attemptCount: MAX_NOTIFICATION_ATTEMPTS - 1,
        nextAttemptAt: new Date("2026-08-20T08:00:00.000Z"),
      },
    });

    const sender: NotificationSender = {
      sendStatusUpdate: vi
        .fn()
        .mockRejectedValue(new Error("provider unavailable")),
    };

    const result = await processNotificationBatch(prisma, sender, {
      info: vi.fn(),
      error: vi.fn(),
    });

    expect(result).toEqual({ found: 1, delivered: 0, failed: 1 });

    const storedJob = await prisma.notificationJob.findFirstOrThrow();
    expect(storedJob.attemptCount).toBe(MAX_NOTIFICATION_ATTEMPTS);
    expect(storedJob.processedAt).toBeNull();
    expect(storedJob.nextAttemptAt).toBeNull();
    expect(storedJob.deadLetteredAt).toBeInstanceOf(Date);

    const secondResult = await processNotificationBatch(prisma, sender, {
      info: vi.fn(),
      error: vi.fn(),
    });
    expect(secondResult).toEqual({ found: 0, delivered: 0, failed: 0 });
  });
});
