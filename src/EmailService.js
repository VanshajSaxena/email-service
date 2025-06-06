import MockProviderA from "./MockProviderA.js";
import MockProviderB from "./MockProviderB.js";
import EmailStatus from "./EmailStatus.js";
import delay from "./utils/delay.js";

// Email Service
class EmailService {
  constructor(config = {}) {
    // Providers (accepts mocks)
    this.providers = [new MockProviderA(), new MockProviderB()];
    // Current provider index
    this.currentProviderIndex = 0;

    // Max retries before failure
    this.maxRetries = config.maxRetries || 3;
    // Initial backoff in milliseconds for exponential backoff
    this.initialBackoffMs = config.initialBackoffMs || 500;

    // A set to store sent email IDs
    this.sentEmailIds = new Set();

    // No. Of request before rate limiting
    this.rateLimitRequests = config.rateLimitRequests || 5;
    // Rate limiting cooldown window in milliseconds
    this.rateLimitWindowMs = config.rateLimitWindowMs || 10000;
    // Array to store timestamps of request to calculate rate limiting
    this.requestTimestamps = [];

    // A map to store email statuses keyed with email.id
    this.emailStatuses = new Map();

    // Email queue
    this.emailQueue = [];
    // A boolean to signal if queue is being processed
    this.isProcessingQueue = true;

    // Circuit breaker map
    this.circuitBreaker = {
      // Provider 1 details
      [this.providers[0].name]: {
        failures: 0,
        lastFailureTime: null,
        isOpen: false,
      },
      // Provider 2 details
      [this.providers[1].name]: {
        failures: 0,
        lastFailureTime: null,
        isOpen: false,
      },
      // No. Of failures before breaking the circuit
      failureThreshold: config.circuitBreakerFailureThreshold || 3,
      // TimeOut before resetting the circuit status (in milliseconds)
      resetTimeoutMs: config.circuitBreakerResetTimeoutMs || 30000,
    };

    // Basic logger
    this.logger = config.logger || {
      info: (message) => console.log(`[INFO] ${message}`),
      warn: (message) => console.log(`[WARN] ${message}`),
      error: (message) => console.log(`[ERROR] ${message}`),
    };

    this.logger.info("EmailService initializing...");
  }

  /**
   * Method to send an email.
   * @param {object} email - {id, to, subject, body} - 'id' needs to be unique
   * @returns {Promise<object>} Status of email sending attempt
   */
  async sendEmail(email) {
    if (!email || !email.id || !email.to || !email.subject) {
      this.logger.error("Invalid `email` object provided.");
      return {
        emailId: email.id,
        status: EmailStatus.FAILED,
        message: "Invalid `email` object",
      };
    }

    this.updateEmailStatus(email.id, EmailStatus.PENDING);

    if (this.sentEmailIds.has(email.id)) {
      this.logger.warn(
        `Email ${email.id} already processed. Skipping duplicate send.`,
      );
      this.updateEmailStatus(email.id, EmailStatus.SENT, {
        message: "Duplicate, already sent.",
      });
      return this.getEmailStatus(email.id);
    }

    if (!this.isAllowedByRateLimiter()) {
      this.logger.warn(
        `Rate limit exceeded for email ${email.id}. Queueing email.`,
      );
      this.enqueueEmail(email);
      return this.getEmailStatus(email.id);
    }

    this.recordRequestTimestamp();

    this.updateEmailStatus(email.id, EmailStatus.SENDING, { attempt: 1 });
    return this._attemptSendWithRetries(email, 0, this.currentProviderIndex);
  }

