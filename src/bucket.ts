import { redisClientOrPool } from "./client.js";
import { libVersion, libFunctionName } from "./lib.js";

export type RefillPolicy = {
  tokens: number;
  intervalInMilliseconds: number;
};

export type Bucket = {
  safeConsume: (amount?: number) => Promise<SafeConsumeOutput>;
  consume: (amount?: number) => Promise<{ availableTokens: number }>;
  getId: () => string;
  getCapacity: () => number;
  getRefillPolicy: () => RefillPolicy;
  getAvailableTokens: () => Promise<number>;
  getTimeUntilFullInMilliseconds: () => Promise<number>;
  getTimeUntilAvailableInMilliseconds: (tokens?: number) => Promise<number>;
};

export type CreateBucketInput = {
  id: string;
  capacity: number;
  refillPolicy: RefillPolicy;
};

export const createBucket = ({
  id,
  capacity,
  refillPolicy,
}: CreateBucketInput): Bucket => {
  if (!redisClientOrPool) {
    throw new Error(
      "Cannot call `createBucket` without having initialized the library first!",
    );
  }

  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(
      `\`capacity\` must be a positive number, but received ${capacity}!`,
    );
  }

  if (!Number.isFinite(refillPolicy.tokens) || refillPolicy.tokens <= 0) {
    throw new Error(
      `\`refillPolicy.tokens\` must be a positive number, but received ${refillPolicy.tokens}!`,
    );
  }

  if (
    !Number.isFinite(refillPolicy.intervalInMilliseconds) ||
    refillPolicy.intervalInMilliseconds <= 0
  ) {
    throw new Error(
      `\`refillPolicy.intervalInMilliseconds\` must be a positive number, but received ${refillPolicy.intervalInMilliseconds}!`,
    );
  }

  const refillTokens = refillPolicy.tokens;
  const refillIntervalInMilliseconds = refillPolicy.intervalInMilliseconds;

  const refillRateInTokensPerMillisecond =
    refillTokens / refillIntervalInMilliseconds;

  const key = `TOKEN_BUCKET_REDIS_${libVersion}_${id}`;

  // Refilling is continuous and thus deterministic,
  // so given the current amount of tokens we're able
  // to compute how long it takes to reach any
  // given target amount without further roundtrips to Redis
  const computeTimeUntilAvailableInMilliseconds = (
    availableTokens: number,
    targetTokens: number,
  ) => {
    if (targetTokens > capacity) {
      return Infinity;
    }

    const missingTokens = Math.max(0, targetTokens - availableTokens);

    return missingTokens / refillRateInTokensPerMillisecond;
  };

  const safeConsume = async (amount = 1): Promise<SafeConsumeOutput> => {
    const result = (await redisClientOrPool.fCall(libFunctionName, {
      keys: [key],
      arguments: [
        capacity.toString(),
        amount.toString(),
        refillRateInTokensPerMillisecond.toString(),
      ],
    })) as RedisFunctionResult;

    const [outcome, tokens] = result;

    const availableTokens = parseFloat(tokens);

    if (outcome === "FAIL") {
      const timeUntilAvailableInMilliseconds =
        computeTimeUntilAvailableInMilliseconds(availableTokens, amount);

      const message = [
        `Not enough tokens!`,
        `Tried to consume ${amount} from bucket with id ${id}, but there are only ${tokens} tokens!`,
      ].join("\n");

      const error = new TokenBucketError({
        bucket,
        message,
        reason: "NOT_ENOUGH_TOKENS",
        availableTokens,
        timeUntilAvailableInMilliseconds,
      });

      return {
        success: false,
        error,
        availableTokens,
        timeUntilAvailableInMilliseconds,
      };
    }

    return {
      success: true,
      availableTokens,
    };
  };

  const consume = async (amount = 1) => {
    const { error, availableTokens } = await safeConsume(amount);

    if (error) {
      throw error;
    }

    return {
      availableTokens,
    };
  };

  const getId = () => id;

  const getCapacity = () => capacity;

  const getRefillPolicy = (): RefillPolicy => ({
    tokens: refillTokens,
    intervalInMilliseconds: refillIntervalInMilliseconds,
  });

  const getAvailableTokens = async () => {
    // When a bucket does not exists in redis
    // it means that either the bucket is being initialized
    // or the key/value expired, which only happens
    // when sufficient time has passed such that
    // the token is full

    const { availableTokens } = await consume(0);

    return availableTokens;
  };

  const getTimeUntilAvailableInMilliseconds = async (tokens = 1) => {
    if (tokens > capacity) {
      throw new Error(
        `Cannot compute the time until ${tokens} tokens are available, because it exceeds the bucket capacity (${capacity}), so it'd never be reached!`,
      );
    }

    const availableTokens = await getAvailableTokens();

    return computeTimeUntilAvailableInMilliseconds(availableTokens, tokens);
  };

  const getTimeUntilFullInMilliseconds = () =>
    getTimeUntilAvailableInMilliseconds(capacity);

  const bucket: Bucket = {
    consume,
    getId,
    getCapacity,
    getRefillPolicy,
    getAvailableTokens,
    getTimeUntilFullInMilliseconds,
    getTimeUntilAvailableInMilliseconds,
    safeConsume,
  };

  return bucket;
};

export type SafeConsumeOutput =
  | {
      success: true;
      availableTokens: number;
      error?: never;
      timeUntilAvailableInMilliseconds?: never;
    }
  | {
      success: false;
      availableTokens: number;
      error: TokenBucketError;
      timeUntilAvailableInMilliseconds: number;
    };

type RedisFunctionResult = ["SUCCESS" | "FAIL", tokens: string];

export type TokenBucketErrorReason = "NOT_ENOUGH_TOKENS";

export type TokenBucketErrorConstructorInput = {
  bucket: Bucket;
  message: string;
  reason: TokenBucketErrorReason;
  availableTokens: number;
  timeUntilAvailableInMilliseconds: number;
};

export class TokenBucketError extends Error {
  constructor({
    message,
    bucket,
    reason,
    availableTokens,
    timeUntilAvailableInMilliseconds,
  }: TokenBucketErrorConstructorInput) {
    super(message);

    this.bucket = bucket;
    this.reason = reason;
    this.availableTokens = availableTokens;
    this.timeUntilAvailableInMilliseconds = timeUntilAvailableInMilliseconds;
  }

  public reason: TokenBucketErrorReason;
  public bucket: Bucket;
  public availableTokens: number;
  public timeUntilAvailableInMilliseconds: number;
}

export const isTokenBucketError = (error: unknown): error is TokenBucketError =>
  error instanceof TokenBucketError;
