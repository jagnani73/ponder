import type { Common } from "@/common/common.js";
import type { Network } from "@/config/networks.js";
import { type SyncProgress, syncBlockToLightBlock } from "@/sync/index.js";
import {
  type BlockFilter,
  type Factory,
  type Filter,
  type LogFilter,
  type Source,
  type TraceFilter,
  type TransactionFilter,
  type TransferFilter,
  getChildAddress,
  isAddressFactory,
} from "@/sync/source.js";
import type {
  LightBlock,
  SyncBlock,
  SyncLog,
  SyncTrace,
  SyncTransaction,
  SyncTransactionReceipt,
} from "@/types/sync.js";
import { range } from "@/utils/range.js";
import type { RequestQueue } from "@/utils/requestQueue.js";
import {
  _debug_traceBlockByHash,
  _eth_getBlockByHash,
  _eth_getBlockByNumber,
  _eth_getLogs,
  _eth_getTransactionReceipt,
} from "@/utils/rpc.js";
import { wait } from "@/utils/wait.js";
import { type Queue, createQueue } from "@ponder/common";
import { type Address, type Hash, hexToNumber } from "viem";
import { isFilterInBloom, zeroLogsBloom } from "./bloom.js";
import {
  isBlockFilterMatched,
  isLogFactoryMatched,
  isLogFilterMatched,
  isTraceFilterMatched,
  isTransactionFilterMatched,
  isTransferFilterMatched,
} from "./filter.js";

export type RealtimeSync = {
  start(args: {
    syncProgress: Pick<SyncProgress, "finalized">;
    initialChildAddresses: Map<Factory, Set<Address>>;
  }): Promise<
    Queue<void, Omit<BlockWithEventData, "traces"> & { traces: SyncTrace[] }>
  >;
  kill(): Promise<void>;
  unfinalizedBlocks: LightBlock[];
  finalizedChildAddresses: Map<Factory, Set<Address>>;
  unfinalizedChildAddresses: Map<Factory, Set<Address>>;
};

type CreateRealtimeSyncParameters = {
  common: Common;
  network: Network;
  requestQueue: RequestQueue;
  sources: Source[];
  onEvent: (event: RealtimeSyncEvent) => Promise<void>;
  onFatalError: (error: Error) => void;
};

export type BlockWithEventData = {
  block: SyncBlock;
  filters: Set<Filter>;
  logs: SyncLog[];
  factoryLogs: SyncLog[];
  traces: SyncTrace[];
  transactions: SyncTransaction[];
  transactionReceipts: SyncTransactionReceipt[];
};

export type RealtimeSyncEvent =
  | ({
      type: "block";
    } & BlockWithEventData)
  | {
      type: "finalize";
      block: LightBlock;
    }
  | {
      type: "reorg";
      block: LightBlock;
      reorgedBlocks: LightBlock[];
    };

const ERROR_TIMEOUT = [
  1, 2, 5, 10, 30, 60, 60, 60, 60, 60, 60, 60, 60, 60,
] as const;
const MAX_QUEUED_BLOCKS = 25;

