import { randomUUID } from "node:crypto";
import {
  APPLICATION_STATUS_TRANSITIONS,
  type ApplicationStatus,
  type ApplicationView,
  type StatusEventInput,
} from "@assessment/contracts";
import { Prisma, type PrismaClient } from "@assessment/database";

export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`Application ${applicationId} was not found`);
    this.name = "ApplicationNotFoundError";
  }
}

async function readApplication(
  database: PrismaClient,
  applicationId: string,
  customerId?: string,
): Promise<ApplicationView | null> {
  const application = await database.loanApplication.findFirst({
    where: {
      id: applicationId,
      ...(customerId ? { customerId } : {}),
    },
    include: {
      customer: true,
      history: { orderBy: { occurredAt: "desc" } },
    },
  });

  if (!application) return null;

  return {
    id: application.id,
    status: application.status as ApplicationStatus,
    requestedAmountCents: application.requestedAmountCents,
    currency: application.currency,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    customer: {
      id: application.customer.id,
      name: application.customer.name,
      email: application.customer.email,
      phone: application.customer.phone,
    },
    history: application.history.map((entry) => ({
      id: entry.id,
      status: entry.status as ApplicationStatus,
      reason: entry.reason,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
    })),
  };
}

export function getApplication(
  database: PrismaClient,
  applicationId: string,
  customerId: string,
): Promise<ApplicationView | null> {
  return readApplication(database, applicationId, customerId);
}

export type StatusEventOutcome =
  | "accepted"
  | "duplicate"
  | "stale"
  | "invalid";

export interface RecordStatusEventResult {
  application: ApplicationView;
  outcome: StatusEventOutcome;
}

export async function recordStatusEvent(
  database: PrismaClient,
  applicationId: string,
  event: StatusEventInput,
): Promise<RecordStatusEventResult> {
  let outcome: StatusEventOutcome;

  try {
    outcome = await database.$transaction(async (transaction) => {
      const application = await transaction.loanApplication.findUnique({
        where: { id: applicationId },
      });

      if (!application) throw new ApplicationNotFoundError(applicationId);

      const existingEvent =
        await transaction.applicationStatusHistory.findFirst({
          where: {
            applicationId,
            sourceEventId: event.eventId,
          },
          select: { id: true },
        });

      if (existingEvent) return "duplicate";

      const occurredAt = new Date(event.occurredAt);
      if (
        application.lastEventOccurredAt &&
        occurredAt <= application.lastEventOccurredAt
      ) {
        return "stale";
      }

      const currentStatus = application.status as ApplicationStatus;
      if (!APPLICATION_STATUS_TRANSITIONS[currentStatus]?.includes(event.status)) {
        return "invalid";
      }

      await transaction.loanApplication.update({
        where: { id: applicationId },
        data: {
          status: event.status,
          lastEventOccurredAt: occurredAt,
        },
      });

      await transaction.applicationStatusHistory.create({
        data: {
          id: randomUUID(),
          applicationId,
          status: event.status,
          reason: event.reason,
          sourceEventId: event.eventId,
          occurredAt,
        },
      });

      await transaction.notificationJob.create({
        data: {
          id: randomUUID(),
          applicationId,
          sourceEventId: event.eventId,
          type: "APPLICATION_STATUS_CHANGED",
          payload: JSON.stringify({
            status: event.status,
            reason: event.reason ?? null,
          }),
        },
      });

      return "accepted";
    });
  } catch (error) {
    if (
      !(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
    ) {
      throw error;
    }

    outcome = "duplicate";
  }

  const updated = await readApplication(database, applicationId);
  if (!updated) throw new ApplicationNotFoundError(applicationId);
  return { application: updated, outcome };
}
