import { App } from 'aws-cdk-lib';
import { MailMcpStack } from './stack.js';

const app = new App();

const ownerEmails = app.node.tryGetContext('ownerEmails') ?? process.env.OWNER_EMAILS;
if (!ownerEmails) {
  throw new Error(
    'Set the Google emails allowed to connect: cdk deploy -c ownerEmails=you@gmail.com,you@yourdomain.com',
  );
}

new MailMcpStack(app, 'MailMcp', {
  ownerEmails,
  ssmPrefix: app.node.tryGetContext('ssmPrefix') ?? '/mailmcp',
  publicBaseUrl: app.node.tryGetContext('publicBaseUrl'),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
