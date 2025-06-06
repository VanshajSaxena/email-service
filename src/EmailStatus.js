// makes the object immutable
const EmailStatus = Object.freeze({
  PENDING: "PENDING",
  SENDING: "SENDING",
  SENT: "SENT",
  FAILED: "FAILED",
  RETRYING: "RETRYING",
  QUEUED: "QUEUED",
});

export default EmailStatus;
