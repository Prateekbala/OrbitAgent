interface SmtpMessage {
  from: { name: string; address: string };
  envelope: { from: string; to: string[] };
  to: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string;
  disableFileAccess: true;
  disableUrlAccess: true;
}
export interface SmtpTransport {
  sendMail(message: SmtpMessage): Promise<{ messageId: string; accepted: string[] }>;
  verify(): Promise<true>;
}