  /**
   * Private method to attempt sending email with retries and circuit breaking.
   * @private
   */
  async _attemptSendWithRetries(email, attempt = 0, providerIndex = 0) {
    if (attempt >= this.maxRetries) {
      this.logger.error(
        `Max retries reached for email ${email.id}. Marking as FAILED.`,
      );
      this.updateEmailStatus(email.id, EmailStatus.FAILED);
      return this.getEmailStatus(email.id);
    }

    let provider = this.providers[providerIndex];

    if (this._isCircuitOpen(provider.name)) {
      this.logger.warn(
        `Circuit for ${provider.name} is OPEN. Attempting to fallback or failing fast for email ${email.id}.`,
      );
      const nextProviderIndex = (providerIndex + 1) % this.providers.length;
      if (
        nextProviderIndex !== providerIndex &&
        !this._isCircuitOpen(this.providers[nextProviderIndex].name)
      ) {
        this.logger.info(
          `Switching to provider ${this.providers[nextProviderIndex].name} due to open circuit on ${provider.name} for email ${email.id}.`,
        );
        this.currentProviderIndex = nextProviderIndex;
        return this._attemptSendWithRetries(email, attempt, nextProviderIndex);
      } else {
        this.logger.error(
          `All provider circuits are open or no fallback available for email ${email.id}.`,
        );
        this.updateEmailStatus(email.id, EmailStatus.FAILED, {
          message: `Circuit open for ${provider.name}, no fallback.`,
        });
        return this.getEmailStatus(email.id);
      }
    }

    try {
      this.logger.info(
        `Attempt ${attempt + 1}/${this.maxRetries} to send email ${email.id} via ${provider.name}.`,
      );
      this.updateEmailStatus(
        email.id,
        attempt > 0 ? EmailStatus.RETRYING : EmailStatus.SENDING,
        {
          attempt: attempt + 1,
          provider: provider.name,
        },
      );

      const result = await provider.send(email);
      this.logger.info(
        `Email ${email.id} sent successfully via ${provider.name}: ${result.messageId}`,
      );
      this.sentEmailIds.add(email.id);
      this._resetCircuit(provider.name);
      this.updateEmailStatus(email.id, EmailStatus.SENT, {
        message: `Sent successfully via ${provider.name}`,
        messageId: result.messageId,
        provider: provider.name,
      });
      return this.getEmailStatus(email.id);
    } catch (error) {
      this.logger.error(
        `Attempt ${attempt + 1} for email ${email.id} via ${provider.name} failed: ${error.error || "Unknown error"}`,
      );
      this._handleProviderFailure(provider.name);

      const nextProviderIndex = (providerIndex + 1) % this.providers.length;

      if (
        nextProviderIndex !== providerIndex &&
        attempt < this.maxRetries - 1
      ) {
        if (!this._isCircuitOpen(this.providers[nextProviderIndex].name)) {
          this.logger.info(
            `Switching from ${provider.name} to ${this.providers[nextProviderIndex].name} for email ${email.id} after failure.`,
          );
          this.currentProviderIndex = nextProviderIndex;
          return this._attemptSendWithRetries(
            email,
            attempt + 1,
            nextProviderIndex,
          );
        } else {
          this.logger.warn(
            `Fallback provider ${this.providers[nextProviderIndex].name} circuit is OPEN. Proceeding with retrying on current or failing.`,
          );
        }
      }

      // Retry with exponential backoff
      const backoffTime = this.initialBackoffMs * Math.pow(2, attempt);
      this.logger.info(`Will retry email ${email.id} in ${backoffTime}ms...`);
      this.updateEmailStatus(email.id, EmailStatus.RETRYING, {
        attempt: attempt + 1,
        nextRetryInMs: backoffTime,
        error: error.error || "Unknown Error",
      });

      // Delay till backoff
      await delay(backoffTime);

      return this._attemptSendWithRetries(
        email,
        attempt + 1,
        this.currentProviderIndex,
      );
    }
  }

