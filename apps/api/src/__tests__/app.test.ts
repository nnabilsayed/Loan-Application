import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

async function resetApplication() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-a",
      name: "Test Customer",
      email: "customer@example.test",
      phone: "+201111111111",
      applications: {
        create: {
          id: "application-a",
          status: "SUBMITTED",
          requestedAmountCents: 100_000_00,
          lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          history: {
            create: {
              id: randomUUID(),
              status: "SUBMITTED",
              sourceEventId: "initial-event",
              occurredAt: new Date("2026-08-20T08:00:00.000Z"),
            },
          },
        },
      },
    },
  });
}

describe("application API", () => {
  beforeEach(resetApplication);

  it("returns an application with its history", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "application-a",
      status: "SUBMITTED",
      customer: { id: "customer-a" },
      history: [{ status: "SUBMITTED" }],
    });
    await app.close();
  });

  it("does not allow another customer to read the application", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-b" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "application not found" });
    await app.close();
  });

  it("requires a customer identity", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "customer identity is required",
    });
    await app.close();
  });

  it("records a valid partner event and queues a notification", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "partner-event-1",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T09:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().application.status).toBe("IN_REVIEW");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await app.close();
  });

  it("does not duplicate history or notifications for a retried event", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const payload = {
      eventId: "partner-event-duplicate",
      status: "IN_REVIEW",
      occurredAt: "2026-08-20T09:00:00.000Z",
      reason: "Documents received",
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload,
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload,
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(202);
    expect(firstResponse.json().outcome).toBe("accepted");
    expect(secondResponse.json().outcome).toBe("duplicate");
    await expect(
      prisma.applicationStatusHistory.count({
        where: {
          applicationId: "application-a",
          sourceEventId: "partner-event-duplicate",
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: {
          applicationId: "application-a",
          sourceEventId: "partner-event-duplicate",
        },
      }),
    ).resolves.toBe(1);
    await app.close();
  });

  it("ignores an older event that arrives after a newer event", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const newerResponse = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "partner-event-newer",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T09:00:00.000Z",
        reason: "Documents received",
      },
    });
    const olderResponse = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "partner-event-older",
        status: "SUBMITTED",
        occurredAt: "2026-08-20T08:30:00.000Z",
        reason: "Delayed partner event",
      },
    });

    expect(newerResponse.statusCode).toBe(202);
    expect(newerResponse.json().application.status).toBe("IN_REVIEW");
    expect(newerResponse.json().outcome).toBe("accepted");
    expect(olderResponse.statusCode).toBe(202);
    expect(olderResponse.json().application.status).toBe("IN_REVIEW");
    expect(olderResponse.json().outcome).toBe("stale");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { applicationId: "application-a" },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "partner-event-older" },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "partner-event-older" },
      }),
    ).resolves.toBe(0);
    await app.close();
  });

  it("rejects an invalid status transition", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "partner-event-invalid-transition",
        status: "APPROVED",
        occurredAt: "2026-08-20T09:00:00.000Z",
        reason: "Invalid direct approval",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().outcome).toBe("invalid");
    expect(response.json().application.status).toBe("SUBMITTED");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { applicationId: "application-a" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: { applicationId: "application-a" },
      }),
    ).resolves.toBe(0);
    await app.close();
  });

  it("rejects malformed partner events", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: { eventId: "", status: "UNKNOWN", occurredAt: "yesterday" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
