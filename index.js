// index.js
import EmailService from "./src/EmailService.js";
import { v4 as uuidv4 } from "uuid";

console.log("--- Starting Email Service Demo ---");

const emailService = new EmailService({
  maxRetries: 3,
  initialBackoffMs: 200,
});

const email1 = {
  id: uuidv4(),
  to: "user1@example.com",
  subject: "Welcome!",
  body: "...",
};
const email2 = {
  id: uuidv4(),
  to: "user2@example.com",
  subject: "Your Invoice",
  body: "...",
};
const email3 = {
  id: uuidv4(),
  to: "user3@example.com",
  subject: "Password Reset",
  body: "...",
};
const email4 = {
  id: uuidv4(),
  to: "user4@example.com",
  subject: "Special Offer",
  body: "...",
};

async function runDemo() {
  console.log("\nSending emails...");
  emailService.sendEmail(email1);
  emailService.sendEmail(email2);
  emailService.sendEmail(email3);
  emailService.sendEmail(email4);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("\n--- Attempting to send a duplicate email ---");
  emailService.sendEmail(email1);

  setTimeout(() => {
    console.log("\n--- Final Email Statuses ---");
    const allStatuses = emailService.getAllEmailStatuses();
    console.log(JSON.stringify(allStatuses, null, 2));
  }, 10000);
}

runDemo();
