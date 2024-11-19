import type { Common } from "@/common/common.js";
import {
  isBlockFilterMatched,
  isLogFilterMatched,
  isTraceFilterMatched,
  isTransactionFilterMatched,
  isTransferFilterMatched,
} from "@/sync-realtime/filter.js";
import type { BlockWithEventData } from "@/sync-realtime/index.js";
import type {
  Block,
  Log,
  Trace,
  Transaction,
  TransactionReceipt,
  Transfer,
} from "@/types/eth.js";
import type {
  SyncBlock,
  SyncLog,
  SyncTrace,
  SyncTransaction,
  SyncTransactionReceipt,
} from "@/types/sync.js";
import {
  EVENT_TYPES,
  encodeCheckpoint,
  maxCheckpoint,
  zeroCheckpoint,
} from "@/utils/checkpoint.js";
import { never } from "@/utils/never.js";
import { startClock } from "@/utils/timer.js";
import type { AbiEvent, AbiParameter } from "abitype";
import {
  type Address,
  DecodeLogDataMismatch,
  DecodeLogTopicsMismatch,
  type Hash,
  type Hex,
  checksumAddress,
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  hexToBigInt,
  hexToNumber,
} from "viem";
import {
  type BlockFilter,
  type Factory,
  type Source,
  isAddressFactory,
} from "./source.js";

export type RawEvent = {
  chainId: number;
  sourceIndex: number;
  checkpoint: string;
  log?: Log;
  block: Block;
  transaction?: Transaction;
  transactionReceipt?: TransactionReceipt;
  trace?: Trace;
};

export type Event =
  | LogEvent
  | BlockEvent
  | TransactionEvent
  | TransferEvent
  | TraceEvent;

export type SetupEvent = {
  type: "setup";
  chainId: number;
  checkpoint: string;

  /** `${source.name}:setup` */
  name: string;

  block: bigint;
};

export type LogEvent = {
  type: "log";
  chainId: number;
  checkpoint: string;

  /** `${source.name}:${safeName}` */
  name: string;

  event: {
    name: string;
    args: any;
    log: Log;
    block: Block;
    transaction: Transaction;
    transactionReceipt?: TransactionReceipt;
  };
};

export type BlockEvent = {
  type: "block";
  chainId: number;
  checkpoint: string;

  /** `${source.name}:block` */
  name: string;

  event: {
    block: Block;
  };
};

export type TransactionEvent = {
  type: "transaction";
  chainId: number;
  checkpoint: string;

  /** `${source.name}.{safeName}()` */
  name: string;

  event: {
    block: Block;
    transaction: Transaction;
    transactionReceipt?: TransactionReceipt;
  };
};

export type TransferEvent = {
  type: "transfer";
  chainId: number;
  checkpoint: string;

  /** `${source.name}:transfer:from` | `${source.name}:transfer:to` */
  name: string;

  event: {
    transfer: Transfer;
    block: Block;
    transaction: Transaction;
    transactionReceipt?: TransactionReceipt;
    trace: Trace;
  };
};

export type TraceEvent = {
  type: "trace";
  chainId: number;
  checkpoint: string;

  /** `${source.name}:transfer:from` | `${source.name}:transfer:to` */
  name: string;

  event: {
    args: any;
    result: any;
    trace: Trace;
    block: Block;
    transaction: Transaction;
    transactionReceipt?: TransactionReceipt;
  };
};

/**
 * Create `RawEvent`s from raw data types
 */
