import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface MailMcpStackProps extends StackProps {
  ownerEmails: string;
  ssmPrefix: string;
  publicBaseUrl?: string;
}

export class MailMcpStack extends Stack {
  constructor(scope: Construct, id: string, props: MailMcpStackProps) {
    super(scope, id, props);

    // Holds OAuth state and linked accounts. Retained on stack deletion so tokens
    // are never lost by accident; delete it by hand if you tear everything down.
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const key = new kms.Key(this, 'TokenKey', {
      alias: 'alias/mailmcp-tokens',
      description: 'Encrypts Google refresh tokens for mailmcp',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const fn = new nodejs.NodejsFunction(this, 'Server', {
      entry: fileURLToPath(new URL('../src/lambda.ts', import.meta.url)),
      handler: 'main',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE_NAME: table.tableName,
        KMS_KEY_ID: key.keyArn,
        OWNER_EMAILS: props.ownerEmails,
        SSM_PREFIX: props.ssmPrefix,
        ...(props.publicBaseUrl ? { PUBLIC_BASE_URL: props.publicBaseUrl } : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: nodejs.OutputFormat.CJS,
        target: 'node24',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    table.grantReadWriteData(fn);
    key.grantEncryptDecrypt(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters'],
        resources: [
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
        ],
      }),
    );

    // Public URL; the app enforces its own OAuth on /mcp.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // Function URLs rename WWW-Authenticate to x-amzn-Remapped-WWW-Authenticate, and Claude
    // needs that header on 401s to discover the OAuth server. CloudFront sits in front and a
    // Lambda@Edge origin-response function restores it. (CloudFront Functions can't do this:
    // they never run on responses with status 400 or higher.)
    const restoreAuthHeader = new cloudfront.experimental.EdgeFunction(this, 'RestoreAuthHeader', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      memorySize: 128,
      timeout: Duration.seconds(5),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const response = event.Records[0].cf.response;
  const headers = response.headers;
  const remapped = headers['x-amzn-remapped-www-authenticate'];
  if (remapped && remapped[0]) {
    headers['www-authenticate'] = [{ key: 'WWW-Authenticate', value: remapped[0].value }];
    delete headers['x-amzn-remapped-www-authenticate'];
  }
  return response;
};`),
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'mailmcp',
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(url, { readTimeout: Duration.seconds(60) }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        edgeLambdas: [
          {
            functionVersion: restoreAuthHeader.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
          },
        ],
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // The Lambda sees the Function URL host, so it needs the public URL passed in. On the first
    // deploy it is unknown; deploy again with -c publicBaseUrl=<CdnUrl output>.
    const publicUrl = `https://${distribution.distributionDomainName}`;
    new CfnOutput(this, 'CdnUrl', { value: publicUrl });
    new CfnOutput(this, 'McpEndpoint', { value: `${publicUrl}/mcp` });
    new CfnOutput(this, 'GoogleRedirectUri', { value: `${publicUrl}/oauth/google/callback` });
    new CfnOutput(this, 'FunctionUrl', { value: url.url });
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
