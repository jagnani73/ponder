import {
  type BlockFilter,
  type LogFactory,
  type LogFilter,
  type TraceFilter,
  type TransactionFilter,
  type TransferFilter,
  isAddressFactory,
} from "@/sync/source.js";
import type {
  SyncBlock,
  SyncLog,
  SyncTrace,
  SyncTransaction,
} from "@/types/sync.js";
import { toLowerCase } from "@/utils/lowercase.js";
import { type Address, hexToBigInt, hexToNumber } from "viem";

const isValueMatched = <T extends string>(
  filterValue: T | T[] | null | undefined,
  eventValue: T | undefined,
): boolean => {
  // match all
  if (filterValue === null || filterValue === undefined) return true;

  // missing value
  if (eventValue === undefined) return false;

  // array
  if (
    Array.isArray(filterValue) &&
    filterValue.some((v) => v === toLowerCase(eventValue))
  ) {
    return true;
  }

  // single
  if (filterValue === toLowerCase(eventValue)) return true;

  return false;
};

/**
 * Returns `true` if `log` matches `filter`
 */
export const isLogFactoryMatched = ({
  filter,
  log,
}: { filter: LogFactory; log: SyncLog }): boolean => {
  const addresses = Array.isArray(filter.address)
    ? filter.address
    : [filter.address];

  if (addresses.every((address) => address !== toLowerCase(log.address))) {
    return false;
  }
  if (log.topics.length === 0) return false;
  if (filter.eventSelector !== toLowerCase(log.topics[0]!)) return false;

  return true;
};

/**
 * Returns `true` if `log` matches `filter`
 */
export const isLogFilterMatched = ({
  filter,
  block,
  log,
}: {
  filter: LogFilter;
  block: SyncBlock;
  log: SyncLog;
}): boolean => {
  // Return `false` for out of range blocks
  if (
    hexToNumber(block.number) < (filter.fromBlock ?? 0) ||
    hexToNumber(block.number) > (filter.toBlock ?? Number.POSITIVE_INFINITY)
  ) {
    return false;
  }

  if (isValueMatched(filter.topic0, log.topics[0]) === false) return false;
  if (isValueMatched(filter.topic1, log.topics[1]) === false) return false;
  if (isValueMatched(filter.topic2, log.topics[2]) === false) return false;
  if (isValueMatched(filter.topic3, log.topics[3]) === false) return false;
  if (
    isAddressFactory(filter.address) === false &&
    isValueMatched(
      filter.address as Address | Address[] | undefined,
      log.address,
    ) === false
  ) {
    return false;
  }

  return true;
};

/**
 * Returns `true` if `transaction` matches `filter`
 */
export const isTransactionFilterMatched = ({
  filter,
  block,
  transaction,
}: {
  filter: TransactionFilter;
  block: Pick<SyncBlock, "number">;
  transaction: SyncTransaction;
}): boolean => {
  // Return `false` for out of range blocks
  if (
    hexToNumber(block.number) < (filter.fromBlock ?? 0) ||
    hexToNumber(block.number) > (filter.toBlock ?? Number.POSITIVE_INFINITY)
  ) {
    return false;
  }

  if (
    isAddressFactory(filter.fromAddress) === false &&
    isValueMatched(
      filter.fromAddress as Address | Address[] | undefined,
      transaction.from,
    ) === false
  ) {
    return false;
  }
  if (
    isAddressFactory(filter.toAddress) === false &&
    transaction.to &&
    isValueMatched(
      filter.toAddress as Address | Address[] | undefined,
      transaction.to,
    ) === false
  ) {
    return false;
  }

  // NOTE: `filter.includeReverted` is intentionally ignored

  return true;
};

/**
 * Returns `true` if `trace` matches `filter`
 */
export const isTraceFilterMatched = ({
  filter,
  block,
  trace,
}: {
  filter: TraceFilter;
  block: Pick<SyncBlock, "number">;
  trace: Omit<SyncTrace["trace"], "calls" | "logs">;
}): boolean => {
  // Return `false` for out of range blocks
  if (
    hexToNumber(block.number) < (filter.fromBlock ?? 0) ||
    hexToNumber(block.number) > (filter.toBlock ?? Number.POSITIVE_INFINITY)
  ) {
    return false;
  }

  if (
    isAddressFactory(filter.fromAddress) === false &&
    isValueMatched(
      filter.fromAddress as Address | Address[] | undefined,
      trace.from,
    ) === false
  ) {
    return false;
  }
  if (
    isAddressFactory(filter.toAddress) === false &&
    isValueMatched(
      filter.toAddress as Address | Address[] | undefined,
      trace.to,
    ) === false
  ) {
    return false;
  }

  if (filter.callType !== trace.type) {
    return false;
  }

  if (
    isValueMatched(filter.functionSelector, trace.input.slice(0, 10)) === false
  ) {
    return false;
  }

  // NOTE: `filter.includeReverted` is intentionally ignored

  return true;
};

/**
 * Returns `true` if `trace` matches `filter`
 */
export const isTransferFilterMatched = ({
  filter,
  block,
  trace,
}: {
  filter: TransferFilter;
  block: Pick<SyncBlock, "number">;
  trace: Omit<SyncTrace["trace"], "calls" | "logs">;
}): boolean => {
  // Return `false` for out of range blocks
  if (
    hexToNumber(block.number) < (filter.fromBlock ?? 0) ||
    hexToNumber(block.number) > (filter.toBlock ?? Number.POSITIVE_INFINITY)
  ) {
    return false;
  }

  if (trace.value === undefined || hexToBigInt(trace.value) === 0n) {
    return false;
  }
  if (
    isAddressFactory(filter.fromAddress) === false &&
    isValueMatched(
      filter.fromAddress as Address | Address[] | undefined,
      trace.from,
    ) === false
  ) {
    return false;
  }
  if (
    isAddressFactory(filter.toAddress) === false &&
    isValueMatched(
      filter.toAddress as Address | Address[] | undefined,
      trace.to,
    ) === false
  ) {
    return false;
  }

  // NOTE: `filter.includeReverted` is intentionally ignored

  return true;
};

/**
 * Returns `true` if `block` matches `filter`
 */
export const isBlockFilterMatched = ({
  filter,
  block,
}: {
  filter: BlockFilter;
  block: SyncBlock;
}): boolean => {
  // Return `false` for out of range blocks
  if (
    hexToNumber(block.number) < (filter.fromBlock ?? 0) ||
    hexToNumber(block.number) > (filter.toBlock ?? Number.POSITIVE_INFINITY)
  ) {
    return false;
  }

  return (hexToNumber(block.number) - filter.offset) % filter.interval === 0;
};