export const buildEvents = ({
  sources,
  blockWithEventData: {
    block,
    logs,
    transactions,
    transactionReceipts,
    traces,
  },
  finalizedChildAddresses,
  unfinalizedChildAddresses,
  chainId,
}: {
  sources: Source[];
  blockWithEventData: Omit<BlockWithEventData, "filters" | "factoryLogs">;
  finalizedChildAddresses: Map<Factory, Set<Address>>;
  unfinalizedChildAddresses: Map<Factory, Set<Address>>;
  chainId: number;
}) => {
  const events: RawEvent[] = [];

  const transactionCache = new Map<Hash, SyncTransaction>();
  const transactionReceiptCache = new Map<Hash, SyncTransactionReceipt>();
  for (const transaction of transactions) {
    transactionCache.set(transaction.hash, transaction);
  }
  for (const transactionReceipt of transactionReceipts) {
    transactionReceiptCache.set(
      transactionReceipt.transactionHash,
      transactionReceipt,
    );
  }

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    const filter = source.filter;
    if (chainId !== filter.chainId) continue;
    switch (source.type) {
      case "contract": {
        switch (filter.type) {
          case "log": {
            for (const log of logs) {
              if (
                isLogFilterMatched({ filter, block, log }) &&
                (isAddressFactory(filter.address)
                  ? finalizedChildAddresses
                      .get(filter.address)!
                      .has(log.address) ||
                    unfinalizedChildAddresses
                      .get(filter.address)!
                      .has(log.address)
                  : true)
              ) {
                events.push({
                  chainId: filter.chainId,
                  sourceIndex: i,
                  checkpoint: encodeCheckpoint({
                    blockTimestamp: hexToNumber(block.timestamp),
                    chainId: BigInt(filter.chainId),
                    blockNumber: hexToBigInt(log.blockNumber),
                    transactionIndex: hexToBigInt(log.transactionIndex),
                    eventType: EVENT_TYPES.logs,
                    eventIndex: hexToBigInt(log.logIndex),
                  }),
                  log: convertLog(log),
                  block: convertBlock(block),
                  transaction: convertTransaction(
                    transactionCache.get(log.transactionHash)!,
                  ),
                  transactionReceipt: undefined,
                  trace: undefined,
                });
              }
            }
            break;
          }

          case "trace": {
            for (const trace of traces) {
              if (
                isTraceFilterMatched({
                  filter,
                  block,
                  trace: trace.trace,
                })
              ) {
                // TODO: filter on factory

                const transaction = transactionCache.get(
                  trace.transactionHash,
                )!;
                events.push({
                  chainId: filter.chainId,
                  sourceIndex: i,
                  checkpoint: encodeCheckpoint({
                    blockTimestamp: hexToNumber(block.timestamp),
                    chainId: BigInt(filter.chainId),
                    blockNumber: hexToBigInt(block.number),
                    transactionIndex: BigInt(transaction.transactionIndex),
                    eventType: EVENT_TYPES.traces,
                    eventIndex: BigInt(trace.position),
                  }),
                  log: undefined,
                  trace: convertTrace(trace),
                  block: convertBlock(block),
                  transaction: convertTransaction(transaction),
                  transactionReceipt: undefined,
                });
              }
            }
            break;
          }
        }
        break;
      }

      case "account": {
        switch (filter.type) {
          case "transaction": {
            for (const transaction of transactions) {
              if (
                isTransactionFilterMatched({
                  filter,
                  block,
                  transaction,
                })
              ) {
                // TODO: filter on factory

                events.push({
                  chainId: filter.chainId,
                  sourceIndex: i,
                  checkpoint: encodeCheckpoint({
                    blockTimestamp: hexToNumber(block.timestamp),
                    chainId: BigInt(filter.chainId),
                    blockNumber: hexToBigInt(block.number),
                    transactionIndex: BigInt(transaction.transactionIndex),
                    eventType: EVENT_TYPES.transactions,
                    eventIndex: 0n,
                  }),
                  log: undefined,
                  trace: undefined,
                  block: convertBlock(block),
                  transaction: convertTransaction(transaction),
                  transactionReceipt: undefined,
                });
              }
            }
            break;
          }

          case "transfer": {
            for (const trace of traces) {
              if (
                isTransferFilterMatched({ filter, block, trace: trace.trace })
              ) {
                // TODO: filter on factory

                const transaction = transactionCache.get(
                  trace.transactionHash,
                )!;
                events.push({
                  chainId: filter.chainId,
                  sourceIndex: i,
                  checkpoint: encodeCheckpoint({
                    blockTimestamp: hexToNumber(block.timestamp),
                    chainId: BigInt(filter.chainId),
                    blockNumber: hexToBigInt(block.number),
                    transactionIndex: BigInt(transaction.transactionIndex),
                    eventType: EVENT_TYPES.traces,
                    eventIndex: BigInt(trace.position),
                  }),
                  log: undefined,
                  trace: convertTrace(trace),
                  block: convertBlock(block),
                  transaction: convertTransaction(transaction),
                  transactionReceipt: undefined,
                });
              }
            }
            break;
          }
        }
        break;
      }

      case "block": {
        if (isBlockFilterMatched({ filter: filter as BlockFilter, block })) {
          events.push({
            chainId: filter.chainId,
            sourceIndex: i,
            checkpoint: encodeCheckpoint({
              blockTimestamp: hexToNumber(block.timestamp),
              chainId: BigInt(filter.chainId),
              blockNumber: hexToBigInt(block.number),
              transactionIndex: maxCheckpoint.transactionIndex,
              eventType: EVENT_TYPES.blocks,
              eventIndex: zeroCheckpoint.eventIndex,
            }),
            block: convertBlock(block),
            log: undefined,
            trace: undefined,
            transaction: undefined,
            transactionReceipt: undefined,
          });
        }
        break;
      }
      default:
        never(source);
    }
  }

  return events.sort((a, b) => (a.checkpoint < b.checkpoint ? -1 : 1));
};

