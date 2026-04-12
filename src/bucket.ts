import { redisClientOrPool } from "./client.js";
import { libVersion, libFunctionName } from "./lib.js";

export type Bucket = {
  safeConsume: (amount?: number) => Promise<SafeConsumeOutput>;
  consume: (amount?: number) => Promise<{ tokenAmount: number }>;
  getId: () => string;
  getCapacity: () => number;
  getRefillRate: () => number;
  getTokenAmount: () => Promise<number>;
};

export type CreateBucketInput = {
  id: string;
  capacity: number;
  refillRateInTokensPerMinute: number;
};

export const createBucket = ({
  id,
  capacity,
  refillRateInTokensPerMinute,
}: CreateBucketInput): Bucket => {
  if (!redisClientOrPool) {
    throw new Error(
      "Cannot call `createBucket` without having initialized the library first!",
    );
  }

  const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

  const safeConsume = async (amount = 1): Promise<SafeConsumeOutput> => {
    const result = (await redisClientOrPool.fCall(libFunctionName, {
      keys: [key],
      arguments: [
        capacity.toString(),
        amount.toString(),
        refillRateInTokensPerMinute.toString(),
      ],
    })) as RedisFunctionResult;

    const [outcome, tokens] = result;

    const tokenAmount = parseFloat(tokens);

    if (outcome === "FAIL") {
      const message = [
        `Not enough tokens!`,
        `Tried to consume ${amount} from bucket with id ${id}, but there are only ${tokens} tokens!`,
      ].join("\n");

      const error = new TokenBucketError({
        bucket,
        message,
        reason: "NOT_ENOUGH_TOKENS",
        tokenAmount,
      });

      return {
        success: false,
        error,
        tokenAmount,
      };
    }

    return {
      success: true,
      tokenAmount,
    };
  };

  const consume = async (amount = 1) => {
    const { error, tokenAmount } = await safeConsume(amount);

    if (error) {
      throw error;
    }

    return {
      tokenAmount,
    };
  };

  const getId = () => id;

  const getCapacity = () => capacity;

  const getRefillRate = () => refillRateInTokensPerMinute;

  const getTokenAmount = async () => {
    // When a bucket does not exists in redis
    // it means that either the bucket is being initialized
    // or the key/value expired, which only happens
    // when sufficient time has passed such that
    // the token is full

    const { tokenAmount } = await consume(0);

    return tokenAmount;
  };

  const bucket: Bucket = {
    consume,
    getId,
    getCapacity,
    getRefillRate,
    getTokenAmount,
    safeConsume,
  };

  return bucket;
};

type SafeConsumeOutput =
  | {
      success: true;
      tokenAmount: number;
      error?: never;
    }
  | {
      success: false;
      tokenAmount: number;
      error: TokenBucketError;
    };

type RedisFunctionResult = ["SUCCESS" | "FAIL", tokens: string];

export type TokenBucketErrorReason = "NOT_ENOUGH_TOKENS";

export type TokenBucketErrorConstructorInput = {
  bucket: Bucket;
  message: string;
  reason: TokenBucketErrorReason;
  tokenAmount: number;
};

export class TokenBucketError extends Error {
  constructor({
    message,
    bucket,
    reason,
    tokenAmount,
  }: TokenBucketErrorConstructorInput) {
    super(message);

    this.bucket = bucket;
    this.reason = reason;
    this.tokenAmount = tokenAmount;
  }

  public reason: TokenBucketErrorReason;
  public bucket: Bucket;
  public tokenAmount: number;
}

export const isTokenBucketError = (error: unknown): error is TokenBucketError =>
  error instanceof TokenBucketError;