export const createRealtimeSync = (
  args: CreateRealtimeSyncParameters,
): RealtimeSync => {
  ////////
  // state
  ////////
  let isKilled = false;
  let finalizedBlock: LightBlock;
  let finalizedChildAddresses: Map<Factory, Set<Address>>;
  const unfinalizedChildAddresses = new Map<Factory, Set<Address>>();
  const factoryLogsPerBlock = new Map<Hash, SyncLog[]>();
  /**
   * Blocks that have been ingested and are
   * waiting to be finalized. It is an invariant that
   * all blocks are linked to each other,
   * `parentHash` => `hash`.
   */
  let unfinalizedBlocks: LightBlock[] = [];
  let queue: Queue<
    void,
    Omit<BlockWithEventData, "filters" | "traces"> & { traces: SyncTrace[] }
  >;
  let consecutiveErrors = 0;
  let interval: NodeJS.Timeout | undefined;

  const factories: Factory[] = [];
  const logFilters: LogFilter[] = [];
  const traceFilters: TraceFilter[] = [];
  const transactionFilters: TransactionFilter[] = [];
  const transferFilters: TransferFilter[] = [];
  const blockFilters: BlockFilter[] = [];

  for (const source of args.sources) {
    // Collect filters from sources
    if (source.type === "contract") {
      if (source.filter.type === "log") {
        logFilters.push(source.filter);
      } else if (source.filter.type === "trace") {
        traceFilters.push(source.filter);
      }
    } else if (source.type === "account") {
      if (source.filter.type === "transaction") {
        transactionFilters.push(source.filter);
      } else if (source.filter.type === "transfer") {
        transferFilters.push(source.filter);
      }
    } else if (source.type === "block") {
      blockFilters.push(source.filter);
    }

    // Collect factories from sources
    switch (source.filter.type) {
      case "trace":
      case "transaction":
      case "transfer": {
        const { fromAddress, toAddress } = source.filter;

        if (isAddressFactory(fromAddress)) {
          factories.push(fromAddress);
        }
        if (isAddressFactory(toAddress)) {
          factories.push(toAddress);
        }
        break;
      }
      case "log": {
        const { address } = source.filter;
        if (isAddressFactory(address)) {
          factories.push(address);
        }
        logFilters.push(source.filter);
        break;
      }
    }
  }

  for (const factory of factories) {
    unfinalizedChildAddresses.set(factory, new Set());
  }

  /**
   * 1) Determine if a reorg occurred.
   * 2) Insert new event data into the store.
   * 3) Determine if a new range of events has become finalized,
   *    if so insert interval to store and remove the finalized data.
   *
   * @param block Block to be injested. Must be exactly
   * 1 block ahead of the local chain.
   * @returns true if a reorg occurred
   */
  const handleBlock = async ({
    block,
    logs,
    factoryLogs,
    traces,
    transactions,
    transactionReceipts,
  }: Omit<BlockWithEventData, "filters">) => {
    args.common.logger.debug({
      service: "realtime",
      msg: `Started syncing '${args.network.name}' block ${hexToNumber(block.number)}`,
    });

    // Update `unfinalizedChildAddresses`
    for (const log of factoryLogs) {
      for (const filter of factories) {
        if (isLogFactoryMatched({ filter, log })) {
          unfinalizedChildAddresses
            .get(filter)!
            .add(getChildAddress({ log, factory: filter }));
        }
      }
    }

    /**
     * `logs` and `callTraces` must be filtered again (already filtered in `extract`)
     *  because `extract` doesn't have factory address information.
     */

    const matchedFilters = new Set<Filter>();

    // Remove logs that don't match a filter, accounting for factory addresses
    logs = logs.filter((log) => {
      let isMatched = false;

      for (const filter of logFilters) {
        if (
          isLogFilterMatched({ filter, block, log }) &&
          (isAddressFactory(filter.address)
            ? finalizedChildAddresses
                .get(filter.address)!
                .has(log.address.toLowerCase() as Address) ||
              unfinalizedChildAddresses
                .get(filter.address)!
                .has(log.address.toLowerCase() as Address)
            : true)
        ) {
          matchedFilters.add(filter);
          isMatched = true;
        }
      }

      return isMatched;
    });

    // TODO: handle factory address
    traces = traces.filter((trace) => {
      let isMatched = false;
      for (const filter of transferFilters) {
        if (
          isTransferFilterMatched({
            filter,
            block: { number: block.number },
            trace: trace.trace,
          })
        ) {
          matchedFilters.add(filter);
          isMatched = true;
        }
      }

      for (const filter of traceFilters) {
        if (
          isTraceFilterMatched({
            filter,
            block: { number: block.number },
            trace: trace.trace,
          })
        ) {
          matchedFilters.add(filter);
          isMatched = true;
        }
      }

      return isMatched;
    });

    // Remove transactions and transaction receipts that may have been filtered out
    const transactionHashes = new Set<Hash>();
    for (const log of logs) {
      transactionHashes.add(log.transactionHash);
    }
    for (const trace of traces) {
      transactionHashes.add(trace.transactionHash);
    }

    // TODO: handle factory address
    transactions = transactions.filter((transaction) => {
      let isMatched = transactionHashes.has(transaction.hash);
      for (const filter of transactionFilters) {
        if (isTransactionFilterMatched({ filter, block, transaction })) {
          matchedFilters.add(filter);
          isMatched = true;
        }
      }
      return isMatched;
    });

    transactions = transactions.filter((t) => transactionHashes.has(t.hash));
    transactionReceipts = transactionReceipts.filter((t) =>
      transactionHashes.has(t.transactionHash),
    );

    // Record matched block filters
    for (const filter of blockFilters) {
      if (isBlockFilterMatched({ filter, block })) {
        matchedFilters.add(filter);
      }
    }

    if (logs.length > 0 || traces.length > 0) {
      const _text: string[] = [];

      if (logs.length === 1) {
        _text.push("1 log");
      } else if (logs.length > 1) {
        _text.push(`${logs.length} logs`);
      }

      if (traces.length === 1) {
        _text.push("1 call trace");
      } else if (traces.length > 1) {
        _text.push(`${traces.length} call traces`);
      }

      const text = _text.filter((t) => t !== undefined).join(" and ");
      args.common.logger.info({
        service: "realtime",
        msg: `Synced ${text} from '${args.network.name}' block ${hexToNumber(block.number)}`,
      });
    } else {
      args.common.logger.info({
        service: "realtime",
        msg: `Synced block ${hexToNumber(block.number)} from '${args.network.name}' `,
      });
    }

    unfinalizedBlocks.push(syncBlockToLightBlock(block));

    // Make sure `transactions` can be garbage collected
    // @ts-ignore
    block.transactions = undefined;

    await args.onEvent({
      type: "block",
      filters: matchedFilters,
      block,
      factoryLogs,
      logs,
      traces,
      transactions,
      transactionReceipts,
    });

    // Determine if a new range has become finalized by evaluating if the
    // latest block number is 2 * finalityBlockCount >= finalized block number.
    // Essentially, there is a range the width of finalityBlockCount that is entirely
    // finalized.
    const blockMovesFinality =
      hexToNumber(block.number) >=
      hexToNumber(finalizedBlock.number) + 2 * args.network.finalityBlockCount;
    if (blockMovesFinality) {
      const pendingFinalizedBlock = unfinalizedBlocks.find(
        (lb) =>
          hexToNumber(lb.number) ===
          hexToNumber(block.number) - args.network.finalityBlockCount,
      )!;

      args.common.logger.debug({
        service: "realtime",
        msg: `Finalized ${hexToNumber(pendingFinalizedBlock.number) - hexToNumber(finalizedBlock.number) + 1} '${
          args.network.name
        }' blocks from ${hexToNumber(finalizedBlock.number) + 1} to ${hexToNumber(pendingFinalizedBlock.number)}`,
      });

      const finalizedBlocks = unfinalizedBlocks.filter(
        (lb) =>
          hexToNumber(lb.number) <= hexToNumber(pendingFinalizedBlock.number),
      );

      unfinalizedBlocks = unfinalizedBlocks.filter(
        (lb) =>
          hexToNumber(lb.number) > hexToNumber(pendingFinalizedBlock.number),
      );

      // add child address from newly finalized blocks to `finalizedChildAddresses`
      for (const filter of factories) {
        for (const { hash } of finalizedBlocks) {
          const factoryLogs = factoryLogsPerBlock.get(hash);
          if (factoryLogs !== undefined) {
            for (const log of factoryLogs) {
              if (isLogFactoryMatched({ filter, log })) {
                finalizedChildAddresses
                  .get(filter)!
                  .add(getChildAddress({ log, factory: filter }));
              }
            }
          }
        }
      }

      // recompute `unfinalizedChildAddresses`
      unfinalizedChildAddresses.clear();

      for (const filter of factories) {
        unfinalizedChildAddresses.set(filter, new Set());
        for (const { hash } of unfinalizedBlocks) {
          const factoryLogs = factoryLogsPerBlock.get(hash);
          if (factoryLogs !== undefined) {
            for (const log of factoryLogs) {
              if (isLogFactoryMatched({ filter, log })) {
                unfinalizedChildAddresses
                  .get(filter)!
                  .add(getChildAddress({ log, factory: filter }));
              }
            }
          }
        }
      }

      // delete finalized blocks from `factoryLogsPerBlock`
      for (const { hash } of finalizedBlocks) {
        factoryLogsPerBlock.delete(hash);
      }

      finalizedBlock = pendingFinalizedBlock;

      await args.onEvent({ type: "finalize", block: pendingFinalizedBlock });
    }

    args.common.logger.debug({
      service: "realtime",
      msg: `Finished syncing '${args.network.name}' block ${hexToNumber(block.number)}`,
    });
  };

  /**
   * Traverse the remote chain until we find a block that is
   * compatible with out local chain.
   *
   * @param block Block that caused reorg to be detected.
   * Must be at most 1 block ahead of the local chain.
   */
  const handleReorg = async (block: SyncBlock) => {
    args.common.logger.warn({
      service: "realtime",
      msg: `Detected forked '${args.network.name}' block at height ${hexToNumber(block.number)}`,
    });

    // Record blocks that have been removed from the local chain.
    const reorgedBlocks = unfinalizedBlocks.filter(
      (lb) => hexToNumber(lb.number) >= hexToNumber(block.number),
    );

    // Prune the local chain of blocks that have been reorged out
    unfinalizedBlocks = unfinalizedBlocks.filter(
      (lb) => hexToNumber(lb.number) < hexToNumber(block.number),
    );

    // Block we are attempting to fit into the local chain.
    let remoteBlock = block;

    while (true) {
      const parentBlock = getLatestUnfinalizedBlock();

      if (parentBlock.hash === remoteBlock.parentHash) break;

      if (unfinalizedBlocks.length === 0) {
        // No compatible block was found in the local chain, must be a deep reorg.

        const msg = `Encountered unrecoverable '${args.network.name}' reorg beyond finalized block ${hexToNumber(finalizedBlock.number)}`;

        args.common.logger.warn({ service: "realtime", msg });

        throw new Error(msg);
      } else {
        remoteBlock = await _eth_getBlockByHash(args.requestQueue, {
          hash: remoteBlock.parentHash,
        });
        // Add tip to `reorgedBlocks`
        reorgedBlocks.push(unfinalizedBlocks.pop()!);
      }
    }

    const commonAncestor = getLatestUnfinalizedBlock();

    await args.onEvent({ type: "reorg", block: commonAncestor, reorgedBlocks });

    args.common.logger.warn({
      service: "realtime",
      msg: `Reconciled ${reorgedBlocks.length}-block reorg on '${
        args.network.name
      }' with common ancestor block ${hexToNumber(commonAncestor.number)}`,
    });

    // recompute `unfinalizedChildAddresses`
    unfinalizedChildAddresses.clear();

    for (const filter of factories) {
      unfinalizedChildAddresses.set(filter, new Set());
      for (const { hash } of unfinalizedBlocks) {
        const factoryLogs = factoryLogsPerBlock.get(hash);
        if (factoryLogs !== undefined) {
          for (const log of factoryLogs) {
            if (isLogFactoryMatched({ filter, log })) {
              unfinalizedChildAddresses
                .get(filter)!
                .add(getChildAddress({ log, factory: filter }));
            }
          }
        }
      }
    }

    // delete reorged blocks from `factoryLogsPerBlock`
    for (const { hash } of reorgedBlocks) {
      factoryLogsPerBlock.delete(hash);
    }
  };

  /**
   * Fetch all data (logs, traces, receipts) for the specified block required by `args.sources`
   *
   * Note: The data returned by this function may include false positives. This
   * is due to the fact that factory addresses are unknown and are always
   * treated as "matched".
   */
  const fetchBlockEventData = async (
    block: SyncBlock,
  ): Promise<
    Omit<BlockWithEventData, "filters" | "traces"> & { traces: SyncTrace[] }
  > => {
    ////////
    // Logs
    ////////

    // "eth_getLogs" calls can be skipped if no filters match `newHeadBlock.logsBloom`.
    const shouldRequestLogs =
      block.logsBloom === zeroLogsBloom ||
      logFilters.some((filter) => isFilterInBloom({ block, filter }));

    let logs: SyncLog[] = [];
    if (shouldRequestLogs) {
      logs = await _eth_getLogs(args.requestQueue, { blockHash: block.hash });

      // Protect against RPCs returning empty logs. Known to happen near chain tip.
      if (block.logsBloom !== zeroLogsBloom && logs.length === 0) {
        throw new Error(
          "Detected invalid eth_getLogs response. `block.logsBloom` is not empty but zero logs were returned.",
        );
      }

      // Check that logs refer to the correct block
      for (const log of logs) {
        if (log.blockHash !== block.hash) {
          throw new Error(
            `Detected invalid eth_getLogs response. 'log.blockHash' ${log.blockHash} does not match requested block hash ${block.hash}`,
          );
        }
      }
    }

    if (
      shouldRequestLogs === false &&
      args.sources.some((s) => s.filter.type === "log")
    ) {
      args.common.logger.debug({
        service: "realtime",
        msg: `Skipped fetching logs for '${args.network.name}' block ${hexToNumber(block.number)} due to bloom filter result`,
      });
    }

    ////////
    // Traces
    ////////

    const shouldRequestTraces =
      traceFilters.length > 0 || transferFilters.length > 0;

    let traces: SyncTrace[] = [];
    if (shouldRequestTraces) {
      traces = await _debug_traceBlockByHash(args.requestQueue, {
        hash: block.hash,
      });

      // Protect against RPCs returning empty traces. Known to happen near chain tip.
      // Use the fact that any transaction produces a trace.
      if (block.transactions.length !== 0 && traces.length === 0) {
        throw new Error(
          "Detected invalid debug_traceBlock response. `block.transactions` is not empty but zero traces were returned.",
        );
      }
    }

    // Validate that each trace point to valid transaction in the block
    for (const trace of traces) {
      if (
        block.transactions.find((t) => t.hash === trace.transactionHash) ===
        undefined
      ) {
        throw new Error(
          `Detected inconsistent RPC responses. 'trace.txHash' ${trace.transactionHash} not found in 'block' ${block.hash}`,
        );
      }
    }

    ////////
    // Get Matched
    ////////

    // Record `logs` that contain factory child addresses
    const factoryLogs = logs.filter((log) => {
      let isMatched = false;

      for (const filter of factories) {
        if (isLogFactoryMatched({ filter, log })) {
          if (factoryLogsPerBlock.has(block.hash) === false) {
            factoryLogsPerBlock.set(block.hash, []);
          }

          factoryLogsPerBlock.get(block.hash)!.push(log);

          isMatched = true;
        }
      }

      return isMatched;
    });

    const requiredTransactions = new Set<Hash>();
    const requiredTransactionReceipts = new Set<Hash>();

    // Remove logs that don't match a filter, recording required transactions
    logs = logs.filter((log) => {
      let isMatched = false;

      for (const filter of logFilters) {
        if (isLogFilterMatched({ filter, block, log })) {
          // TODO: includeTransactionReceipt
          // return early if includeTransactionReceipt, otherwise continue checking filters
          requiredTransactions.add(log.transactionHash);
          isMatched = true;
        }
      }

      return isMatched;
    });

    // Initial weak trace filtering before full filtering with factory addresses in handleBlock
    traces = traces.filter((trace) => {
      let isMatched = false;
      for (const filter of transferFilters) {
        if (
          isTransferFilterMatched({
            filter,
            block: { number: block.number },
            trace: trace.trace,
          })
        ) {
          // TODO: includeTransactionReceipt
          // return early if includeTransactionReceipt, otherwise continue checking filters
          requiredTransactions.add(trace.transactionHash);
          isMatched = true;
        }
      }

      for (const filter of traceFilters) {
        if (
          isTraceFilterMatched({
            filter,
            block: { number: block.number },
            trace: trace.trace,
          })
        ) {
          // TODO: includeTransactionReceipt
          // return early if includeTransactionReceipt, otherwise continue checking filters
          requiredTransactions.add(trace.transactionHash);
          isMatched = true;
        }
      }

      return isMatched;
    });

    ////////
    // Transactions
    ////////

    const transactions = block.transactions.filter((transaction) => {
      let isMatched = requiredTransactions.has(transaction.hash);
      for (const filter of transactionFilters) {
        if (isTransactionFilterMatched({ filter, block, transaction })) {
          if (filter.includeReverted === false) {
            // or TODO: includeTransactionReceipt
            requiredTransactionReceipts.add(transaction.hash);
            return true;
          }
          isMatched = true;
        }
      }
      return isMatched;
    });

    // Validate that filtered logs/callTraces point to valid transaction in the block
    const blockTransactionsHashes = new Set(
      block.transactions.map((t) => t.hash),
    );
    for (const hash of Array.from(requiredTransactions)) {
      if (blockTransactionsHashes.has(hash) === false) {
        throw new Error(
          `Detected inconsistent RPC responses. Transaction with hash ${hash} is missing in \`block.transactions\`.`,
        );
      }
    }

    ////////
    // Transaction Receipts
    ////////

    const transactionReceipts = await Promise.all(
      block.transactions
        .filter(({ hash }) => requiredTransactionReceipts.has(hash))
        .map(({ hash }) =>
          _eth_getTransactionReceipt(args.requestQueue, { hash }),
        ),
    );

    return {
      block,
      logs,
      factoryLogs,
      traces,
      transactions,
      transactionReceipts,
    };
  };

  const getLatestUnfinalizedBlock = () => {
    if (unfinalizedBlocks.length === 0) {
      return finalizedBlock;
    } else return unfinalizedBlocks[unfinalizedBlocks.length - 1]!;
  };

  return {
    start(startArgs) {
      finalizedBlock = startArgs.syncProgress.finalized;
      finalizedChildAddresses = startArgs.initialChildAddresses;
      /**
       * The queue reacts to a new block. The four states are:
       * 1) Block is the same as the one just processed, no-op.
       * 2) Block is exactly one block ahead of the last processed,
       *    handle this new block (happy path).
       * 3) Block is more than one ahead of the last processed,
       *    fetch all intermediate blocks and enqueue them again.
       * 4) Block is behind the last processed. This is a sign that
       *    a reorg has occurred.
       */
      queue = createQueue({
        browser: false,
        concurrency: 1,
        initialStart: true,
        worker: async ({ block, ...rest }) => {
          const latestBlock = getLatestUnfinalizedBlock();

          // We already saw and handled this block. No-op.
          if (latestBlock.hash === block.hash) {
            args.common.logger.trace({
              service: "realtime",
              msg: `Skipped processing '${args.network.name}' block ${hexToNumber(block.number)}, already synced`,
            });

            return;
          }

          try {
            // Quickly check for a reorg by comparing block numbers. If the block
            // number has not increased, a reorg must have occurred.
            if (hexToNumber(latestBlock.number) >= hexToNumber(block.number)) {
              await handleReorg(block);

              queue.clear();
              return;
            }

            // Blocks are missing. They should be fetched and enqueued.
            if (
              hexToNumber(latestBlock.number) + 1 <
              hexToNumber(block.number)
            ) {
              // Retrieve missing blocks, but only fetch a certain amount.
              const missingBlockRange = range(
                hexToNumber(latestBlock.number) + 1,
                Math.min(
                  hexToNumber(block.number),
                  hexToNumber(latestBlock.number) + MAX_QUEUED_BLOCKS,
                ),
              );
              const pendingBlocks = await Promise.all(
                missingBlockRange.map((blockNumber) =>
                  _eth_getBlockByNumber(args.requestQueue, {
                    blockNumber,
                  }).then((block) => fetchBlockEventData(block)),
                ),
              );

              args.common.logger.debug({
                service: "realtime",
                msg: `Fetched ${missingBlockRange.length} missing '${
                  args.network.name
                }' blocks from ${hexToNumber(latestBlock.number) + 1} to ${Math.min(
                  hexToNumber(block.number),
                  hexToNumber(latestBlock.number) + MAX_QUEUED_BLOCKS,
                )}`,
              });

              // This is needed to ensure proper `kill()` behavior. When the service
              // is killed, nothing should be added to the queue, or else `onIdle()`
              // will never resolve.
              if (isKilled) return;

              queue.clear();

              for (const pendingBlock of pendingBlocks) {
                queue.add(pendingBlock);
              }

              queue.add({ block, ...rest });

              return;
            }

            // Check if a reorg occurred by validating the chain of block hashes.
            if (block.parentHash !== latestBlock.hash) {
              await handleReorg(block);
              queue.clear();
              return;
            }

            // New block is exactly one block ahead of the local chain.
            // Attempt to ingest it.
            await handleBlock({ block, ...rest });

            // Reset the error state after successfully completing the happy path.
            consecutiveErrors = 0;

            return;
          } catch (_error) {
            if (isKilled) return;

            const error = _error as Error;
            error.stack = undefined;

            args.common.logger.warn({
              service: "realtime",
              msg: `Failed to process '${args.network.name}' block ${hexToNumber(block.number)}`,
              error,
            });

            const duration = ERROR_TIMEOUT[consecutiveErrors]!;

            args.common.logger.warn({
              service: "realtime",
              msg: `Retrying '${args.network.name}' sync after ${duration} ${
                duration === 1 ? "second" : "seconds"
              }.`,
            });

            await wait(duration * 1_000);

            // Remove all blocks from the queue. This protects against an
            // erroneous block causing a fatal error.
            queue.clear();

            // After a certain number of attempts, emit a fatal error.
            if (++consecutiveErrors === ERROR_TIMEOUT.length) {
              args.common.logger.error({
                service: "realtime",
                msg: `Fatal error: Unable to process '${args.network.name}' block ${hexToNumber(block.number)} after ${ERROR_TIMEOUT.length} attempts.`,
                error,
              });

              args.onFatalError(error);
            }
          }
        },
      });

      const enqueue = async () => {
        try {
          const block = await _eth_getBlockByNumber(args.requestQueue, {
            blockTag: "latest",
          });

          const latestBlock = getLatestUnfinalizedBlock();

          // We already saw and handled this block. No-op.
          if (latestBlock.hash === block.hash) {
            args.common.logger.trace({
              service: "realtime",
              msg: `Skipped processing '${args.network.name}' block ${hexToNumber(block.number)}, already synced`,
            });

            return;
          }

          const blockWithEventData = await fetchBlockEventData(block);

          consecutiveErrors = 0;

          return queue.add(blockWithEventData);
        } catch (_error) {
          if (isKilled) return;

          const error = _error as Error;

          args.common.logger.warn({
            service: "realtime",
            msg: `Failed to fetch latest '${args.network.name}' block`,
            error,
          });

          // After a certain number of attempts, emit a fatal error.
          if (++consecutiveErrors === ERROR_TIMEOUT.length) {
            args.common.logger.error({
              service: "realtime",
              msg: `Fatal error: Unable to fetch latest '${args.network.name}' block after ${ERROR_TIMEOUT.length} attempts.`,
              error,
            });

            args.onFatalError(error);
          }
        }
      };

      interval = setInterval(enqueue, args.network.pollingInterval);

      // Note: this is done just for testing.
      return enqueue().then(() => queue);
    },
    async kill() {
      clearInterval(interval);
      isKilled = true;
      queue?.pause();
      queue?.clear();
      await queue?.onIdle();
    },
    get unfinalizedBlocks() {
      return unfinalizedBlocks;
    },
    get finalizedChildAddresses() {
      return finalizedChildAddresses;
    },
    get unfinalizedChildAddresses() {
      return unfinalizedChildAddresses;
    },
  };
};
