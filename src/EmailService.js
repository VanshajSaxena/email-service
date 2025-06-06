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
    // Validate email object.
    if (!email || !email.id || !email.to || !email.subject) {
      this.logger.error("Invalid `email` object provided.");
      return {
        emailId: email.id,
        status: EmailStatus.FAILED,
        message: "Invalid `email` object",
      };
    }

    // Update email status to `PENDING`.
    this.updateEmailStatus(email.id, EmailStatus.PENDING);

    // Check if the email with the same `id` has been sent before.
    if (this.sentEmailIds.has(email.id)) {
      this.logger.warn(
        `Email ${email.id} already processed. Skipping duplicate send.`,
      );
      this.updateEmailStatus(email.id, EmailStatus.SENT, {
        message: "Duplicate, already sent.",
      });
      // Return status if was already sent.
      return this.getEmailStatus(email.id);
    }

    // Check rate limiter if requests are too frequent.
    if (!this.isAllowedByRateLimiter()) {
      this.logger.warn(
        `Rate limit exceeded for email ${email.id}. Queueing email.`,
      );
      // Enqueue email if rate limited.
      this.enqueueEmail(email);
      // Return status.
      return this.getEmailStatus(email.id);
    }

    // Record timestamp of request for future rate limiting.
    this.recordRequestTimestamp();

    this.updateEmailStatus(email.id, EmailStatus.SENDING, { attempt: 1 });
    // Attempt sending with retires.
    return this._attemptSendWithRetries(email, 0, this.currentProviderIndex);
  }

  /**
   * Private method to attempt sending email with retries and circuit breaking.
   * @private
   */
  async _attemptSendWithRetries(email, attempt = 0, providerIndex = 0) {
    // If max tries has been reached; abort and return with failure.
    if (attempt >= this.maxRetries) {
      this.logger.error(
        `Max retries reached for email ${email.id}. Marking as FAILED.`,
      );
      this.updateEmailStatus(email.id, EmailStatus.FAILED);
      return this.getEmailStatus(email.id);
    }

    // Get provider.
    let provider = this.providers[providerIndex];

    // Check if circuit is OPEN for the provider.
    if (this._isCircuitOpen(provider.name)) {
      this.logger.warn(
        `Circuit for ${provider.name} is OPEN. Attempting to fallback or failing fast for email ${email.id}.`,
      );
      // Attempt to use the next provider if circuit is open.
      const nextProviderIndex = (providerIndex + 1) % this.providers.length;
      if (
        // Ensure next provider isn't the same as current provider.
        nextProviderIndex !== providerIndex &&
        // Circuit shouldn't be open for even the next provider.
        !this._isCircuitOpen(this.providers[nextProviderIndex].name)
      ) {
        this.logger.info(
          `Switching to provider ${this.providers[nextProviderIndex].name} due to open circuit on ${provider.name} for email ${email.id}.`,
        );
        // Update current provider index globally.
        this.currentProviderIndex = nextProviderIndex;
        // Recursively retry without incrementing attempt (as it is a new provider).
        return this._attemptSendWithRetries(email, attempt, nextProviderIndex);
      } else {
        // If no provider is available; abort and return status.
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
      // Update email status before attempting to send.
      this.updateEmailStatus(
        email.id,
        attempt > 0 ? EmailStatus.RETRYING : EmailStatus.SENDING,
        {
          attempt: attempt + 1,
          provider: provider.name,
        },
      );

      // Actual send with provider.
      const result = await provider.send(email);
      // Log success message if not error.
      this.logger.info(
        `Email ${email.id} sent successfully via ${provider.name}: ${result.messageId}`,
      );
      // Add to `sentEmailIds` set.
      this.sentEmailIds.add(email.id);
      // Success means the circuit can be closed if open.
      this._resetCircuit(provider.name);
      // Update email status with success message.
      this.updateEmailStatus(email.id, EmailStatus.SENT, {
        message: `Sent successfully via ${provider.name}`,
        messageId: result.messageId,
        provider: provider.name,
      });
      // Return status.
      return this.getEmailStatus(email.id);
    } catch (error) {
      // This means the attempt of sending email did not went well in the try block.
      this.logger.error(
        `Attempt ${attempt + 1} for email ${email.id} via ${provider.name} failed: ${error.error || "Unknown error"}`,
      );

      // Handle the failure by incrementing failures for the current provider and logging timestamp.
      // Open circuit if `this.circuitBreaker.failureThreshold` is reached.
      this._handleProviderFailure(provider.name);

      // Attempt sending with the next provider.
      const nextProviderIndex = (providerIndex + 1) % this.providers.length;

      if (
        nextProviderIndex !== providerIndex &&
        attempt < this.maxRetries - 1
      ) {
        // Check if circuit is OPEN for the next provider.
        if (!this._isCircuitOpen(this.providers[nextProviderIndex].name)) {
          this.logger.info(
            `Switching from ${provider.name} to ${this.providers[nextProviderIndex].name} for email ${email.id} after failure.`,
          );
          // Update current provider index globally.
          this.currentProviderIndex = nextProviderIndex;
          // Retry and increment the attempt with the new provider.
          return this._attemptSendWithRetries(
            email,
            attempt + 1,
            nextProviderIndex,
          );
        } else {
          // No fallback provider available; log and retry later after backoff time.
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

      // Retry sending after delay.
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
    // Gets the circuit breaker nested provider object, keyed with `providerName`.
    const cb = this.circuitBreaker[providerName];

    // If a circuit breaker object keyed with the particular provider does not exists, return.
    if (!cb) return;

    // Update the fields of the circuit breaker.
    cb.failure++;
    cb.lastFailureTime = Date.now();

    this.logger.warn(
      `Failure recorded for ${providerName}. Current failures: ${cb.failures}`,
    );

    // Determines no. Of failures have crossed the threshold, if yes OPEN the circuit.
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
    // Gets the circuit breaker nested provider object, keyed with `providerName`.
    const cb = this.circuitBreaker[providerName];

    // If it doesn't exists or circuit is not OPEN, return `false`.
    if (!cb || !cb.isOpen) {
      return false;
    }

    // Determines if time has passed greater than the `resetTimeoutMs`, if yes reset the circuit to CLOSE.
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
    // Gets the circuit breaker nested provider object, keyed with `providerName`.
    const cb = this.circuitBreaker[providerName];

    // If circuit breaker is OPEN, now it can be closed.
    if (cb.isOpen) {
      this.logger.info(`Circuit for ${providerName} is now CLOSED.`);
    }

    // Resetting fields.
    cb.failures = 0;
    cb.lastFailureTime = null;
    cb.isOpen = false;
  }

  /**
   * Records the timestamp of a particular request.
   */
  recordRequestTimestamp() {
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Enqueues an email and optionally enables queue processing.
   */
  enqueueEmail(email) {
    this.logger.info(`Email ${email.id} added to the queue`);
    // Enqueueing
    this.emailQueue.push(email);
    this.updateEmailStatus(email.id, EmailStatus.QUEUED);
    this.processQueue(); // Process queued emails
  }

  /**
   * Async method to enable email queue processing externally (as needed).
   */
  async processQueue() {
    // If queue is already being processed or queue is empty, return.
    if (this.isProcessingQueue || this.emailQueue.length === 0) {
      return;
    }

    // Set global boolean to `true`.
    this.isProcessingQueue = true;
    this.logger.info(`Starting queue processing...`);

    // Iteratively dequeue and send email again.
    while (this.emailQueue.length > 0) {
      // Engage rate limiter.
      if (!this.isAllowedByRateLimiter()) {
        this.logger.warn(
          "Rate limit reached during queue processing. Pausing for a bit.",
        );
        await delay(this.rateLimitWindowMs / 2);
        continue;
      }

      // Dequeue.
      const email = this.emailQueue.shift();
      this.logger.info(`Processing email ${email.id} from queue.`);
      // Record timestamp.
      this.recordRequestTimestamp();
      // Retry send.
      await this.sendEmail(email);
    }

    // Set global boolean to `false`.
    this.isProcessingQueue = false;
    this.logger.info("Queue processing finished.");
  }

  /**
   * Checks if rate limit is not exhausted.
   */
  isAllowedByRateLimiter() {
    const now = Date.now();

    // Filter timestamps which are within `rateLimitWindowMs`.
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < this.rateLimitWindowMs,
    );

    // Compare with threshold, if less return `true` else `false`.
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
    // Fetches email status for the given `emailId`, default to a simple object.
    const existingStatus = this.emailStatuses.get(emailId) || {
      id: emailId,
      history: [],
    };

    // Spread `details`, and update `status` and `timestamp`.
    const newEntry = {
      status: status,
      timestamp: new Date().toISOString(),
      ...details,
    };

    // Spread `existingStatus`
    const updatedStatus = {
      ...existingStatus,
      // Overwrite `currentStatus` and `lastUpdatedAt`.
      currentStatus: status,
      lastUpdatedAt: new Date().toISOString(),
      // Spread details.
      ...details,
      // Overwrite history by spreading `existingStatus.history` to a new array.
      history: [...existingStatus.history, newEntry],
    };

    // Update status of given `emailId` to `updatedStatus`.
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
      // Fetch email status of the given `emailId`.
      this.emailStatuses.get(emailId) || {
        id: emailId,
        status: EmailStatus.PENDING,
        message: "Not yet precessed.",
      }
    );
  }

  /**
   * Get email statuses of all emails.
   */
  getAllEmailStatuses() {
    return Array.from(this.emailStatuses.values());
  }
}

export default EmailService;
