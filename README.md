# A JavaScript Email Service

This project is a JavaScript implementation of a resilient email sending
service designed to handle provider failures gracefully. It's built with modern
JavaScript (ES Modules) and focuses on clean code and robust error-handling
patterns. The service works with mock email providers, allowing for safe
testing and demonstration of its core features without sending actual emails.

This project uses **Babel** to transpile modern JavaScript for compatibility
with the Jest testing framework.

## Key Features

- **Retry Mechanism:** Automatically retries sending an email with exponential
  backoff upon failure.
- **Provider Fallback:** Switches to a secondary provider if the primary one
  fails.
- **Idempotency:** Prevents sending the same email multiple times using a
  unique request ID.
- **Rate Limiting:** Basic sliding-window rate limiting to avoid overwhelming
  providers.
- **Status Tracking:** Monitors and records the status of each email sending
  attempt (e.g., `PENDING`, `SENT`, `FAILED`).
- **Circuit Breaker:** (Bonus) A pattern to prevent making requests to a
  provider that is known to be failing.
- **Queue System:** (Bonus) A simple in-memory queue to hold requests that
  exceed the rate limit.
- **Logging:** (Bonus) Simple console logging for visibility into the service's
  operations.

## Getting Started

Follow these instructions to get a copy of the project up and running on your
local machine for development and testing purposes.

### Prerequisites

You need to have [Node.js](https://nodejs.org/) (which includes npm) installed
on your system. Version 18.x or higher is recommended.

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://your-repository-url.com/email-service.git
   cd email-service
   ```

2. **Install dependencies:**
   This will install all necessary packages, including `jest` and the required
   `babel` packages for testing.

   ```bash
   npm install
   ```

## Running the Service (Demo)

To see the service in action, you can run the example entry point script. This
script will instantiate the `EmailService` and attempt to send several emails,
demonstrating features like retries and fallbacks.

```bash
node index.js
```

You will see detailed logs in your console showing the journey of each email.

## Running Tests

This project uses **Jest** for unit testing and **Babel** to transpile ES
Module syntax (`import`/`export`) before the tests are run. The configuration
for this is located in `babel.config.js`.

To run the entire test suite, execute the following command:

```bash
npm test
```

Jest will discover and run all test files located in the `tests/` directory and
provide a summary of the results.

## Project Structure

```sh
email-service/
├── src/                      # Core application source code
│   ├── EmailService.js       # The main service class with all the logic
│   ├── MockProviderA.js      # A mock email provider
│   ├── MockProviderB.js      # A second mock email provider for fallback
│   ├── EmailStatus.js        # Enum-like object for email statuses
│   └── utils/
│       └── delay.js          # Helper for promise-based delays
├── tests/                    # Unit tests
│   └── EmailService.test.js  # Tests for the EmailService
├── .gitignore                # Standard git ignore file
├── babel.config.js           # Babel configuration for Jest
├── index.js                  # Example script to run a demo of the service
├── package-lock.json         # Project lock file
├── package.json              # Project metadata and dependencies
└── README.md                 # This file
```

## Design Choices & Assumptions

- **Providers:** The service is designed to work with any provider class that
  exposes an `async send(email)` method. Providers are mocked to simulate network
  latency and random failures.
- **Idempotency:** The service assumes that the client provides a **unique `id`
  field** in the email object. This `id` is used to prevent duplicate sends.
- **In-Memory State:** All state (email statuses, sent IDs for idempotency,
  rate limit timestamps, and the email queue) is stored **in-memory**. This means
  the state will be lost if the application restarts. For a production system,
  this would be replaced with a persistent store like Redis or a database.
- **Testing with Babel:** The choice was made to use a `babel.config.js` file
  to handle JavaScript transpilation. This allows the use of modern
  `import`/`export` syntax throughout the project, including in test files, while
  maintaining compatibility with Jest.

## API Usage

### `new EmailService(config)`

Creates a new instance of the email service.

- **`config`** (optional `object`):
  - `maxRetries` (default: `3`)
  - `initialBackoffMs` (default: `500`)
  - `rateLimitRequests` (default: `5`)
  - `rateLimitWindowMs` (default: `10000`)
  - `circuitBreakerFailureThreshold` (default: `3`)
  - `circuitBreakerResetTimeoutMs` (default: `30000`)

**Example:**

```javascript
import EmailService from "./src/EmailService.js";

const customConfig = { maxRetries: 5, initialBackoffMs: 300 };
const emailService = new EmailService(customConfig);
```

### `emailService.sendEmail(email)`

The primary method to send an email. It returns a `Promise` that resolves with
the final status object of the email attempt.

- **`email`** (`object`): The email object to be sent.
  - `id` (`string`, **required**): A unique identifier for this email request.
  - `to` (`string`, **required**): The recipient's email address.
  - `subject` (`string`, **required**): The email subject.
  - `body` (`string`): The email body.

**Example:**

```javascript
import { v4 as uuidv4 } from "uuid"; // A good way to generate unique IDs

async function sendMyEmail() {
  const myEmail = {
    id: uuidv4(),
    to: "recipient@example.com",
    subject: "Hello from Resilient Service!",
    body: "This email demonstrates the service.",
  };

  const result = await emailService.sendEmail(myEmail);
  console.log("Final Status:", result);
}
```

### `emailService.getEmailStatus(emailId)`

Returns the latest status object for a given email ID.

## License

This project is licensed under the [MIT License](LICENSE).