  /**
   * Private method to handle provider failure and enable circuit breaking.
   * @private
   */
  _handleProviderFailure(providerName) {
    const cb = this.circuitBreaker[providerName];
    if (!cb) return;

    cb.failure++;
    cb.lastFailureTime = Date.now();

    this.logger.warn(
      `Failure recorded for ${providerName}. Current failures: ${cb.failures}`,
    );

    if (cb.failure >= this.circuitBreaker.failureThreshold) {
      if (!cb.isOpen) {
        this.logger.error(`Circuit for ${providerName} is now OPEN!`);
      }
      cb.isOpen = true;
    }
  }

  /**
   * Private method to check if the circuit is OPEN for a given provider.
   * @private
   */
  _isCircuitOpen(providerName) {
    const cb = this.circuitBreaker[providerName];
    if (!cb || !cb.isOpen) {
      return false;
    }

    if (Date.now() - cb.lastFailureTime > this.circuitBreaker.resetTimeoutMs) {
      this.logger.info(
        `Reset timeout for ${providerName} has passed. Resetting state.`,
      );

      this._resetCircuit(providerName);
      return false;
    }
    return true;
  }

  /**
   * Internal method to reset circuit after the `this.circuitBreaker.resetTimeoutMs` has passed.
   */
  _resetCircuit(providerName) {
    const cb = this.circuitBreaker[providerName];
    if (cb.isOpen) {
      this.logger.info(`Circuit for ${providerName} is now CLOSED.`);
    }
    cb.failures = 0;
    cb.lastFailureTime = null;
    cb.isOpen = false;
  }

  recordRequestTimestamp() {
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Enqueues an email and optionally enables queue processing.
   */
  enqueueEmail(email) {
    this.logger.info(`Email ${email.id} added to the queue`);
    this.emailQueue.push(email);
    this.updateEmailStatus(email.id, EmailStatus.QUEUED);
    this.processQueue(); // Process queued emails
  }

  /**
   * Async method to enable email queue processing externally (as needed).
   */
  async processQueue() {
    if (this.isProcessingQueue || this.emailQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;
    this.logger.info(`Starting queue processing...`);

    while (this.emailQueue.length > 0) {
      if (!this.isAllowedByRateLimiter()) {
        this.logger.warn(
          "Rate limit reached during queue processing. Pausing for a bit.",
        );
        await delay(this.rateLimitWindowMs / 2);
        continue;
      }

      const email = this.emailQueue.shift();
      this.logger.info(`Processing email ${email.id} from queue.`);
      this.recordRequestTimestamp();
      await this.sendEmail(email);
    }

    this.isProcessingQueue = false;
    this.logger.info("Queue processing finished.");
  }

  /**
   * Checks if rate limit is not exhausted.
   */
  isAllowedByRateLimiter() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < this.rateLimitWindowMs,
    );
    if (this.requestTimestamps.length < this.rateLimitRequests) {
      return true;
    }
    return false;
  }

  /**
   * Updates the status of email with email ID `emailId`.
   * @param {emailId} emailId
   * @param {status} status
   * @param {details} details defaults `{}`
   */
  updateEmailStatus(emailId, status, details = {}) {
    const existingStatus = this.emailStatuses.get(emailId) || {
      id: emailId,
      history: [],
    };
    const newEntry = {
      status: status,
      timestamp: new Date().toISOString(),
      ...details,
    };
    const updatedStatus = {
      ...existingStatus,
      currentStatus: status,
      lastUpdatedAt: new Date().toISOString(),
      ...details,
      history: [...existingStatus.history, newEntry],
    };
    this.emailStatuses.set(emailId, updatedStatus);
    this.logger.info(
      `Status for email ${emailId} updated to ${status}. Details: ${JSON.stringify(details)}`,
    );
  }

  /**
   * Fetches the status of an email with email ID `emailId`
   */
  getEmailStatus(emailId) {
    return (
      this.emailStatuses.get(emailId) || {
        id: emailId,
        status: EmailStatus.PENDING,
        message: "Not yet precessed.",
      }
    );
  }
  getAllEmailStatuses() {
    return Array.from(this.emailStatuses.values());
  }
}

export default EmailService;