export const decodeEvents = (
  common: Common,
  sources: Source[],
  rawEvents: RawEvent[],
): Event[] => {
  const events: Event[] = [];

  const endClock = startClock();

  for (const event of rawEvents) {
    const source = sources[event.sourceIndex]!;

    switch (source.type) {
      case "contract": {
        switch (source.filter.type) {
          case "log": {
            try {
              if (
                event.log!.topics[0] === undefined ||
                source.abiEvents.bySelector[event.log!.topics[0]] === undefined
              ) {
                throw new Error();
              }

              const { safeName, item } =
                source.abiEvents.bySelector[event.log!.topics[0]]!;

              const args = decodeEventLog({
                abiItem: item,
                data: event.log!.data,
                topics: event.log!.topics,
              });

              events.push({
                type: "log",
                chainId: event.chainId,
                checkpoint: event.checkpoint,

                name: `${source.name}:${safeName}`,

                event: {
                  name: safeName,
                  args,
                  log: event.log!,
                  block: event.block,
                  transaction: event.transaction!,
                  transactionReceipt: event.transactionReceipt,
                },
              });
            } catch (err) {
              if (source.filter.address === undefined) {
                common.logger.debug({
                  service: "app",
                  msg: `Unable to decode log, skipping it. id: ${event.log?.id}, data: ${event.log?.data}, topics: ${event.log?.topics}`,
                });
              } else {
                common.logger.warn({
                  service: "app",
                  msg: `Unable to decode log, skipping it. id: ${event.log?.id}, data: ${event.log?.data}, topics: ${event.log?.topics}`,
                });
              }
            }
            break;
          }

          case "trace": {
            try {
              const selector = event
                .trace!.input.slice(0, 10)
                .toLowerCase() as Hex;

              if (source.abiFunctions.bySelector[selector] === undefined) {
                throw new Error();
              }

              const { item, safeName } =
                source.abiFunctions.bySelector[selector]!;

              const { args, functionName } = decodeFunctionData({
                abi: [item],
                data: event.trace!.input,
              });

              const result = decodeFunctionResult({
                abi: [item],
                data: event.trace!.output!,
                functionName,
              });

              events.push({
                type: "trace",
                chainId: event.chainId,
                checkpoint: event.checkpoint,

                // TODO(kyle) "()"
                name: `${source.name}.${safeName}`,

                event: {
                  args,
                  result,
                  trace: event.trace!,
                  block: event.block,
                  transaction: event.transaction!,
                  transactionReceipt: event.transactionReceipt,
                },
              });
            } catch (err) {
              if (source.filter.toAddress === undefined) {
                common.logger.debug({
                  service: "app",
                  msg: `Unable to decode trace, skipping it. id: ${event.trace?.id}, input: ${event.trace?.input}, output: ${event.trace?.output}`,
                });
              } else {
                common.logger.warn({
                  service: "app",
                  msg: `Unable to decode trace, skipping it. id: ${event.trace?.id}, input: ${event.trace?.input}, output: ${event.trace?.output}`,
                });
              }
            }
            break;
          }

          default:
            never(source.filter);
        }
        break;
      }

      case "account": {
        switch (source.filter.type) {
          case "transaction": {
            // TODO(kyle) what if toAddress and fromAddress are both undefined?
            const isFrom = source.filter.toAddress === undefined;

            events.push({
              type: "transaction",
              chainId: event.chainId,
              checkpoint: event.checkpoint,

              name: `${source.name}:transaction:${isFrom ? "from" : "to"}`,

              event: {
                block: event.block,
                transaction: event.transaction!,
                transactionReceipt: event.transactionReceipt,
              },
            });

            break;
          }

          case "transfer": {
            const isFrom = source.filter.toAddress === undefined;

            events.push({
              type: "transfer",
              chainId: event.chainId,
              checkpoint: event.checkpoint,

              name: `${source.name}:transfer:${isFrom ? "from" : "to"}`,

              event: {
                transfer: {
                  from: event.trace!.from,
                  to: event.trace!.to!,
                  value: event.trace!.value!,
                },
                block: event.block,
                transaction: event.transaction!,
                transactionReceipt: event.transactionReceipt,
                trace: event.trace!,
              },
            });

            break;
          }
        }
        break;
      }

      case "block": {
        events.push({
          type: "block",
          chainId: event.chainId,
          checkpoint: event.checkpoint,
          name: `${source.name}:block`,
          event: {
            block: event.block,
          },
        });
        break;
      }

      default:
        never(source);
    }
  }

  common.metrics.ponder_indexing_abi_decoding_duration.observe(endClock());

  return events;
};

