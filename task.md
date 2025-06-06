# Task

Implement a resilient email sending service in JavaScript.

## Requirements

1. Create an EmailService class that works with two mock email providers.
2. Implement retry logic with exponential backoff.
3. Add a fallback mechanism to switch providers on failure.
4. Ensure idempotency to prevent duplicate sends.
5. Implement basic rate limiting.
6. Provide status tracking for email sending attempts.

## Key Features

- Retry mechanism
- Fallback between providers
- Idempotency
- Rate limiting
- Status tracking

## Bonus

- Circuit breaker pattern
- Simple logging
- Basic queue system

## Guidelines

- Use JavaScript
- Minimal external libraries
- Include documentation and unit tests
- Focus on clean code and SOLID principles
- Mock providers instead of actual email sending

Time: 2-3 hours

## Deliverables

- Source code
- README with setup instructions and assumptions
- Unit tests

## Evaluation Criteria

- Code quality and organization
- Correct implementation of required features
- Error handling and edge cases
- Testability
- Documentation clarity
