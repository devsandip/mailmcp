import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Store } from './types.js';

/**
 * Single-table layout: partition key `pk` is the key prefix ("client", "account", ...),
 * sort key `sk` is the rest. That keeps `list(prefix)` a Query, not a Scan.
 * `ttl` is epoch seconds; DynamoDB TTL deletes lazily, so reads also check it.
 */
export class DynamoStore implements Store {
  private doc: DynamoDBDocumentClient;

  constructor(
    private table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private split(key: string): { pk: string; sk: string } {
    const i = key.indexOf('#');
    if (i <= 0) throw new Error(`Store key must look like prefix#rest: ${key}`);
    return { pk: key.slice(0, i), sk: key.slice(i + 1) };
  }

  private expired(item: Record<string, unknown> | undefined): boolean {
    const ttl = item?.ttl;
    return typeof ttl === 'number' && ttl <= Math.floor(Date.now() / 1000);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: this.split(key) }),
    );
    if (!res.Item || this.expired(res.Item)) return undefined;
    return res.Item.value as T;
  }

  async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds === undefined ? undefined : Math.floor(Date.now() / 1000) + ttlSeconds;
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { ...this.split(key), value, ttl } }),
    );
  }

  async take<T>(key: string): Promise<T | undefined> {
    const res = await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: this.split(key), ReturnValues: 'ALL_OLD' }),
    );
    if (!res.Attributes || this.expired(res.Attributes)) return undefined;
    return res.Attributes.value as T;
  }

  async delete(key: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: this.split(key) }));
  }

  async list<T>(prefix: string): Promise<T[]> {
    const pk = prefix.replace(/#$/, '');
    const out: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ExclusiveStartKey,
        }),
      );
      for (const item of res.Items ?? []) if (!this.expired(item)) out.push(item.value as T);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
}