/** @see https://github.com/wevm/viem/blob/main/src/utils/abi/decodeEventLog.ts#L99 */
function decodeEventLog({
  abiItem,
  topics,
  data,
}: {
  abiItem: AbiEvent;
  topics: [signature: Hex, ...args: Hex[]] | [];
  data: Hex;
}): any {
  const { inputs } = abiItem;
  const isUnnamed = inputs?.some((x) => !("name" in x && x.name));

  let args: any = isUnnamed ? [] : {};

  const [, ...argTopics] = topics;

  // Decode topics (indexed args).
  const indexedInputs = inputs.filter((x) => "indexed" in x && x.indexed);
  for (let i = 0; i < indexedInputs.length; i++) {
    const param = indexedInputs[i]!;
    const topic = argTopics[i];
    if (!topic)
      throw new DecodeLogTopicsMismatch({
        abiItem,
        param: param as AbiParameter & { indexed: boolean },
      });
    args[isUnnamed ? i : param.name || i] = decodeTopic({
      param,
      value: topic,
    });
  }

  // Decode data (non-indexed args).
  const nonIndexedInputs = inputs.filter((x) => !("indexed" in x && x.indexed));
  if (nonIndexedInputs.length > 0) {
    if (data && data !== "0x") {
      const decodedData = decodeAbiParameters(nonIndexedInputs, data);
      if (decodedData) {
        if (isUnnamed) args = [...args, ...decodedData];
        else {
          for (let i = 0; i < nonIndexedInputs.length; i++) {
            args[nonIndexedInputs[i]!.name!] = decodedData[i];
          }
        }
      }
    } else {
      throw new DecodeLogDataMismatch({
        abiItem,
        data: "0x",
        params: nonIndexedInputs,
        size: 0,
      });
    }
  }

  return Object.values(args).length > 0 ? args : undefined;
}

function decodeTopic({ param, value }: { param: AbiParameter; value: Hex }) {
  if (
    param.type === "string" ||
    param.type === "bytes" ||
    param.type === "tuple" ||
    param.type.match(/^(.*)\[(\d+)?\]$/)
  )
    return value;
  const decodedArg = decodeAbiParameters([param], value) || [];
  return decodedArg[0];
}

const convertBlock = (block: SyncBlock): Block => ({
  baseFeePerGas: block.baseFeePerGas ? hexToBigInt(block.baseFeePerGas) : null,
  difficulty: hexToBigInt(block.difficulty),
  extraData: block.extraData,
  gasLimit: hexToBigInt(block.gasLimit),
  gasUsed: hexToBigInt(block.gasUsed),
  hash: block.hash,
  logsBloom: block.logsBloom,
  miner: checksumAddress(block.miner),
  mixHash: block.mixHash,
  nonce: block.nonce,
  number: hexToBigInt(block.number),
  parentHash: block.parentHash,
  receiptsRoot: block.receiptsRoot,
  sha3Uncles: block.sha3Uncles,
  size: hexToBigInt(block.size),
  stateRoot: block.stateRoot,
  timestamp: hexToBigInt(block.timestamp),
  totalDifficulty: block.totalDifficulty
    ? hexToBigInt(block.totalDifficulty)
    : null,
  transactionsRoot: block.transactionsRoot,
});

const convertLog = (log: SyncLog): Log => ({
  id: `${log.blockHash}-${log.logIndex}`,
  address: checksumAddress(log.address!),
  blockHash: log.blockHash,
  blockNumber: hexToBigInt(log.blockNumber),
  data: log.data,
  logIndex: Number(log.logIndex),
  removed: false,
  topics: log.topics,
  transactionHash: log.transactionHash,
  transactionIndex: Number(log.transactionIndex),
});

