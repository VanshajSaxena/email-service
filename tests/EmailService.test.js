// tests/EmailService.test.js
import EmailService from "../src/EmailService.js";
import MockProviderA from "../src/MockProviderA.js";
import MockProviderB from "../src/MockProviderB.js";
import EmailStatus from "../src/EmailStatus.js";

jest.mock("../src/MockProviderA.js");
jest.mock("../src/MockProviderB.js");

jest.useFakeTimers();

describe("EmailService", () => {
  let emailService;
  let mockProviderAInstance;
  let mockProviderBInstance;

  const testEmail = {
    id: "test123",
    to: "test@example.com",
    subject: "Test",
    body: "Test email",
  };

  beforeEach(() => {
    MockProviderA.mockClear();
    MockProviderB.mockClear();

    mockProviderAInstance = { send: jest.fn(), name: "ProviderA" };
    mockProviderBInstance = { send: jest.fn(), name: "ProviderB" };

    MockProviderA.mockImplementation(() => mockProviderAInstance);
    MockProviderB.mockImplementation(() => mockProviderBInstance);

    emailService = new EmailService({
      initialBackoffMs: 10,
      rateLimitRequests: 5,
      rateLimitWindowMs: 1000,
    });
    emailService.providers = [new MockProviderA(), new MockProviderB()];
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  test("should send an email successfully with the primary provider", async () => {
    mockProviderAInstance.send.mockResolvedValue({
      success: true,
      messageId: "mA-1",
    });

    const result = await emailService.sendEmail(testEmail);

    expect(mockProviderAInstance.send).toHaveBeenCalledWith(testEmail);
    expect(mockProviderBInstance.send).not.toHaveBeenCalled();
    expect(result.currentStatus).toBe(EmailStatus.SENT);
    expect(result.messageId).toBe("mA-1");
    expect(emailService.sentEmailIds.has(testEmail.id)).toBe(true);
  });

  test("should retry with exponential backoff and succeed on second attempt", async () => {
    mockProviderAInstance.send
      .mockRejectedValueOnce(new Error("Simulated fail 1"))
      .mockResolvedValueOnce({ success: true, messageId: "mA-2" });

    const promise = emailService.sendEmail(testEmail);

    await jest.advanceTimersByTimeAsync(10);

    const result = await promise;

    expect(mockProviderAInstance.send).toHaveBeenCalledTimes(2);
    expect(result.currentStatus).toBe(EmailStatus.SENT);
    expect(result.messageId).toBe("mA-2");
    const statusHistory = emailService.getEmailStatus(testEmail.id).history;
    expect(statusHistory.some((h) => h.status === EmailStatus.RETRYING)).toBe(
      true,
    );
  });

  test("should fallback to secondary provider if primary fails consistently", async () => {
    mockProviderAInstance.send.mockRejectedValue(
      new Error("Provider A failed"),
    );
    mockProviderBInstance.send.mockResolvedValue({
      success: true,
      messageId: "mB-1",
    });

    const promise = emailService.sendEmail(testEmail);

    const result = await promise;

    expect(mockProviderAInstance.send).toHaveBeenCalledTimes(1);
    expect(mockProviderBInstance.send).toHaveBeenCalledWith(testEmail);
    expect(result.currentStatus).toBe(EmailStatus.SENT);
    expect(result.provider).toBe("ProviderB");
    expect(result.messageId).toBe("mB-1");
  });

  test("should fail after max retries with both providers failing", async () => {
    mockProviderAInstance.send.mockRejectedValue(
      new Error("Provider A failed"),
    );
    mockProviderBInstance.send.mockRejectedValue(
      new Error("Provider B failed"),
    );

    const emailServiceInstance = new EmailService({
      maxRetries: 2,
      initialBackoffMs: 10,
    });

    emailServiceInstance.providers = [
      mockProviderAInstance,
      mockProviderBInstance,
    ];

    const promise = emailServiceInstance.sendEmail(testEmail);

    await jest.runAllTimersAsync();

    const result = await promise;

    expect(mockProviderAInstance.send).toHaveBeenCalledTimes(1);
    expect(mockProviderBInstance.send).toHaveBeenCalledTimes(1);
    expect(result.currentStatus).toBe(EmailStatus.FAILED);
  });

  test("should prevent duplicate sends for the same email ID (idempotency)", async () => {
    mockProviderAInstance.send.mockResolvedValue({
      success: true,
      messageId: "mA-3",
    });

    await emailService.sendEmail(testEmail);
    const result = await emailService.sendEmail(testEmail);

    expect(mockProviderAInstance.send).toHaveBeenCalledTimes(1);
    expect(result.currentStatus).toBe(EmailStatus.SENT);
    expect(result.message).toBe("Duplicate, already sent.");
  });

  test("should rate limit requests", async () => {
    emailService = new EmailService({
      rateLimitRequests: 1,
      rateLimitWindowMs: 1000,
      initialBackoffMs: 10,
    });
    emailService.providers = [mockProviderAInstance, mockProviderBInstance];

    mockProviderAInstance.send.mockResolvedValue({
      success: true,
      messageId: "mA-rate",
    });

    const result1 = await emailService.sendEmail({ ...testEmail, id: "rate1" });
    expect(result1.currentStatus).toBe(EmailStatus.SENT);

    const result2 = await emailService.sendEmail({ ...testEmail, id: "rate2" });
    expect(result2.currentStatus).toBe(EmailStatus.QUEUED);

    jest.advanceTimersByTime(1000);

    const result3 = await emailService.sendEmail({ ...testEmail, id: "rate3" });
    expect(result3.currentStatus).toBe(EmailStatus.SENT);
    expect(mockProviderAInstance.send).toHaveBeenCalledTimes(2);
  });

  test("should track email status correctly", async () => {
    mockProviderAInstance.send.mockResolvedValue({
      success: true,
      messageId: "mA-status",
    });
    await emailService.sendEmail(testEmail);
    const status = emailService.getEmailStatus(testEmail.id);
    expect(status.currentStatus).toBe(EmailStatus.SENT);
    expect(status.provider).toBe(mockProviderAInstance.name);
    expect(status.history.length).toBeGreaterThanOrEqual(2);
    expect(
      status.history.find((s) => s.status === EmailStatus.PENDING),
    ).toBeDefined();
    expect(
      status.history.find((s) => s.status === EmailStatus.SENDING),
    ).toBeDefined();
    expect(
      status.history.find((s) => s.status === EmailStatus.SENT),
    ).toBeDefined();
  });
});
