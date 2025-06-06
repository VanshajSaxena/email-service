class MockProviderA {
  constructor(name = "MockProviderA") {
    this.name = name;
  }

  async send(email) {
    console.log(
      `[${this.name}] Attempting to send email to ${email.to} with subject "${email.subject}"`,
    );

    // Simulating network delay
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * 1000 + 500),
    );

    // Simulating occasional failures
    if (Math.random() < 0.3) {
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
      messageId: `mockA-${Date.now()}`,
    });
  }
}

export default MockProviderA;
