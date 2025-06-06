class MockProviderB {
  constructor(name = "MockProviderB") {
    this.name = name;
  }

  /**
   * Mocks sending an email.
   * @param {object} email - The email to be sent (contains e.g. {to, subject, body}).
   * @returns {Promise<object>} A promise that resolves to success with a message or failure with an error.
   */
  async send(email) {
    console.log(
      `[${this.name}] Attempting to send email to ${email.to} with subject "${email.subject}"`,
    );

    // Simulating network delay
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * 1000 + 500),
    );

    // Simulating occasional failures
    if (Math.random() < 0.5) {
      console.error(`[${this.name}] Failed to send email to ${email.to}`);
      return Promise.reject({
        success: false,
        provider: this.name,
        error: "Simulated provider error",
      });
    }

    // Simulating success
    console.log(`[${this.name}] Successfully sent email to ${email.to}`);
    return Promise.resolve({
      success: true,
      provider: this.name,
      messageId: `mockB-${Date.now()}`,
    });
  }
}

export default MockProviderB;