const convertTransaction = (transaction: SyncTransaction): Transaction => ({
  blockHash: transaction.blockHash,
  blockNumber: hexToBigInt(transaction.blockNumber),
  from: checksumAddress(transaction.from),
  gas: hexToBigInt(transaction.gas),
  hash: transaction.hash,
  input: transaction.input,
  nonce: Number(transaction.nonce),
  r: transaction.r,
  s: transaction.s,
  to: transaction.to ? checksumAddress(transaction.to) : transaction.to,
  transactionIndex: Number(transaction.transactionIndex),
  value: hexToBigInt(transaction.value),
  v: transaction.v ? hexToBigInt(transaction.v) : null,
  ...(transaction.type === "0x0"
    ? {
        type: "legacy",
        gasPrice: hexToBigInt(transaction.gasPrice),
      }
    : transaction.type === "0x1"
      ? {
          type: "eip2930",
          gasPrice: hexToBigInt(transaction.gasPrice),
          accessList: transaction.accessList,
        }
      : transaction.type === "0x2"
        ? {
            type: "eip1559",
            maxFeePerGas: hexToBigInt(transaction.maxFeePerGas),
            maxPriorityFeePerGas: hexToBigInt(transaction.maxPriorityFeePerGas),
          }
        : // @ts-ignore
          transaction.type === "0x7e"
          ? {
              type: "deposit",
              // @ts-ignore
              maxFeePerGas: transaction.maxFeePerGas
                ? // @ts-ignore
                  hexToBigInt(transaction.maxFeePerGas)
                : undefined,
              // @ts-ignore
              maxPriorityFeePerGas: transaction.maxPriorityFeePerGas
                ? // @ts-ignore
                  hexToBigInt(transaction.maxPriorityFeePerGas)
                : undefined,
            }
          : {
              // @ts-ignore
              type: transaction.type,
            }),
});

const convertTransactionReceipt = (
  transactionReceipt: SyncTransactionReceipt,
): TransactionReceipt => ({
  blockHash: transactionReceipt.blockHash,
  blockNumber: hexToBigInt(transactionReceipt.blockNumber),
  contractAddress: transactionReceipt.contractAddress
    ? checksumAddress(transactionReceipt.contractAddress)
    : null,
  cumulativeGasUsed: hexToBigInt(transactionReceipt.cumulativeGasUsed),
  effectiveGasPrice: hexToBigInt(transactionReceipt.effectiveGasPrice),
  from: checksumAddress(transactionReceipt.from),
  gasUsed: hexToBigInt(transactionReceipt.gasUsed),
  logs: transactionReceipt.logs.map((log) => ({
    id: `${log.blockHash}-${log.logIndex}`,
    address: checksumAddress(log.address),
    blockHash: log.blockHash!,
    blockNumber: hexToBigInt(log.blockNumber!),
    data: log.data,
    logIndex: hexToNumber(log.logIndex!),
    removed: false,
    topics: [
      log.topics[0] ?? null,
      log.topics[1] ?? null,
      log.topics[2] ?? null,
      log.topics[3] ?? null,
    ].filter((t): t is Hex => t !== null) as [Hex, ...Hex[]] | [],
    transactionHash: log.transactionHash!,
    transactionIndex: hexToNumber(log.transactionIndex!),
  })),
  logsBloom: transactionReceipt.logsBloom,
  status:
    transactionReceipt.status === "0x1"
      ? "success"
      : transactionReceipt.status === "0x0"
        ? "reverted"
        : (transactionReceipt.status as TransactionReceipt["status"]),
  to: transactionReceipt.to ? checksumAddress(transactionReceipt.to) : null,
  transactionHash: transactionReceipt.transactionHash,
  transactionIndex: Number(transactionReceipt.transactionIndex),
  type:
    transactionReceipt.type === "0x0"
      ? "legacy"
      : transactionReceipt.type === "0x1"
        ? "eip2930"
        : transactionReceipt.type === "0x2"
          ? "eip1559"
          : transactionReceipt.type === "0x7e"
            ? "deposit"
            : transactionReceipt.type,
});

const convertTrace = (trace: SyncTrace): Trace => ({
  id: `${trace.transactionHash}-${trace.position}`,
  type: trace.trace.type,
  from: checksumAddress(trace.trace.from),
  to: trace.trace.to ? checksumAddress(trace.trace.to) : null,
  input: trace.trace.input,
  output: trace.trace.output,
  gas: hexToBigInt(trace.trace.gas),
  gasUsed: hexToBigInt(trace.trace.gasUsed),
  value: trace.trace.value ? hexToBigInt(trace.trace.value) : null,
});
